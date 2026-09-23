import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	AuthoringEvidence,
	AuthoringSummary,
	HydroAgentAttachment,
	HydroAgentExecutionOutcome,
	HydroAgentExecutor,
	HydroAgentMetrics,
	HydroAgentModelSettings,
	HydroAgentPhase,
	HydroAgentProgressEvent,
	HydroConversationMessage,
	HydroReferenceProgram,
	HydroSandboxReport,
} from "@hydro-problem-make/agent";
import { isSafeFlatName, type ValidationReport } from "@hydro-problem-make/authoring";
import type { HydroLiveVerificationRequest, HydroLiveVerificationResult } from "./live-hydro.ts";

export type HydroRunStatus = "queued" | "running" | "needs_input" | "succeeded" | "failed" | "cancelled";

export interface HydroRunArtifact {
	slug: string;
	report: ValidationReport;
	verification?: HydroSandboxReport;
	authoring?: AuthoringSummary;
	liveVerification?: HydroLiveVerificationResult;
}

export interface HydroRunListItem {
	id: string;
	status: HydroRunStatus;
	title: string;
	sourcePreview: string;
	createdAt: string;
	updatedAt: string;
	model?: string;
	modelSettings?: HydroAgentModelSettings;
	judgingType?: "default" | "interactive" | "submit_answer";
	artifact?: HydroRunArtifact;
	phase?: HydroAgentPhase;
	phaseMessage?: string;
	phaseStartedAt?: string;
	lastEventSequence: number;
	metrics?: HydroAgentMetrics;
}

export interface HydroRunSnapshot extends HydroRunListItem {
	source: string;
	assistantText: string;
	error?: string;
	conversation: HydroConversationMessage[];
	referenceProgram?: HydroReferenceProgram;
	attachments: HydroAgentAttachment[];
}

export interface HydroRunEvent {
	sequence: number;
	runId: string;
	type: "status" | "text_delta" | "tool" | "phase" | "metrics" | "judging_type";
	createdAt: string;
	message: string;
	status?: HydroRunStatus;
	phase?: HydroAgentPhase;
	metrics?: HydroAgentMetrics;
	judgingType?: "default" | "interactive" | "submit_answer";
}

interface MutableRun extends HydroRunSnapshot {
	artifactDirectory?: string;
	events: HydroRunEvent[];
	eventSequence: number;
	listeners: Set<(event: HydroRunEvent) => void>;
	abortController?: AbortController;
	deleting?: boolean;
}

interface PersistedRun extends HydroRunSnapshot {
	events: HydroRunEvent[];
}

function isTerminal(status: HydroRunStatus): boolean {
	return status === "needs_input" || status === "succeeded" || status === "failed" || status === "cancelled";
}

