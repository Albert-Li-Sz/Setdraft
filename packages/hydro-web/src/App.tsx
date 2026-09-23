import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type AgentRun,
	type AgentRunStatus,
	type AgentRunSummary,
	type ApiStatus,
	agentStatusLabel,
	algorithmValidationPresentation,
	apiStatusLabel,
	apiUrl,
	isTerminalAgentRun,
	normalizeApiOrigin,
	pageFromHash,
	type ReferenceProgram,
	readAgentRun,
	readAgentRunList,
	runDisplayTitle,
	type SandboxStatus,
	type ValidationReport,
} from "./platform.ts";
import {
	type AttachmentDraft,
	type CaseDraft,
	createAgentSource,
	createProblemRequest,
	emptyDraft,
	type ProblemDraft,
	samplesFromAgentSource,
	statementWithSamples,
} from "./problem.ts";
import { ReferenceProgramEditor } from "./ReferenceProgramEditor.tsx";
import { type RunsLoadStatus, RunsPage } from "./RunsPage.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { ValidationTab } from "./ValidationTab.tsx";
import { StatementEditor, TestDataEditor } from "./WorkspaceEditors.tsx";
import { WorkspaceSidebar } from "./WorkspaceSidebar.tsx";

type WorkspaceTab = "statement" | "tests" | "reference" | "validation";
type BusyAction = "validate" | "download" | "agent" | "continue" | "live" | undefined;

const apiOriginStorageKey = "hydro-problem-make.api-origin";

const exampleDraft: ProblemDraft = {
	slug: "a-plus-b",
	title: "A + B",
	tags: "入门, 模拟",
	timeLimit: "1s",
	memoryLimit: "256m",
	statement: `# A + B

## 题目描述

给定两个整数 $a$ 和 $b$，计算它们的和。

## 输入格式

一行两个整数 $a,b$，满足 $-10^9 \\le a,b \\le 10^9$。

## 输出格式

输出一个整数，表示 $a+b$。`,
	cases: [
		{ input: "1 2", output: "3" },
		{ input: "-5 8", output: "3" },
	],
};

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => {
			if (typeof reader.result === "string") resolve(reader.result);
			else reject(new Error(`无法读取附件 ${file.name}`));
		});
		reader.addEventListener("error", () => reject(reader.error ?? new Error(`无法读取附件 ${file.name}`)));
		reader.readAsDataURL(file);
	});
}

function errorMessage(value: unknown): string {
	if (typeof value !== "object" || value === null) return "请求失败，请检查 API 服务。";
	const message = (value as Record<string, unknown>).message;
	return typeof message === "string" ? message : "请求失败，请检查题目信息。";
}

function validationReport(value: unknown): ValidationReport | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const report = (value as Record<string, unknown>).report;
	if (typeof report !== "object" || report === null) return undefined;
	const valid = (report as Record<string, unknown>).valid;
	const issues = (report as Record<string, unknown>).issues;
	if (typeof valid !== "boolean" || !Array.isArray(issues)) return undefined;
	return report as ValidationReport;
}

function storedApiOrigin(): string {
	try {
		return normalizeApiOrigin(localStorage.getItem(apiOriginStorageKey) ?? "");
	} catch {
		localStorage.removeItem(apiOriginStorageKey);
		return "";
	}
}

