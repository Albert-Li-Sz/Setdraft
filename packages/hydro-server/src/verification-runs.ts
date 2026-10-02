import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeStoredArchiveFromFiles } from "@setdraft/authoring";
import {
	aggregateScore,
	allocateCaseScores,
	evaluateSolution,
	type ManualCaseSummary,
	type ManualCheck,
	type ManualProject,
	type ManualProjectSnapshot,
	type MatrixCell,
	type MatrixDiagnostic,
	projectSolutions,
	readProjectSnapshot,
	type VerificationOptions,
	type VerificationRun,
	type VerificationRunPage,
} from "@setdraft/contracts";
import { effectiveChecker } from "./acm-checker.ts";
import type { ExecutionContext } from "./execution-context.ts";
import type { ManualProjectStore } from "./manual-projects.ts";
import type { SandboxCase } from "./manual-sandbox.ts";
import { ManualProjectError } from "./project-error.ts";
import { dataStem, parseGeneratorScript } from "./project-files.ts";
import { copySandboxFile } from "./sandbox-files.ts";
import { sandboxPolicy } from "./sandbox-policy.ts";
import { cleanupSandboxStage, SandboxCleanupError, sandboxRuntimeArgs } from "./sandbox-runtime.ts";
import { runSolutionSandbox } from "./solution-sandbox.ts";
import {
	collectRunDiagnostics,
	firstOutputDifference,
	RunCheckpoints,
	readTextPreview,
} from "./verification-diagnostics.ts";
import type { WorkspaceFile } from "./workspace-db.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (item: ManualCaseSummary) => `${item.origin}:${item.id}`;

export function readVerificationOptions(value: unknown): VerificationOptions {
	if (!value || typeof value !== "object") throw new ManualProjectError("运行配置无效。", 422);
	const input = value as Record<string, unknown>;
	const ids = (raw: unknown): string[] | undefined => {
		if (raw === undefined) return undefined;
		if (
			!Array.isArray(raw) ||
			!raw.length ||
			raw.length > 1000 ||
			raw.some((id) => typeof id !== "string" || id.length > 300) ||
			new Set(raw).size !== raw.length
		)
			throw new ManualProjectError("请选择有效的解法和测试点。", 422);
		return raw as string[];
	};
	if (input.kind === "matrix")
		return { kind: "matrix", solutionIds: ids(input.solutionIds), caseIds: ids(input.caseIds) };
	if (
		input.kind !== "stress" ||
		typeof input.baselineId !== "string" ||
		typeof input.command !== "string" ||
		!input.command.includes("{seed}")
	)
		throw new ManualProjectError("对拍需要基准解法和含 {seed} 的生成命令。", 422);
	const commands = parseGeneratorScript(input.command);
	if (commands.length !== 1) throw new ManualProjectError("对拍只接受一行 gen 命令。", 422);
	const seed = input.seed ?? 1,
		rounds = input.rounds ?? 100,
		budgetMs = input.budgetMs ?? 60_000;
	if (
		!Number.isSafeInteger(seed) ||
		Number(seed) < 0 ||
		!Number.isSafeInteger(rounds) ||
		Number(rounds) < 1 ||
		Number(rounds) > 1000 ||
		!Number.isSafeInteger(Number(seed) + Number(rounds)) ||
		!Number.isSafeInteger(budgetMs) ||
		Number(budgetMs) < 1000 ||
		Number(budgetMs) > sandboxPolicy().runTimeoutMs
	)
		throw new ManualProjectError("种子、轮数或时间预算无效；最多 1000 轮且不能超过沙箱时间上限。", 422);
	const solutionIds = ids(input.solutionIds);
	if (!solutionIds?.length || solutionIds.includes(input.baselineId))
		throw new ManualProjectError("请选择不同于基准的待测解法。", 422);
	return {
		kind: "stress",
		baselineId: input.baselineId,
		solutionIds,
		command: input.command,
		seed: Number(seed),
		rounds: Number(rounds),
		budgetMs: Number(budgetMs),
	};
}