function inferTitle(source: string): string {
	const statementTitle = source
		.split("## 用户提供的题面")[1]
		?.match(/^#\s+(.+)$/mu)?.[1]
		?.trim();
	if (statementTitle) return statementTitle.slice(0, 120);
	const heading = source.match(/^\s*#\s+(.+)$/m)?.[1]?.trim();
	return (heading || source.split("\n", 1)[0]?.trim() || "未命名题目").slice(0, 120);
}

function makeSourcePreview(source: string): string {
	return source.replace(/\s+/g, " ").trim().slice(0, 240);
}

function compactAuthoringSummary(summary: AuthoringSummary | undefined): AuthoringSummary | undefined {
	if (!summary) return undefined;
	return {
		verificationId: summary.verificationId,
		revision: summary.revision,
		type: summary.type,
		success: summary.success,
		testCases: summary.testCases,
		generatedCases: summary.generatedCases,
		oracleCases: summary.oracleCases,
		validatorNegativeCases: summary.validatorNegativeCases,
		checker: summary.checker,
		checkerProbes: summary.checkerProbes,
		wrongPrograms: summary.wrongPrograms,
	};
}

function normalizeArtifact(artifact: HydroRunArtifact | undefined): HydroRunArtifact | undefined {
	return artifact ? { ...artifact, authoring: compactAuthoringSummary(artifact.authoring) } : undefined;
}

function listItem(run: MutableRun): HydroRunListItem {
	return {
		id: run.id,
		status: run.status,
		title: run.title,
		sourcePreview: run.sourcePreview,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		model: run.model,
		modelSettings: run.modelSettings,
		judgingType: run.judgingType,
		artifact: run.artifact
			? {
					slug: run.artifact.slug,
					report: run.artifact.report,
					authoring: compactAuthoringSummary(run.artifact.authoring),
					liveVerification: run.artifact.liveVerification,
				}
			: undefined,
		phase: run.phase,
		phaseMessage: run.phaseMessage,
		phaseStartedAt: run.phaseStartedAt,
		lastEventSequence: run.eventSequence,
		metrics: run.metrics,
	};
}

function snapshot(run: MutableRun): HydroRunSnapshot {
	return {
		...listItem(run),
		artifact: run.artifact,
		source: run.source,
		assistantText: run.assistantText,
		error: run.error,
		conversation: run.conversation,
		referenceProgram: run.referenceProgram,
		attachments: run.attachments,
	};
}

function compactEvents(events: readonly HydroRunEvent[]): HydroRunEvent[] {
	const compact: HydroRunEvent[] = [];
	for (const event of events) {
		if (event.type === "text_delta") continue;
		const previous = compact.at(-1);
		if (previous?.type === event.type && previous.message === event.message && previous.status === event.status)
			compact[compact.length - 1] = event;
		else compact.push(event);
	}
	return compact.length <= 200 ? compact : compact.slice(-200);
}

export class HydroRunManager {
	private readonly executor: HydroAgentExecutor;
	private readonly runs = new Map<string, MutableRun>();
	private readonly queue: string[] = [];
	private activeRuns = 0;
	private readonly maxConcurrentRuns: number;
	private readonly storagePath?: string;

	constructor(executor: HydroAgentExecutor, storagePath?: string, maxConcurrentRuns = 2) {
		if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 8)
			throw new Error("maxConcurrentRuns must be an integer from 1 to 8.");
		this.executor = executor;
		this.storagePath = storagePath;
		this.maxConcurrentRuns = maxConcurrentRuns;
		if (storagePath) this.restore(storagePath);
	}

	create(
		source: string,
		referenceProgram?: HydroReferenceProgram,
		attachments: HydroAgentAttachment[] = [],
	): HydroRunSnapshot {
		const normalizedSource = source.trim();
		if (normalizedSource.length === 0) throw new Error("Problem source cannot be empty.");
		if (normalizedSource.length > 200_000) throw new Error("Problem source exceeds 200000 characters.");
		const timestamp = new Date().toISOString();
		const run: MutableRun = {
			id: randomUUID(),
			status: "queued",
			title: inferTitle(normalizedSource),
			sourcePreview: makeSourcePreview(normalizedSource),
			source: normalizedSource,
			createdAt: timestamp,
			updatedAt: timestamp,
			assistantText: "",
			conversation: [],
			referenceProgram,
			attachments,
			lastEventSequence: 0,
			metrics: undefined,
			eventSequence: 0,
			events: [],
			listeners: new Set(),
		};
		this.runs.set(run.id, run);
		this.queue.push(run.id);
		this.emit(run, { type: "status", message: "任务已进入队列。", status: "queued" });
		this.persist(run);
		void this.drain();
		return snapshot(run);
	}

	continue(
		runId: string,
		input: {
			message: string;
			referenceProgram?: HydroReferenceProgram | null;
			attachments?: HydroAgentAttachment[] | null;
		},
	): HydroRunSnapshot {
		return this.resume(runId, input.message, input.referenceProgram, input.attachments);
	}

	retry(runId: string): HydroRunSnapshot {
		return this.resume(runId);
	}

	private resume(
		runId: string,
		message?: string,
		referenceProgram?: HydroReferenceProgram | null,
		attachments?: HydroAgentAttachment[] | null,
	): HydroRunSnapshot {
		const run = this.runs.get(runId);
		if (run === undefined) throw new Error("任务不存在。");
		if (!["needs_input", "failed", "cancelled"].includes(run.status) || run.abortController || run.deleting)
			throw new Error("当前任务尚未结束或已经完成，不能继续。");
		const normalizedMessage = message?.trim();
		if (message !== undefined && (!normalizedMessage || normalizedMessage.length > 200_000))
			throw new Error("补充信息须为 1–200000 个字符。");
		if (run.assistantText) run.conversation.push({ role: "assistant", content: run.assistantText });
		if (normalizedMessage) run.conversation.push({ role: "user", content: normalizedMessage });
		if (referenceProgram !== undefined) run.referenceProgram = referenceProgram ?? undefined;
		if (attachments !== undefined) run.attachments = attachments ?? [];
		run.assistantText = "";
		run.metrics = undefined;
		run.error = undefined;
		run.status = "queued";
		run.phase = undefined;
		run.phaseMessage = undefined;
		run.phaseStartedAt = undefined;
		run.updatedAt = new Date().toISOString();
		this.queue.push(run.id);
		this.emit(run, {
			type: "status",
			status: "queued",
			message: normalizedMessage ? "已收到补充信息，继续任务。" : "已从保存草稿继续修复。",
		});
		this.persist(run);
		void this.drain();
		return snapshot(run);
	}

	get(runId: string): HydroRunSnapshot | undefined {
		const run = this.runs.get(runId);
		return run === undefined ? undefined : snapshot(run);
	}

	list(): HydroRunListItem[] {
		return [...this.runs.values()].reverse().map(listItem);
	}

	getReadiness(): HydroAgentExecutor["readiness"] {
		return this.executor.readiness;
	}

	getMaxConcurrentRuns(): number {
		return this.maxConcurrentRuns;
	}

	getEvents(runId: string, afterSequence = 0): HydroRunEvent[] | undefined {
		return this.runs.get(runId)?.events.filter((event) => event.sequence > afterSequence);
	}

	getArtifactDirectory(runId: string): string | undefined {
		return this.runs.get(runId)?.artifactDirectory;
	}

	getAuthoringEvidence(runId: string): AuthoringEvidence | undefined {
		const run = this.runs.get(runId);
		const verificationId = run?.artifact?.authoring?.verificationId;
		if (!run || !verificationId || !this.storagePath || !isSafeFlatName(runId) || !isSafeFlatName(verificationId))
			return undefined;
		try {
			return JSON.parse(
				readFileSync(
					join(dirname(this.storagePath), "artifacts", runId, "authoring", verificationId, "evidence.json"),
					"utf8",
				),
			) as AuthoringEvidence;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	getLiveVerificationRequest(runId: string): HydroLiveVerificationRequest | undefined {
		const run = this.runs.get(runId);
		const evidence = this.getAuthoringEvidence(runId);
		if (!run?.artifact || !run.artifactDirectory || !evidence) return undefined;
		return {
			runId,
			slug: run.artifact.slug,
			packageDirectory: run.artifactDirectory,
			authoringProject: evidence.project,
			answerSubmission:
				evidence.project.type === "submit_answer"
					? {
							mode: evidence.project.answerMode ?? "single",
							correctFiles: evidence.report.cases.map((item) => ({
								name:
									evidence.project.cases.find((entry) => entry.id === item.id)?.submissionFile ?? "answer.txt",
								content: item.output,
							})),
							wrongSubmissions: [
								{
									name: "extra-token-answer",
									files: evidence.report.cases.map((item) => ({
										name:
											evidence.project.cases.find((entry) => entry.id === item.id)?.submissionFile ??
											"answer.txt",
										content: `${item.output}\n__definitely_wrong_extra_token__\n`,
									})),
								},
							],
						}
					: undefined,
		};
	}

	setLiveVerification(runId: string, result: HydroLiveVerificationResult): void {
		const run = this.runs.get(runId);
		if (!run?.artifact) throw new Error("任务尚未生成 Hydro 包。");
		run.artifact = { ...run.artifact, liveVerification: result };
		run.updatedAt = new Date().toISOString();
		this.persist(run);
	}

	async delete(runId: string): Promise<boolean> {
		const run = this.runs.get(runId);
		if (!run) return false;
		if (!isTerminal(run.status) || run.abortController || run.deleting)
			throw new Error("任务仍在运行、退出或删除中，请稍后重试。");
		run.deleting = true;
		try {
			if (this.storagePath) {
				if (!isSafeFlatName(runId)) throw new Error("无效的任务 ID。");
				const root = dirname(this.storagePath);
				await rm(join(root, "artifacts", runId), { recursive: true, force: true });
				await rm(join(root, "sessions", runId), { recursive: true, force: true });
				await rm(join(root, "run-records", `${runId}.json`), { force: true });
			}
			this.runs.delete(runId);
			this.persistIndex();
			return true;
		} finally {
			run.deleting = false;
		}
	}

	subscribe(runId: string, listener: (event: HydroRunEvent) => void): (() => void) | undefined {
		const run = this.runs.get(runId);
		if (run === undefined) return undefined;
		run.listeners.add(listener);
		return () => run.listeners.delete(listener);
	}

	cancel(runId: string): boolean {
		const run = this.runs.get(runId);
		if (run === undefined || isTerminal(run.status)) return false;
		run.abortController?.abort();
		this.transition(run, "cancelled", "任务已取消。");
		return true;
	}

	private emit(run: MutableRun, event: Omit<HydroRunEvent, "sequence" | "runId" | "createdAt">): void {
		run.eventSequence += 1;
		const item: HydroRunEvent = {
			...event,
			sequence: run.eventSequence,
			runId: run.id,
			createdAt: new Date().toISOString(),
		};
		run.events.push(item);
		for (const listener of run.listeners) {
			try {
				listener(item);
			} catch {
				// A disconnected event consumer must not affect the authoring run.
			}
		}
	}

	private transition(run: MutableRun, status: HydroRunStatus, message: string): void {
		if (isTerminal(run.status)) return;
		run.status = status;
		run.updatedAt = new Date().toISOString();
		this.emit(run, { type: "status", message, status });
		if (isTerminal(status)) run.events = compactEvents(run.events);
		this.persist(run);
	}

	private handleProgress(run: MutableRun, event: HydroAgentProgressEvent): void {
		if (run.status !== "running") return;
		if (event.type === "text_delta") {
			run.assistantText += event.delta;
			run.updatedAt = new Date().toISOString();
			this.emit(run, { type: "text_delta", message: event.delta });
			return;
		}
		if (event.type === "phase") {
			if (run.phase !== event.phase) run.phaseStartedAt = new Date().toISOString();
			run.phase = event.phase;
			run.phaseMessage = event.message;
			run.updatedAt = new Date().toISOString();
			this.emit(run, { type: "phase", phase: event.phase, message: event.message });
			this.persist(run);
			return;
		}
		if (event.type === "metrics") {
			run.metrics = event.metrics;
			run.updatedAt = new Date().toISOString();
			this.emit(run, { type: "metrics", message: "任务统计已更新", metrics: event.metrics });
			this.persist(run);
			return;
		}
		if (event.type === "judging_type") {
			run.judgingType = event.judgingType;
			run.updatedAt = new Date().toISOString();
			this.emit(run, { type: "judging_type", message: "已选择判题类型", judgingType: event.judgingType });
			this.persist(run);
			return;
		}
		const message =
			event.type === "tool_started"
				? `开始执行 ${event.toolName}`
				: `${event.toolName} ${event.isError ? "执行失败" : "执行完成"}`;
		this.emit(run, { type: "tool", message });
	}

	private applyOutcome(run: MutableRun, outcome: HydroAgentExecutionOutcome): void {
		run.model = outcome.model;
		if (outcome.modelSettings) run.modelSettings = outcome.modelSettings;
		run.assistantText = outcome.assistantText;
		if (outcome.metrics) run.metrics = outcome.metrics;
		if (outcome.failureReason) run.error = outcome.failureReason;
		if (outcome.artifact !== undefined) {
			run.artifact = {
				slug: outcome.artifact.slug,
				report: outcome.artifact.report,
				verification: outcome.artifact.verification,
				authoring: outcome.artifact.authoring,
			};
			run.artifactDirectory = outcome.artifact.directory;
		}
		if (outcome.status === "succeeded") this.transition(run, "succeeded", "Hydro 题目目录已生成并通过格式检查。");
		else if (outcome.status === "needs_input") this.transition(run, "needs_input", "需要补充题目信息。");
		else this.transition(run, "failed", "Agent 未能生成有效的 Hydro 题目目录。");
	}

	private isCancelled(runId: string): boolean {
		return this.runs.get(runId)?.status === "cancelled";
	}

	private drain(): void {
		while (this.activeRuns < this.maxConcurrentRuns && this.queue.length > 0) {
			const runId = this.queue.shift();
			if (runId === undefined) continue;
			const run = this.runs.get(runId);
			if (run === undefined || run.status !== "queued") continue;
			this.activeRuns += 1;
			void this.executeRun(run);
		}
	}

	private async executeRun(run: MutableRun): Promise<void> {
		const abortController = new AbortController();
		run.abortController = abortController;
		this.transition(run, "running", "Agent 已开始整理题目。");
		try {
			const outcome = await this.executor.execute({
				runId: run.id,
				source: run.source,
				conversation: run.conversation,
				referenceProgram: run.referenceProgram,
				attachments: run.attachments,
				signal: abortController.signal,
				onEvent: (event) => this.handleProgress(run, event),
			});
			if (!this.isCancelled(run.id)) this.applyOutcome(run, outcome);
		} catch (error) {
			if (!this.isCancelled(run.id)) {
				run.error = error instanceof Error ? error.message : "Unknown Agent error.";
				this.transition(run, "failed", "Agent 执行失败。");
			}
		} finally {
			run.abortController = undefined;
			this.activeRuns -= 1;
			this.drain();
		}
	}

	private recordPath(runId: string): string {
		if (!this.storagePath || !isSafeFlatName(runId)) throw new Error("Invalid run storage path.");
		return join(dirname(this.storagePath), "run-records", `${runId}.json`);
	}

	private persist(run: MutableRun): void {
		if (!this.storagePath) return;
		const path = this.recordPath(run.id);
		mkdirSync(dirname(path), { recursive: true });
		const record: PersistedRun = {
			...snapshot(run),
			events: isTerminal(run.status)
				? compactEvents(run.events)
				: run.events.filter((event) => event.type !== "text_delta"),
		};
		this.atomicWrite(path, record);
		this.persistIndex();
	}

	private persistIndex(): void {
		if (!this.storagePath) return;
		mkdirSync(dirname(this.storagePath), { recursive: true });
		this.atomicWrite(this.storagePath, { version: 2, runs: [...this.runs.values()].map(listItem) });
	}

	private atomicWrite(path: string, value: unknown): void {
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
		renameSync(temporary, path);
	}

	private restore(storagePath: string): void {
		let data: {
			version?: number;
			runs: Array<HydroRunListItem | (Partial<HydroRunSnapshot> & { events?: HydroRunEvent[] })>;
		};
		try {
			data = JSON.parse(readFileSync(storagePath, "utf8")) as typeof data;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const records: Array<PersistedRun | (Partial<HydroRunSnapshot> & { events?: HydroRunEvent[] })> = [];
		if (data.version === 2) {
			for (const item of data.runs) {
				const id = item.id;
				if (!id || !isSafeFlatName(id)) continue;
				try {
					records.push(JSON.parse(readFileSync(this.recordPath(id), "utf8")) as PersistedRun);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
		} else records.push(...data.runs);

		for (const stored of records.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
			if (!stored.id || !stored.source || !stored.createdAt || !stored.updatedAt) continue;
			const status = stored.status ?? "failed";
			const interrupted = status === "running" || status === "queued";
			const events = stored.events ?? [];
			const artifactDirectory = stored.artifact
				? join(dirname(storagePath), "artifacts", stored.id, "hydro", stored.artifact.slug)
				: undefined;
			this.runs.set(stored.id, {
				id: stored.id,
				status: interrupted ? "needs_input" : status,
				title: stored.title && stored.title !== "制题请求" ? stored.title : inferTitle(stored.source),
				sourcePreview: stored.sourcePreview ?? makeSourcePreview(stored.source),
				source: stored.source,
				createdAt: stored.createdAt,
				updatedAt: stored.updatedAt,
				model: stored.model,
				modelSettings: stored.modelSettings,
				judgingType: stored.judgingType,
				metrics: stored.metrics,
				assistantText: stored.assistantText ?? "",
				error: interrupted ? "服务已重启，请点击继续任务。" : stored.error,
				artifact: normalizeArtifact(stored.artifact),
				conversation: stored.conversation ?? [],
				referenceProgram: stored.referenceProgram,
				attachments: stored.attachments ?? [],
				phase: stored.phase,
				phaseMessage: stored.phaseMessage,
				phaseStartedAt: stored.phaseStartedAt,
				lastEventSequence: stored.lastEventSequence ?? events.at(-1)?.sequence ?? 0,
				eventSequence: stored.lastEventSequence ?? events.at(-1)?.sequence ?? 0,
				artifactDirectory,
				events: compactEvents(events),
				listeners: new Set(),
			});
		}
		if (data.version !== 2) {
			const legacy = JSON.stringify(data);
			writeFileSync(`${storagePath}.legacy.json`, legacy, { mode: 0o600 });
			for (const run of this.runs.values()) this.persist(run);
		} else for (const run of this.runs.values()) this.persist(run);
	}
}