export function App() {
	const [page, setPage] = useState(() => pageFromHash(window.location.hash));
	const [draft, setDraft] = useState(emptyDraft);
	const [referenceProgram, setReferenceProgram] = useState<ReferenceProgram>({ language: "cpp17", code: "" });
	const [taskReferenceProgram, setTaskReferenceProgram] = useState<ReferenceProgram>({ language: "cpp17", code: "" });
	const [editingTaskProgram, setEditingTaskProgram] = useState(false);
	const [sandbox, setSandbox] = useState<SandboxStatus>();
	const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
	const [activeTab, setActiveTab] = useState<WorkspaceTab>("statement");
	const [apiOrigin, setApiOrigin] = useState(storedApiOrigin);
	const [apiOriginDraft, setApiOriginDraft] = useState(apiOrigin);
	const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
	const [agentAvailable, setAgentAvailable] = useState(false);
	const [agentModels, setAgentModels] = useState<string[]>([]);
	const [liveHydro, setLiveHydro] = useState<{ configured: boolean; message: string }>({
		configured: false,
		message: "尚未配置测试实例",
	});
	const [connectionMessage, setConnectionMessage] = useState("正在连接平台 API……");
	const [agentRun, setAgentRun] = useState<AgentRun>();
	const [continuationDrafts, setContinuationDrafts] = useState<Record<string, string>>({});
	const [runs, setRuns] = useState<AgentRunSummary[]>([]);
	const [runsStatus, setRunsStatus] = useState<RunsLoadStatus>("idle");
	const [runsMessage, setRunsMessage] = useState("");
	const [deletingRunIds, setDeletingRunIds] = useState<string[]>([]);
	const deletedRunIds = useRef(new Set<string>());
	const [validation, setValidation] = useState<ValidationReport>();
	const [busyAction, setBusyAction] = useState<BusyAction>();
	const [notice, setNotice] = useState("粘贴题面即可运行 Pi Agent，自动生成标程、testlib 数据与需要的 SPJ。");
	const eventSourceRef = useRef<EventSource | undefined>(undefined);
	const workspaceRevision = useRef(0);
	const checkApiConnection = useCallback(async (origin: string, signal?: AbortSignal): Promise<void> => {
		setApiStatus("checking");
		setAgentAvailable(false);
		setAgentModels([]);
		setSandbox(undefined);
		setLiveHydro({ configured: false, message: "尚未配置测试实例" });
		setConnectionMessage("正在连接平台 API……");
		try {
			const response = await fetch(apiUrl(origin, "/health"), { signal });
			if (!response.ok) throw new Error("API health check failed");
			const body = (await response.json()) as unknown;
			setApiStatus("online");
			setConnectionMessage("连接成功，格式检查与打包 API 可用。");
			if (typeof body !== "object" || body === null) return;
			const sandboxStatus = (body as { sandbox?: SandboxStatus }).sandbox;
			if (sandboxStatus) setSandbox(sandboxStatus);
			const capabilities = (body as Record<string, unknown>).capabilities;
			if (typeof capabilities !== "object" || capabilities === null) return;
			const values = capabilities as Record<string, unknown>;
			setAgentAvailable(values.agentGeneration === true);
			if (Array.isArray(values.agentModels)) {
				setAgentModels(values.agentModels.filter((model): model is string => typeof model === "string"));
			}
			const live = values.liveHydro;
			if (
				typeof live === "object" &&
				live !== null &&
				typeof (live as Record<string, unknown>).configured === "boolean" &&
				typeof (live as Record<string, unknown>).message === "string"
			)
				setLiveHydro(live as { configured: boolean; message: string });
		} catch (error) {
			if (signal?.aborted) return;
			setApiStatus("offline");
			setConnectionMessage(error instanceof Error ? `连接失败：${error.message}` : "连接失败，请检查 API 地址。");
		}
	}, []);
	const loadRuns = useCallback(async (): Promise<void> => {
		setRunsStatus("loading");
		setRunsMessage("");
		try {
			const response = await fetch(apiUrl(apiOrigin, "/runs"));
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(errorMessage(body));
			if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).runs)) {
				throw new Error("服务端返回了无法识别的任务列表。");
			}
			setRuns(readAgentRunList(body).filter((run) => !deletedRunIds.current.has(run.id)));
			setRunsStatus("loaded");
		} catch (error) {
			setRunsStatus("error");
			setRunsMessage(error instanceof Error ? error.message : "任务记录读取失败。");
		}
	}, [apiOrigin]);

	useEffect(() => {
		const updatePage = (): void => setPage(pageFromHash(window.location.hash));
		window.addEventListener("hashchange", updatePage);
		return () => window.removeEventListener("hashchange", updatePage);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		void checkApiConnection(apiOrigin, controller.signal);
		return () => controller.abort();
	}, [apiOrigin, checkApiConnection]);

	useEffect(() => () => eventSourceRef.current?.close(), []);

	useEffect(() => {
		if (page === "runs") void loadRuns();
	}, [loadRuns, page]);

	const previewStatement = useMemo(() => {
		let markdown = statementWithSamples(draft);
		for (const attachment of attachments)
			markdown = markdown.replaceAll(`file://${attachment.name}`, attachment.dataUrl);
		return markdown;
	}, [attachments, draft]);

	function invalidateValidation(): void {
		setValidation(undefined);
		setNotice("内容已修改，需要重新运行格式检查。");
	}

	function resetWorkspace(): void {
		workspaceRevision.current += 1;
		eventSourceRef.current?.close();
		eventSourceRef.current = undefined;
		setDraft({ ...emptyDraft, cases: [] });
		setReferenceProgram({ language: "cpp17", code: "" });
		setTaskReferenceProgram({ language: "cpp17", code: "" });
		setEditingTaskProgram(false);
		setAttachments([]);
		setAgentRun(undefined);
		setValidation(undefined);
		setBusyAction(undefined);
		setActiveTab("statement");
		setNotice("已重制，可以粘贴下一题。已创建的任务保留在任务记录中。");
		window.location.hash = "workspace";
	}

	function updateField(field: Exclude<keyof ProblemDraft, "cases">, value: string): void {
		setDraft((current) => ({ ...current, [field]: value }));
		invalidateValidation();
	}

	function updateCase(index: number, field: keyof CaseDraft, value: string): void {
		setDraft((current) => ({
			...current,
			cases: current.cases.map((testCase, caseIndex) =>
				caseIndex === index ? { ...testCase, [field]: value } : testCase,
			),
		}));
		invalidateValidation();
	}

	async function runValidation(): Promise<void> {
		const revision = workspaceRevision.current;
		setBusyAction("validate");
		setNotice("正在检查 Hydro 元数据、题面、样例和测试配置……");
		try {
			const response = await fetch(apiUrl(apiOrigin, "/problems/validate"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createProblemRequest(draft, attachments)),
			});
			const body = (await response.json()) as unknown;
			if (revision !== workspaceRevision.current) return;
			if (!response.ok) throw new Error(errorMessage(body));
			const report = body as ValidationReport;
			setValidation(report);
			setNotice(
				report.valid ? "格式检查通过，可以生成 Hydro 导入包。" : `发现 ${report.issues.length} 个格式问题。`,
			);
			if (!report.valid) setActiveTab("validation");
		} catch (error) {
			if (revision !== workspaceRevision.current) return;
			setNotice(error instanceof Error ? error.message : "格式检查失败。");
		} finally {
			if (revision === workspaceRevision.current) setBusyAction(undefined);
		}
	}

	async function downloadArchive(): Promise<void> {
		const revision = workspaceRevision.current;
		setBusyAction("download");
		setNotice("正在生成可复现的 Hydro 导入包……");
		try {
			const response = await fetch(apiUrl(apiOrigin, "/problems/archive"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(createProblemRequest(draft, attachments)),
			});
			if (!response.ok) {
				const body = (await response.json()) as unknown;
				if (revision !== workspaceRevision.current) return;
				const report = validationReport(body);
				if (report !== undefined) {
					setValidation(report);
					setActiveTab("validation");
				}
				throw new Error(errorMessage(body));
			}
			const archive = await response.blob();
			if (revision !== workspaceRevision.current) return;
			const url = URL.createObjectURL(archive);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${draft.slug}.hydro.zip`;
			link.click();
			URL.revokeObjectURL(url);
			setValidation({ valid: true, issues: [] });
			setNotice("Hydro 导入包已生成。该结果尚未完成算法正确性和真实 Hydro 评测验收。");
		} catch (error) {
			if (revision !== workspaceRevision.current) return;
			setNotice(error instanceof Error ? error.message : "导入包生成失败。");
		} finally {
			if (revision === workspaceRevision.current) setBusyAction(undefined);
		}
	}

	async function refreshAgentRun(runId: string, revision: number): Promise<AgentRun | undefined> {
		const response = await fetch(apiUrl(apiOrigin, `/runs/${runId}`));
		if (!response.ok) return undefined;
		const run = readAgentRun((await response.json()) as unknown);
		if (run === undefined || deletedRunIds.current.has(run.id)) return undefined;
		setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
		if (revision !== workspaceRevision.current) return undefined;
		setAgentRun(run);
		if (run.artifact !== undefined) setValidation(run.artifact.report);
		if (run.status === "succeeded") setNotice("Skill 已生成并校验 Hydro 目录，可以下载对应导入包。");
		else if (run.status === "needs_input") setNotice("请在任务对话下方填写补充信息，然后点击“提交补充并继续”。");
		else if (run.status === "failed") setNotice("Skill 生成失败，请查看验证记录。");
		else if (run.status === "cancelled") setNotice("Skill 生成任务已取消。");
		return run;
	}

	function watchAgentRun(run: AgentRun): void {
		const revision = workspaceRevision.current;
		const runId = run.id;
		eventSourceRef.current?.close();
		eventSourceRef.current = undefined;
		if (isTerminalAgentRun(run.status)) return;
		const source = new EventSource(apiUrl(apiOrigin, `/runs/${runId}/events?after=${run.lastEventSequence ?? 0}`));
		eventSourceRef.current = source;
		const isCurrent = (): boolean => revision === workspaceRevision.current && eventSourceRef.current === source;
		source.addEventListener("text_delta", (event) => {
			if (!isCurrent()) return;
			if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as unknown;
				if (typeof data !== "object" || data === null) return;
				const delta = (data as Record<string, unknown>).message;
				if (typeof delta === "string") {
					setAgentRun((current) =>
						current?.id === runId ? { ...current, assistantText: `${current.assistantText}${delta}` } : current,
					);
				}
			} catch {
				// Ignore an incomplete event and let the final snapshot replace it.
			}
		});
		source.addEventListener("tool", (event) => {
			if (!isCurrent()) return;
			if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as unknown;
				if (typeof data !== "object" || data === null) return;
				const message = (data as Record<string, unknown>).message;
				if (typeof message === "string") setNotice(message);
			} catch {
				// Ignore malformed progress; the run snapshot remains authoritative.
			}
		});
		source.addEventListener("phase", (event) => {
			if (!isCurrent() || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as Record<string, unknown>;
				if (typeof data.phase !== "string" || typeof data.message !== "string") return;
				const phase = data.phase as AgentRun["phase"];
				const message = data.message;
				setAgentRun((current) =>
					current?.id === runId
						? {
								...current,
								phase,
								phaseMessage: message,
								phaseStartedAt: new Date().toISOString(),
							}
						: current,
				);
				setNotice(message);
			} catch {
				// The final run snapshot remains authoritative.
			}
		});
		source.addEventListener("metrics", (event) => {
			if (!isCurrent() || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as Record<string, unknown>;
				if (typeof data.metrics !== "object" || data.metrics === null) return;
				setAgentRun((current) =>
					current?.id === runId ? { ...current, metrics: data.metrics as AgentRun["metrics"] } : current,
				);
			} catch {
				// The final snapshot remains authoritative.
			}
		});
		source.addEventListener("judging_type", (event) => {
			if (!isCurrent() || !(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as Record<string, unknown>;
				if (
					data.judgingType !== "default" &&
					data.judgingType !== "interactive" &&
					data.judgingType !== "submit_answer"
				)
					return;
				setAgentRun((current) =>
					current?.id === runId
						? { ...current, judgingType: data.judgingType as AgentRun["judgingType"] }
						: current,
				);
			} catch {
				// The final snapshot remains authoritative.
			}
		});
		source.addEventListener("status", (event) => {
			if (!isCurrent()) return;
			if (!(event instanceof MessageEvent) || typeof event.data !== "string") return;
			try {
				const data = JSON.parse(event.data) as unknown;
				if (typeof data !== "object" || data === null) return;
				const status = (data as Record<string, unknown>).status;
				if (status === "queued" || status === "running")
					setAgentRun((current) => (current?.id === runId ? { ...current, status } : current));
				if (typeof status === "string" && isTerminalAgentRun(status as AgentRunStatus)) {
					source.close();
					void refreshAgentRun(runId, revision).catch(() => {
						if (isCurrent()) setNotice("任务状态读取失败，请从任务记录重新打开。");
					});
				}
			} catch {
				// Ignore malformed progress; the run snapshot remains authoritative.
			}
		});
		source.onerror = () => {
			source.close();
			if (!isCurrent()) return;
			void refreshAgentRun(runId, revision)
				.then((current) => {
					if (current && isCurrent()) watchAgentRun(current);
				})
				.catch(() => {
					if (isCurrent()) setNotice("任务连接中断，请从任务记录重新打开。");
				});
		};
	}

	async function startAgentRun(): Promise<void> {
		if (!draft.statement.trim()) {
			setNotice("请先粘贴题面。");
			return;
		}
		if (!agentAvailable) {
			setNotice("服务端尚未配置可用的 Pi 模型。");
			return;
		}
		workspaceRevision.current += 1;
		const revision = workspaceRevision.current;
		eventSourceRef.current?.close();
		eventSourceRef.current = undefined;
		setBusyAction("agent");
		setNotice("正在创建 Skill 生成任务……");
		try {
			const response = await fetch(apiUrl(apiOrigin, "/runs"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					source: createAgentSource(draft),
					referenceProgram: referenceProgram.code.trim() ? referenceProgram : undefined,
					attachments: attachments.map(({ name, contentBase64 }) => ({ name, contentBase64 })),
				}),
			});
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(errorMessage(body));
			const run = readAgentRun(body);
			if (run === undefined) throw new Error("服务端返回了无法识别的任务状态。");
			setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
			if (revision !== workspaceRevision.current) return;
			setAgentRun(run);
			setTaskReferenceProgram(run.referenceProgram ?? referenceProgram);
			setValidation(undefined);
			setActiveTab("validation");
			setNotice("Skill 任务已创建，进度会实时显示在验证记录中。");
			watchAgentRun(run);
		} catch (error) {
			if (revision !== workspaceRevision.current) return;
			setNotice(error instanceof Error ? error.message : "Skill 任务创建失败。");
		} finally {
			if (revision === workspaceRevision.current) setBusyAction(undefined);
		}
	}

	async function continueAgentRun(message?: string): Promise<boolean> {
		if (!agentRun) return false;
		workspaceRevision.current += 1;
		const revision = workspaceRevision.current;
		eventSourceRef.current?.close();
		eventSourceRef.current = undefined;
		setBusyAction("continue");
		try {
			const response = await fetch(
				apiUrl(apiOrigin, `/runs/${agentRun.id}/${message === undefined ? "retry" : "continue"}`),
				{
					method: "POST",
					...(message === undefined
						? {}
						: {
								headers: { "content-type": "application/json" },
								body: JSON.stringify({
									message,
									referenceProgram: taskReferenceProgram.code.trim() ? taskReferenceProgram : null,
								}),
							}),
				},
			);
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(errorMessage(body));
			const run = readAgentRun(body);
			if (!run) throw new Error("无法读取续接任务状态。");
			setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
			if (revision !== workspaceRevision.current) return true;
			setAgentRun(run);
			setValidation(undefined);
			setNotice("已提交补充信息，Pi Agent 正在继续当前任务。");
			watchAgentRun(run);
			return true;
		} catch (error) {
			if (revision !== workspaceRevision.current) return false;
			setNotice(error instanceof Error ? error.message : "继续任务失败。");
			return false;
		} finally {
			if (revision === workspaceRevision.current) setBusyAction(undefined);
		}
	}

	async function cancelAgentRun(): Promise<void> {
		if (agentRun === undefined) return;
		const revision = workspaceRevision.current;
		try {
			const response = await fetch(apiUrl(apiOrigin, `/runs/${agentRun.id}/cancel`), { method: "POST" });
			if (!response.ok) throw new Error(errorMessage((await response.json()) as unknown));
			if (revision !== workspaceRevision.current) return;
			eventSourceRef.current?.close();
			eventSourceRef.current = undefined;
			await refreshAgentRun(agentRun.id, revision);
		} catch (error) {
			if (revision === workspaceRevision.current)
				setNotice(error instanceof Error ? error.message : "取消任务失败。");
		}
	}

	async function runLiveHydroVerification(): Promise<void> {
		if (!agentRun?.artifact?.authoring || !liveHydro.configured) return;
		const revision = workspaceRevision.current;
		setBusyAction("live");
		setNotice("正在导入真实 Hydro，并提交标程与错误程序……");
		try {
			const response = await fetch(apiUrl(apiOrigin, `/runs/${agentRun.id}/live-verify`), { method: "POST" });
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(errorMessage(body));
			if (revision !== workspaceRevision.current) return;
			await refreshAgentRun(agentRun.id, revision);
			const success =
				typeof body === "object" && body !== null && (body as Record<string, unknown>).success === true;
			setNotice(success ? "真实 Hydro 实测通过。" : "真实 Hydro 实测完成，但存在未通过项。");
		} catch (error) {
			if (revision === workspaceRevision.current)
				setNotice(error instanceof Error ? error.message : "真实 Hydro 实测失败。");
		} finally {
			if (revision === workspaceRevision.current) setBusyAction(undefined);
		}
	}

	function saveApiConfiguration(): void {
		try {
			const normalized = normalizeApiOrigin(apiOriginDraft);
			if (normalized.length > 0) localStorage.setItem(apiOriginStorageKey, normalized);
			else localStorage.removeItem(apiOriginStorageKey);
			setApiOriginDraft(normalized);
			if (normalized === apiOrigin) void checkApiConnection(normalized);
			else setApiOrigin(normalized);
		} catch (error) {
			setApiStatus("offline");
			setConnectionMessage(error instanceof Error ? error.message : "API 根地址无效。");
		}
	}

	function resetApiConfiguration(): void {
		localStorage.removeItem(apiOriginStorageKey);
		setApiOriginDraft("");
		if (apiOrigin.length === 0) void checkApiConnection("");
		else setApiOrigin("");
	}

	async function openHistoryRun(previousRun: AgentRunSummary): Promise<void> {
		workspaceRevision.current += 1;
		const revision = workspaceRevision.current;
		eventSourceRef.current?.close();
		eventSourceRef.current = undefined;
		setBusyAction(undefined);
		let run: AgentRun | undefined;
		try {
			run = await refreshAgentRun(previousRun.id, revision);
		} catch {
			setRunsMessage("任务详情读取失败，请刷新后重试。");
		}
		if (!run || revision !== workspaceRevision.current || deletedRunIds.current.has(previousRun.id)) return;
		setAgentRun(run);
		setTaskReferenceProgram(run.referenceProgram ?? { language: "cpp17", code: "" });
		setValidation(run.artifact?.report);
		setActiveTab("validation");
		setNotice(`已打开任务 ${run.id.slice(0, 8)}：${agentStatusLabel(run.status)}。`);
		window.location.hash = "workspace";
		watchAgentRun(run);
	}

	async function deleteRun(run: AgentRunSummary): Promise<void> {
		const revision = workspaceRevision.current;
		setDeletingRunIds((current) => [...current, run.id]);
		setRunsMessage("");
		try {
			const response = await fetch(apiUrl(apiOrigin, `/runs/${run.id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(errorMessage((await response.json()) as unknown));
			deletedRunIds.current.add(run.id);
			setRuns((current) => current.filter((item) => item.id !== run.id));
			setContinuationDrafts((current) => {
				const remaining = { ...current };
				delete remaining[run.id];
				return remaining;
			});
			setRunsStatus("loaded");
			setRunsMessage(`已删除任务“${runDisplayTitle(run)}”。`);
			if (revision === workspaceRevision.current && agentRun?.id === run.id) {
				workspaceRevision.current += 1;
				eventSourceRef.current?.close();
				eventSourceRef.current = undefined;
				setAgentRun(undefined);
				setTaskReferenceProgram({ language: "cpp17", code: "" });
				setEditingTaskProgram(false);
				setValidation(undefined);
				setBusyAction(undefined);
				setActiveTab("statement");
				setNotice("任务已删除，当前题面草稿已保留。");
			}
		} catch (error) {
			setRunsStatus("error");
			setRunsMessage(error instanceof Error ? error.message : "删除任务失败，请重试。");
		} finally {
			setDeletingRunIds((current) => current.filter((id) => id !== run.id));
		}
	}

	async function addAttachments(event: ChangeEvent<HTMLInputElement>): Promise<void> {
		const revision = workspaceRevision.current;
		const input = event.currentTarget;
		const files = [...(input.files ?? [])];
		try {
			const additions: AttachmentDraft[] = [];
			for (const file of files) {
				if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.name)) {
					throw new Error(`附件名 ${file.name} 只能使用 ASCII 字母、数字、点、横线和下划线。`);
				}
				if (file.size > 1024 * 1024) throw new Error(`附件 ${file.name} 超过当前 1 MiB 限制。`);
				const dataUrl = await readFileAsDataUrl(file);
				additions.push({ name: file.name, contentBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl });
			}
			if (revision !== workspaceRevision.current) return;
			setAttachments((current) => {
				const names = new Set(additions.map((attachment) => attachment.name));
				return [...current.filter((attachment) => !names.has(attachment.name)), ...additions];
			});
			invalidateValidation();
		} catch (error) {
			if (revision !== workspaceRevision.current) return;
			setNotice(error instanceof Error ? error.message : "附件读取失败。");
		} finally {
			input.value = "";
		}
	}

	function insertAttachment(attachment: AttachmentDraft): void {
		const isImage = attachment.dataUrl.startsWith("data:image/");
		const reference = isImage
			? `\n\n![${attachment.name}](file://${attachment.name})`
			: `\n\n[${attachment.name}](file://${attachment.name})`;
		updateField("statement", `${draft.statement.trimEnd()}${reference}\n`);
	}

	const validationClass = validation === undefined ? "pending" : validation.valid ? "passed" : "failed";
	const viewingTask = agentRun && (activeTab === "validation" || (activeTab === "reference" && editingTaskProgram));
	const agentRunning = agentRun?.status === "queued" || agentRun?.status === "running";
	const agentClass =
		agentRun?.status === "succeeded"
			? "passed"
			: agentRun?.status === "failed" || agentRun?.status === "cancelled"
				? "failed"
				: agentRun?.status === "needs_input"
					? "attention"
					: agentRunning
						? "active"
						: "pending";
	const algorithmValidation = algorithmValidationPresentation(agentRun, sandbox);

	return (
		<>
			<header className="site-header">
				<div className="header-inner">
					<a className="brand" href="#workspace" aria-label="Hydro Problem Make 首页">
						<span className="brand-mark">H</span>
						<span>Hydro Problem Make</span>
					</a>
					<nav className="main-nav" aria-label="主导航">
						<a className={page === "workspace" ? "active" : ""} href="#workspace">
							制题工作台
						</a>
						<a className={page === "runs" ? "active" : ""} href="#runs">
							任务记录
						</a>
						<a className={page === "settings" ? "active" : ""} href="#settings">
							设置
						</a>
					</nav>
					<button
						className={`api-pill ${apiStatus}`}
						type="button"
						onClick={() => {
							window.location.hash = "settings";
						}}
						title="打开 API 配置"
					>
						{apiStatusLabel(apiStatus)}
					</button>
				</div>
			</header>

			{page === "workspace" && (
				<main className="page" id="workspace">
					<div className="breadcrumb">
						{viewingTask
							? `任务记录 / ${runDisplayTitle(agentRun)}`
							: `题库 / 新建题目 / ${draft.title || "未命名题目"}`}
					</div>
					<section className="page-heading">
						<div>
							<div className="eyebrow">自动制题 · testlib · Hydro</div>
							<h1>{viewingTask ? runDisplayTitle(agentRun) : draft.title || "未命名题目"}</h1>
							<p>粘贴题面，自动生成标程、测试数据与需要的 SPJ，验证后下载 Hydro 包。</p>
						</div>
						<div className="heading-actions">
							<button className="button secondary" type="button" onClick={resetWorkspace}>
								重制 / 下一题
							</button>
							<button
								className="button primary"
								type="button"
								onClick={startAgentRun}
								disabled={!agentAvailable || busyAction !== undefined || agentRunning}
								title={
									agentAvailable
										? "使用固定 Hydro Skill 创建 Pi Agent 任务"
										: "请先在设置页配置 Pi Agent 的 AI API"
								}
							>
								{busyAction === "agent" ? "创建中…" : agentAvailable ? "运行 Pi Agent" : "AI 生成未配置"}
							</button>
							<button
								className="button secondary"
								type="button"
								onClick={runValidation}
								disabled={busyAction !== undefined}
							>
								{busyAction === "validate" ? "检查中…" : "运行格式检查"}
							</button>
							{activeTab === "validation" && agentRun?.status === "succeeded" && agentRun.artifact ? (
								<a
									className="button primary button-link"
									href={apiUrl(apiOrigin, `/runs/${agentRun.id}/archive`)}
									download={`${agentRun.artifact.slug}.hydro.zip`}
								>
									下载 Hydro 包
								</a>
							) : (
								<button
									className="button secondary"
									type="button"
									onClick={downloadArchive}
									disabled={busyAction !== undefined}
								>
									{busyAction === "download" ? "生成中…" : "手工打包"}
								</button>
							)}
						</div>
					</section>

					<output className={`notice ${validationClass}`}>
						<span className="notice-dot" />
						{notice}
					</output>

					<div className="workspace-grid">
						<section className="card workspace-card">
							<div className="tabs" role="tablist" aria-label="题目内容">
								<button
									className={activeTab === "statement" ? "active" : ""}
									type="button"
									onClick={() => setActiveTab("statement")}
								>
									题面与预览
								</button>
								<button
									className={activeTab === "tests" ? "active" : ""}
									type="button"
									onClick={() => setActiveTab("tests")}
								>
									测试数据 <span className="tab-count">{draft.cases.length}</span>
								</button>
								<button
									className={activeTab === "reference" ? "active" : ""}
									type="button"
									onClick={() => {
										setEditingTaskProgram(false);
										setActiveTab("reference");
									}}
								>
									标准程序{referenceProgram.code.trim() && <span className="tab-count">1</span>}
								</button>
								<button
									className={activeTab === "validation" ? "active" : ""}
									type="button"
									onClick={() => setActiveTab("validation")}
								>
									任务与验证
								</button>
							</div>

							{activeTab === "statement" && (
								<StatementEditor
									draft={draft}
									previewStatement={previewStatement}
									onStatementChange={(value) => updateField("statement", value)}
									onLoadExample={() => {
										setDraft(exampleDraft);
										invalidateValidation();
									}}
								/>
							)}

							{activeTab === "tests" && (
								<TestDataEditor
									cases={draft.cases}
									onChange={updateCase}
									onRemove={(index) => {
										setDraft((current) => ({
											...current,
											cases: current.cases.filter((_, caseIndex) => caseIndex !== index),
										}));
										invalidateValidation();
									}}
									onAdd={() => {
										setDraft((current) => ({
											...current,
											cases: [...current.cases, { input: "", output: "" }],
										}));
										invalidateValidation();
									}}
								/>
							)}

							{activeTab === "validation" && (
								<ValidationTab
									run={agentRun}
									apiOrigin={apiOrigin}
									agentClass={agentClass}
									busy={busyAction !== undefined}
									agentAvailable={agentAvailable}
									hasReferenceProgram={!!taskReferenceProgram.code.trim()}
									continuationMessage={agentRun ? (continuationDrafts[agentRun.id] ?? "") : ""}
									validation={validation}
									validationClass={validationClass}
									liveHydroConfigured={liveHydro.configured}
									liveBusy={busyAction === "live"}
									onContinuationMessageChange={(message) => {
										if (agentRun)
											setContinuationDrafts((current) => ({ ...current, [agentRun.id]: message }));
									}}
									onContinue={continueAgentRun}
									onRetry={() => continueAgentRun()}
									onCancel={() => void cancelAgentRun()}
									onEditProgram={() => {
										setEditingTaskProgram(true);
										setActiveTab("reference");
									}}
									onLiveVerify={() => void runLiveHydroVerification()}
								/>
							)}
							{activeTab === "reference" && (
								<ReferenceProgramEditor
									key={editingTaskProgram ? agentRun?.id : "draft"}
									apiOrigin={apiOrigin}
									program={editingTaskProgram ? taskReferenceProgram : referenceProgram}
									onChange={editingTaskProgram ? setTaskReferenceProgram : setReferenceProgram}
									cases={
										editingTaskProgram && agentRun ? samplesFromAgentSource(agentRun.source) : draft.cases
									}
									timeLimit={
										editingTaskProgram
											? (agentRun?.source.match(/^- 时间限制：(.+)$/m)?.[1] ?? "1s")
											: draft.timeLimit
									}
									memoryLimit={
										editingTaskProgram
											? (agentRun?.source.match(/^- 内存限制：(.+)$/m)?.[1] ?? "256m")
											: draft.memoryLimit
									}
									sandbox={sandbox}
									onApplyOutputs={
										editingTaskProgram
											? undefined
											: (cases) => {
													setDraft((current) => ({ ...current, cases }));
													invalidateValidation();
												}
									}
									hasTask={editingTaskProgram && !!agentRun}
									onBackToTask={() => setActiveTab("validation")}
								/>
							)}
						</section>

						<WorkspaceSidebar
							draft={draft}
							viewingTask={!!viewingTask}
							attachments={attachments}
							validation={validation}
							validationClass={validationClass}
							agentClass={agentClass}
							agentRun={agentRun}
							agentAvailable={agentAvailable}
							algorithmValidation={algorithmValidation}
							liveHydroMessage={liveHydro.message}
							onFieldChange={updateField}
							onInsertAttachment={insertAttachment}
							onRemoveAttachment={(name) => {
								setAttachments((current) => current.filter((item) => item.name !== name));
								invalidateValidation();
							}}
							onUploadAttachments={(event) => void addAttachments(event)}
						/>
					</div>
				</main>
			)}

			{page === "runs" && (
				<RunsPage
					apiOrigin={apiOrigin}
					runs={runs}
					status={runsStatus}
					message={runsMessage}
					onRefresh={() => void loadRuns()}
					onOpenRun={openHistoryRun}
					onDeleteRun={(run) => void deleteRun(run)}
					deletingRunIds={deletingRunIds}
				/>
			)}

			{page === "settings" && (
				<SettingsPage
					apiOrigin={apiOrigin}
					apiOriginDraft={apiOriginDraft}
					apiStatus={apiStatus}
					agentAvailable={agentAvailable}
					agentModels={agentModels}
					sandbox={sandbox}
					connectionMessage={connectionMessage}
					onApiOriginChange={setApiOriginDraft}
					onSave={saveApiConfiguration}
					onReset={resetApiConfiguration}
					onAiConfigurationChanged={() => void checkApiConnection(apiOrigin)}
				/>
			)}
			<footer>Hydro Problem Make · Hydro 默认比较器 / C++ testlib SPJ</footer>
		</>
	);
}