export class VerificationRuns {
	private readonly projects: ManualProjectStore;
	constructor(projects: ManualProjectStore) {
		this.projects = projects;
	}
	private get database() {
		return this.projects.database;
	}
	async interrupt(taskId: string): Promise<void> {
		const rows = await this.database.sql.all<{ id: string; body: VerificationRun }>(
			"SELECT id,body FROM documents WHERE kind='verification-run' AND body->>'taskId'=$1 AND body->>'state'='running'",
			[taskId],
		);
		for (const row of rows)
			await this.database.put("verification-run", row.id, {
				...row.body,
				state: "failed",
				error: "服务进程中断；请从任务中心重试。",
				finishedAt: new Date().toISOString(),
			});
	}

	async get(projectId: string, id: string): Promise<VerificationRun> {
		await this.projects.load(projectId);
		const run = await this.database.get<VerificationRun>("verification-run", id);
		if (!run || run.projectId !== projectId) throw new ManualProjectError("运行记录不存在。", 404);
		const path = await this.database.filePath("verification-file", id, "result.json");
		if (!path) return run;
		const detail = JSON.parse(await readFile(path, "utf8")) as VerificationRun;
		const chunks = await this.database.sql.all<{ body: { cells: MatrixCell[]; checks: ManualCheck[] } }>(
			"SELECT body FROM documents WHERE kind='verification-progress' AND body->>'runId'=$1 ORDER BY id",
			[id],
		);
		if (chunks.length) {
			if (detail.matrix) {
				const cells = new Map(detail.matrix.cells.map((cell) => [`${cell.caseId}/${cell.solutionId}`, cell]));
				for (const { body } of chunks)
					for (const cell of body.cells) cells.set(`${cell.caseId}/${cell.solutionId}`, cell);
				detail.matrix.cells = [...cells.values()];
				detail.matrix.solutions = run.matrix?.solutions ?? [];
			}
			detail.checks = [...(detail.checks ?? []), ...chunks.flatMap(({ body }) => body.checks)];
		}
		return {
			...detail,
			progress: run.progress ?? detail.progress,
			state: run.state,
			error: run.error,
			finishedAt: run.finishedAt,
			importedCase: run.importedCase,
		};
	}
	private summary(run: VerificationRun): VerificationRun {
		return {
			...run,
			checks: undefined,
			solutions: run.solutions.map((item) => ({ ...item, code: "" })),
			matrix: run.matrix ? { ...run.matrix, cases: [], cells: [] } : undefined,
			stress: run.stress
				? { ...run.stress, cells: [], inputPreview: undefined, outputPreview: undefined }
				: undefined,
		};
	}
	private async save(run: VerificationRun, files: WorkspaceFile[] = [], context?: ExecutionContext): Promise<void> {
		await this.database.commitFiles(
			[
				...files,
				{
					ownerKind: "verification-file",
					ownerId: run.id,
					name: "result.json",
					source: { bytes: Buffer.from(JSON.stringify(run)) },
				},
			],
			async () => {
				context?.signal.throwIfAborted();
				await this.database.put("verification-run", run.id, this.summary(run));
				if (run.state !== "running")
					await this.database.sql.execute(
						"DELETE FROM documents WHERE kind='verification-progress' AND body->>'runId'=$1",
						[run.id],
					);
			},
		);
	}
	async list(projectId: string): Promise<VerificationRun[]> {
		return (await this.page(projectId, { limit: 100 })).runs;
	}
	async page(
		projectId: string,
		options: { limit?: number; cursor?: string; kind?: string; taskId?: string } = {},
	): Promise<VerificationRunPage> {
		await this.projects.load(projectId);
		const limit = options.limit ?? 25;
		if (
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			(options.kind && !["matrix", "stress"].includes(options.kind))
		)
			throw new ManualProjectError("运行记录分页参数无效。", 422);
		let before: { createdAt: string; id: string } | undefined;
		if (options.cursor) {
			try {
				if (options.cursor.length > 300) throw new Error();
				const value: unknown = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
				if (
					!value ||
					typeof value !== "object" ||
					!("createdAt" in value) ||
					!("id" in value) ||
					typeof value.createdAt !== "string" ||
					typeof value.id !== "string" ||
					!Number.isFinite(Date.parse(value.createdAt))
				)
					throw new Error();
				before = { createdAt: value.createdAt, id: value.id };
			} catch {
				throw new ManualProjectError("运行记录分页参数无效。", 422);
			}
		}
		const rows = await this.database.sql.all<{ body: VerificationRun }>(
			`SELECT body FROM documents WHERE kind='verification-run' AND body->>'projectId'=$1
			 AND ($2::text IS NULL OR body->'options'->>'kind'=$2)
			 AND ($3::text IS NULL OR body->>'taskId'=$3)
			 AND ($4::text IS NULL OR (body->>'createdAt',id)<($4,$5))
			 ORDER BY body->>'createdAt' DESC,id DESC LIMIT $6`,
			[
				projectId,
				options.kind ?? null,
				options.taskId ?? null,
				before?.createdAt ?? null,
				before?.id ?? null,
				limit + 1,
			],
		);
		const runs = rows.slice(0, limit).map(({ body }) => this.summary(body));
		const last = runs.at(-1);
		return {
			runs,
			nextCursor:
				rows.length > limit && last
					? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url")
					: undefined,
		};
	}
	async validate(projectId: string, options: VerificationOptions): Promise<void> {
		const project = await this.projects.get(projectId);
		const solutions = projectSolutions(project);
		const cases = this.cases(project);
		const subtasks =
			project.judgingMode === "interactive" && project.interactionInputMode === "empty"
				? [{ id: 1, score: 100, type: "min" }]
				: project.subtasks;
		if (
			!subtasks.length ||
			new Set(subtasks.map((item) => item.id)).size !== subtasks.length ||
			subtasks.some((item) => item.id < 1 || item.score < 0 || item.score > 100) ||
			subtasks.reduce((total, item) => total + item.score, 0) !== 100 ||
			cases.some((item) => !subtasks.some((subtask) => subtask.id === item.subtaskId))
		)
			throw new ManualProjectError("请先配置有效子任务，分值合计须为 100，所有测试点须属于有效子任务。", 422);
		if (cases.length > this.projects.judgeLimits.maxTestCases)
			throw new ManualProjectError("测试点数量超过当前沙箱上限。", 422);
		if (options.solutionIds?.some((id) => !solutions.some((item) => item.id === id)))
			throw new ManualProjectError("所选解法不存在。", 422);
		if (options.kind === "stress") {
			if (project.judgingMode === "interactive")
				throw new ManualProjectError("交互题请使用验证矩阵；随机对拍暂不支持。", 422);
			if (
				!solutions.some((item) => item.id === options.baselineId && item.code.trim()) ||
				!project.generatorSource.trim()
			)
				throw new ManualProjectError("请填写基准程序和生成器。", 422);
		} else if (options.caseIds?.some((id) => !this.cases(project).some((item) => key(item) === id)))
			throw new ManualProjectError("所选测试点不存在。", 422);
	}
	private cases(project: ManualProjectSnapshot): ManualCaseSummary[] {
		return project.judgingMode === "interactive" && project.interactionInputMode === "empty"
			? [
					{
						id: "interactive-empty",
						origin: "manual",
						inputFile: "interactive-empty.in",
						inputBytes: 0,
						subtaskId: 1,
					},
				]
			: project.cases;
	}
	async execute(
		projectId: string,
		options: VerificationOptions,
		context?: ExecutionContext,
		replayOf?: string,
	): Promise<VerificationRun> {
		const unlock = await this.projects.lock(projectId, context);
		try {
			return await this.executeLocked(await this.projects.get(projectId), options, context, replayOf);
		} finally {
			unlock();
		}
	}

	/** Caller owns the project lock, including when the publisher runs required solutions. */
	async executeLocked(
		current: ManualProjectSnapshot,
		options: VerificationOptions,
		context?: ExecutionContext,
		replayOf?: string,
	): Promise<VerificationRun> {
		let project = current;
		let original: VerificationRun | undefined;
		if (replayOf) {
			original = await this.get(current.id, replayOf);
			if (original.stress?.reason !== "counterexample" || original.options.kind !== "stress")
				throw new ManualProjectError("此记录没有可重放的反例。", 422);
			project = readProjectSnapshot(
				JSON.parse(
					(await this.database.readBuffer("verification-file", original.id, "project.json")).toString("utf8"),
				),
			);
			options = original.options;
		} else await this.validate(current.id, options);
		const allCases = this.cases(project);
		const selectedCases =
			options.kind === "matrix"
				? allCases.filter((item) => !options.caseIds || options.caseIds.includes(key(item)))
				: [];
		const solutions = projectSolutions(project).filter(
			(item) => !options.solutionIds || options.solutionIds.includes(item.id),
		);
		if (options.kind === "matrix" && (!selectedCases.length || selectedCases.length * solutions.length > 10000))
			throw new ManualProjectError("请选择测试数据，单次矩阵最多 10000 个单元。", 422);
		const primaryId = options.kind === "stress" ? options.baselineId : (project.referenceSolutionId ?? "reference");
		const primary = projectSolutions(project).find((item) => item.id === primaryId);
		if (!primary?.code.trim()) throw new ManualProjectError("请填写主标程。", 422);
		const image = (
			await promisify(execFile)(
				"docker",
				["image", "inspect", "--format", "{{.Id}}", original?.image ?? this.projects.image],
				{ timeout: 15000, signal: context?.signal },
			)
		).stdout.trim();
		if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new ManualProjectError("无法固定沙箱镜像版本。", 503);
		const run: VerificationRun = {
			id: randomUUID(),
			taskId: context?.id,
			projectId: current.id,
			revision: project.revision,
			fingerprint: "",
			image,
			sandboxArgs: original?.sandboxArgs ?? sandboxRuntimeArgs(),
			createdAt: new Date().toISOString(),
			state: "running",
			options,
			solutions,
			replayOf,
		};
		const stage = await mkdtemp(join(this.projects.projectDirectory(current.id), ".matrix-"));
		const started = Date.now();
		const subtasks =
			project.judgingMode === "interactive" && project.interactionInputMode === "empty"
				? [{ id: 1, score: 100, type: "min" as const }]
				: project.subtasks;
		const weights = allocateCaseScores(subtasks, allCases);
		if (options.kind === "matrix")
			run.matrix = {
				cases: selectedCases,
				cells: [],
				solutions: [],
				full: selectedCases.length === allCases.length,
				requiredPassed: false,
			};
		run.checks = [];
		run.progress = {
			completed: 0,
			total: options.kind === "matrix" ? selectedCases.length * solutions.length : options.rounds,
			message: "准备运行",
			elapsedMs: 0,
		};
		let pendingCells: MatrixCell[] = [],
			pendingChecks: ManualCheck[] = [];
		let sequence = 0;
		const checkpoints = new RunCheckpoints(async () => {
			updateSummaries();
			const chunk = { projectId: run.projectId, runId: run.id, cells: pendingCells, checks: pendingChecks };
			pendingCells = [];
			pendingChecks = [];
			const summary = this.summary(structuredClone(run));
			await this.database.transaction(async () => {
				await this.database.put("verification-progress", `${run.id}:${String(sequence++).padStart(8, "0")}`, chunk);
				await this.database.put("verification-run", run.id, summary);
			});
		});
		const updateSummaries = () => {
			if (!run.matrix) return;
			run.matrix.solutions = solutions.map((solution, index) => ({
				...evaluateSolution(
					solution,
					run.matrix!.cells.filter((cell) => cell.solutionId === solution.id),
					selectedCases.length,
					aggregateScore(
						subtasks,
						allCases,
						run.matrix!.cells.filter((cell) => cell.solutionId === solution.id),
					),
					run.matrix!.full,
				),
				compile: run.checks?.find(
					(check) =>
						check.stage === `compile:candidate${index}` ||
						(solution.id === primaryId && check.stage === "compile:reference"),
				),
			}));
		};
		let diagnosticFiles: WorkspaceFile[] | undefined;
		const diagnostics = async () => {
			const files = await collectRunDiagnostics(
				stage,
				run,
				this.projects.maxFileBytes,
				this.projects.maxProjectBytes,
			);
			run.diagnostics = true;
			diagnosticFiles = files;
			return files;
		};
		try {
			const files: WorkspaceFile[] = [
				{
					ownerKind: "verification-file",
					ownerId: run.id,
					name: "project.json",
					source: { bytes: Buffer.from(JSON.stringify(project)) },
				},
			];
			const cases: SandboxCase[] = [];
			for (const [index, item] of selectedCases.entries()) {
				const empty = project.judgingMode === "interactive" && project.interactionInputMode === "empty";
				const inputPath = empty
					? join(stage, "empty.in")
					: await this.projects.dataFile(current.id, item.origin, item.inputFile);
				if (empty) await writeFile(inputPath, "");
				const outputPath =
					project.judgingMode !== "interactive" && item.outputFile
						? await this.projects.dataFile(current.id, item.origin, item.outputFile)
						: undefined;
				cases.push({ id: key(item), inputPath, outputPath, outputName: `${index}.out` });
				files.push({
					ownerKind: "verification-file",
					ownerId: run.id,
					name: `cases/${index}.in`,
					source: { path: inputPath },
				});
				if (outputPath)
					files.push({
						ownerKind: "verification-file",
						ownerId: run.id,
						name: `cases/${index}.out`,
						source: { path: outputPath },
					});
			}
			await this.database.commitFiles(files, () => this.database.put("verification-run", run.id, this.summary(run)));
			run.fingerprint = digest({
				project,
				options,
				image,
				files: await this.database.fileEntries("verification-file", run.id),
			});
			await this.save(run);
			context?.emit("stage", "运行解法验证", { runId: run.id });
			const result = await runSolutionSandbox({
				onProgress: ({ cell, check }) => {
					if (cell && run.matrix) {
						if (
							!solutions.some((item) => item.id === cell.solutionId) ||
							!selectedCases.some((item) => key(item) === cell.caseId)
						)
							throw new Error("沙箱返回未知测试点或解法。");
						const value = {
							...cell,
							fullPoints: weights.get(cell.caseId) ?? 0,
							points: Math.floor((weights.get(cell.caseId) ?? 0) * (cell.scoreRatio ?? cell.score / 100)),
						};
						const index = run.matrix.cells.findIndex(
							(item) => item.caseId === cell.caseId && item.solutionId === cell.solutionId,
						);
						if (index < 0) run.matrix.cells.push(value);
						else run.matrix.cells[index] = value;
						pendingCells.push(value);
						run.progress!.completed = run.matrix.cells.length;
					}
					if (check) {
						run.checks!.push(check);
						pendingChecks.push(check);
						if (check.stage === "stress-round") run.progress!.completed++;
					}
					run.progress!.message = cell ? `${cell.caseId} · ${cell.verdict}` : (check?.message ?? "运行中");
					run.progress!.elapsedMs = Date.now() - started;
					checkpoints.schedule();
				},
				mode: "finalize",
				sandboxArgs: run.sandboxArgs,
				context,
				stage,
				image,
				reference: primary,
				primaryId,
				solutions,
				interactor:
					project.judgingMode === "interactive"
						? { language: project.interactorStandard ?? "cpp17", code: project.interactorSource ?? "" }
						: undefined,
				generator: options.kind === "stress" ? project.generatorSource : undefined,
				generatorStandard: project.generatorStandard,
				checker: effectiveChecker(project.checkerMode, project.checkerSource),
				checkerStandard: project.checkerStandard,
				validator:
					project.interactionInputMode === "empty" && project.judgingMode === "interactive"
						? undefined
						: project.validatorSource,
				validatorStandard: project.validatorStandard,
				cases,
				maxFileBytes: this.projects.maxFileBytes,
				...this.projects.pipeline.limits(project),
				stress:
					options.kind === "stress" ? { ...options, args: parseGeneratorScript(options.command)[0] } : undefined,
				replay: original
					? {
							inputPath: (await this.database.filePath("verification-file", original.id, "counterexample.in"))!,
							seed: original.stress?.seed ?? 0,
							args: original.stress?.args ?? [],
						}
					: undefined,
			});
			await checkpoints.stop();
			run.checks = result.checks;
			context?.signal.throwIfAborted();
			if (options.kind === "matrix") {
				const full = selectedCases.length === allCases.length;
				const subtasks =
					project.judgingMode === "interactive" && project.interactionInputMode === "empty"
						? [{ id: 1, score: 100, type: "min" as const }]
						: project.subtasks;
				const summaries = solutions.map((solution, index) => {
					const cells = result.cells.filter((item) => item.solutionId === solution.id);
					if (
						new Set(cells.map((item) => item.caseId)).size !== cells.length ||
						cells.some((item) => !selectedCases.some((test) => key(test) === item.caseId))
					)
						throw new Error("沙箱返回重复或未知测试点。");
					return {
						...evaluateSolution(
							solution,
							cells,
							selectedCases.length,
							aggregateScore(subtasks, allCases, cells),
							full,
						),
						compile: result.checks.find((item) => item.stage === `compile:candidate${index}`),
					};
				});
				const weights = allocateCaseScores(subtasks, allCases);
				run.matrix = {
					cases: selectedCases,
					cells: result.cells.map((cell) => ({
						...cell,
						fullPoints: weights.get(cell.caseId) ?? 0,
						points: Math.floor((weights.get(cell.caseId) ?? 0) * (cell.scoreRatio ?? cell.score / 100)),
					})),
					solutions: summaries,
					full,
					requiredPassed:
						full &&
						projectSolutions(project)
							.filter((item) => item.required)
							.every((item) => summaries.some((summary) => summary.solutionId === item.id && summary.matches)),
				};
			} else {
				if (!result.stress) throw new Error("沙箱没有返回对拍结果。");
				run.stress = result.stress;
			}
			const infrastructureError = result.checks.find((item) => item.stage === "verification-system" && !item.passed);
			run.error = result.stress?.reason === "error" ? result.stress.message : infrastructureError?.message;
			run.state = run.error ? "failed" : "complete";
			run.finishedAt = new Date().toISOString();
			run.progress!.elapsedMs = Date.now() - started;
			run.progress!.message = run.error ?? "执行完成";
			const artifacts: WorkspaceFile[] = [];
			if (run.stress?.reason === "counterexample") {
				const safe = join(stage, "export");
				await mkdir(safe);
				const budget = { remainingBytes: this.projects.maxProjectBytes };
				const archiveFiles = new Map<string, string>();
				for (const name of [
					"counterexample.in",
					"counterexample.out",
					"runner.py",
					"payload.json",
					...solutions.map((_item, index) => `outputs/candidate${index}-stress.out`),
				]) {
					const destination = join(safe, name);
					await mkdir(join(destination, ".."), { recursive: true });
					await copySandboxFile(stage, name, destination, this.projects.maxFileBytes, budget, context?.signal);
					artifacts.push({ ownerKind: "verification-file", ownerId: run.id, name, source: { path: destination } });
					archiveFiles.set(name, destination);
				}
				const payload = JSON.parse(await readFile(join(safe, "payload.json"), "utf8")) as Record<string, unknown>;
				payload.replay = { seed: run.stress.seed, args: run.stress.args };
				await writeFile(join(safe, "payload.json"), JSON.stringify(payload));
				await writeFile(join(safe, "project.json"), JSON.stringify(project, null, 2));
				await writeFile(join(safe, "run.json"), JSON.stringify(run, null, 2));
				await writeFile(
					join(safe, "reproduce.sh"),
					`#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec docker run --rm ${run.sandboxArgs!.join(" ")} --mount "type=bind,source=$PWD,target=/work" --entrypoint python3 ${image} /work/runner.py\n`,
				);
				for (const name of ["project.json", "run.json", "reproduce.sh"]) archiveFiles.set(name, join(safe, name));
				await writeStoredArchiveFromFiles(join(safe, "reproduction.zip"), "setdraft-reproduction", archiveFiles);
				artifacts.push({
					ownerKind: "verification-file",
					ownerId: run.id,
					name: "reproduction.zip",
					source: { path: join(safe, "reproduction.zip") },
				});
			}
			artifacts.push(...(await diagnostics()));
			await this.save(run, artifacts, context);
			return run;
		} catch (error) {
			await checkpoints.stop().catch(() => {});
			const cause: unknown = context?.signal.aborted ? context.signal.reason : error;
			run.state =
				context?.signal.aborted && cause instanceof Error && cause.name === "AbortError" ? "cancelled" : "failed";
			if (run.matrix) run.matrix.requiredPassed = false;
			run.error =
				run.state === "cancelled" ? "任务已取消或中断。" : cause instanceof Error ? cause.message : String(cause);
			run.finishedAt = new Date().toISOString();
			run.progress!.elapsedMs = Date.now() - started;
			run.progress!.message = run.error;
			updateSummaries();
			const files =
				diagnosticFiles ?? (!(error instanceof SandboxCleanupError) ? await diagnostics().catch(() => []) : []);
			await this.save(run, files);
			throw error;
		} finally {
			await cleanupSandboxStage(stage);
		}
	}

	async diagnosticFile(projectId: string, id: string, name?: string): Promise<string> {
		await this.get(projectId, id);
		if (name && !/^(logs|outputs|answers|cases)\/[A-Za-z0-9_.:-]+$/u.test(name))
			throw new ManualProjectError("诊断文件路径无效。", 422);
		const path = await this.database.filePath(
			"verification-file",
			id,
			name ? `diagnostics/${name}` : "diagnostics.zip",
		);
		if (!path) throw new ManualProjectError("诊断文件尚未生成或此旧记录未保留完整日志。", 404);
		return path;
	}
	async cell(projectId: string, id: string, solutionId: string, caseId: string): Promise<MatrixDiagnostic> {
		const run = await this.get(projectId, id);
		const cell = [...(run.matrix?.cells ?? []), ...(run.stress?.cells ?? [])].find(
			(item) => item.solutionId === solutionId && item.caseId === caseId,
		);
		if (!cell) throw new ManualProjectError("判定详情不存在。", 404);
		let actual = cell.output,
			expected = cell.expected;
		const previewOnly = !run.diagnostics || !cell.artifacts?.output || !cell.artifacts?.expected;
		if (!previewOnly) {
			actual = (
				await this.database.readBuffer("verification-file", id, `diagnostics/${cell.artifacts!.output}`)
			).toString("utf8");
			expected = (
				await this.database.readBuffer("verification-file", id, `diagnostics/${cell.artifacts!.expected}`)
			).toString("utf8");
		}
		if (run.diagnostics && cell.artifacts) {
			const logs = await Promise.all(
				cell.artifacts.logs.map(async (name) =>
					readTextPreview((await this.database.filePath("verification-file", id, `diagnostics/${name}`))!),
				),
			);
			cell.log = logs
				.filter((text) => text.trim())
				.join("\n\n")
				.slice(0, 8000);
			cell.output = actual?.slice(0, 2048);
			cell.expected = expected?.slice(0, 2048);
		}
		return {
			cell,
			difference:
				actual !== undefined && expected !== undefined ? firstOutputDifference(actual, expected) : undefined,
			previewOnly,
		};
	}

	async required(project: ManualProject, context?: ExecutionContext): Promise<VerificationRun> {
		return this.executeLocked(
			{ ...project, ...(await this.projects.caseList(project)) },
			{
				kind: "matrix",
				solutionIds: projectSolutions(project)
					.filter((item) => item.required)
					.map((item) => item.id),
			},
			context,
		);
	}
	async archive(projectId: string, id: string): Promise<string> {
		await this.get(projectId, id);
		const path = await this.database.filePath("verification-file", id, "reproduction.zip");
		if (!path) throw new ManualProjectError("此记录没有反例复现包。", 404);
		return path;
	}
	async importCase(projectId: string, id: string, input: Record<string, unknown>): Promise<ManualProjectSnapshot> {
		const unlock = await this.projects.lock(projectId);
		try {
			const run = await this.get(projectId, id);
			if (run.stress?.reason !== "counterexample") throw new ManualProjectError("此记录没有反例。", 422);
			if (run.importedCase) throw new ManualProjectError(`此反例已加入 ${run.importedCase}。`, 409);
			const project = await this.projects.load(projectId);
			if (!Number.isSafeInteger(input.expectedRevision)) throw new ManualProjectError("请提供当前题目版本。", 422);
			if (input.expectedRevision !== project.revision)
				throw new ManualProjectError("题目版本已变化，请重新预览。", 409);
			if (project.judgingMode === "interactive") throw new ManualProjectError("不能将非交互反例加入交互题。", 422);
			if (!project.subtasks.some((item) => item.id === input.subtaskId))
				throw new ManualProjectError("请选择有效子任务。", 422);
			const name = typeof input.name === "string" ? input.name.trim() : `stress-${id.slice(0, 8)}.in`;
			const { stem, extension } = dataStem(name);
			if (extension !== "in" || name.length > 254) throw new ManualProjectError("请输入有效的 .in 文件名。", 422);
			const { cases, orphanOutputs } = await this.projects.caseList(project);
			if (cases.some((item) => item.id === stem) || orphanOutputs.some((item) => dataStem(item).stem === stem))
				throw new ManualProjectError("测试点名称已存在。", 409);
			if (cases.length >= this.projects.judgeLimits.maxTestCases)
				throw new ManualProjectError("测试点已达上限。", 422);
			const entries = (await this.database.fileEntries("verification-file", id)).filter((item) =>
				["counterexample.in", "counterexample.out"].includes(item.name),
			);
			if (
				entries.length !== 2 ||
				entries.some((item) => item.size > this.projects.maxFileBytes) ||
				entries.reduce((sum, item) => sum + item.size, await this.projects.projectDataBytes(projectId)) >
					this.projects.maxProjectBytes
			)
				throw new ManualProjectError("反例文件缺失或超过容量上限。", 422);
			project.caseSubtasks[`manual:${stem}`] = Number(input.subtaskId);
			project.revision++;
			project.updatedAt = new Date().toISOString();
			project.lastReport = undefined;
			run.importedCase = name;
			await this.database.commitFiles(
				await Promise.all(
					entries.map(
						async (item): Promise<WorkspaceFile> => ({
							ownerKind: "manual",
							ownerId: projectId,
							name: `${stem}.${item.name.endsWith(".in") ? "in" : "out"}`,
							source: { path: (await this.database.filePath("verification-file", id, item.name))! },
						}),
					),
				),
				async () => {
					await this.projects.save(project);
					await this.database.put("verification-run", id, this.summary(run));
				},
			);
			return this.projects.snapshot(projectId);
		} finally {
			unlock();
		}
	}
}
