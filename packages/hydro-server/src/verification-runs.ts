import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	aggregateScore,
	allocateCaseScores,
	evaluateSolution,
	isCompleteCommunicationResult,
	type ManualCaseSummary,
	type ManualCheck,
	type ManualProject,
	type ManualProjectSnapshot,
	type MatrixCell,
	type MatrixDiagnostic,
	projectSolutions,
	resolveProblemType,
	type VerificationOptions,
	type VerificationRun,
	type VerificationRunPage,
	verificationContractVersion,
} from "@setdraft/contracts";
import { effectiveChecker } from "./acm-checker.ts";
import type { ExecutionContext } from "./execution-context.ts";
import type { ManualProjectStore } from "./manual-projects.ts";
import type { SandboxCase, SandboxCompilationCache } from "./manual-sandbox.ts";
import { ManualProjectError } from "./project-error.ts";
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
	if (input.kind === "stress") throw new ManualProjectError("随机对拍已停用，旧记录仍可查看和下载。", 410);
	if (input.kind !== "matrix" && input.kind !== "pressure") throw new ManualProjectError("运行类型无效。", 422);
	if (input.kind === "pressure" && input.caseIds !== undefined)
		throw new ManualProjectError("压力测试必须覆盖完整数据集，不能抽样。", 422);
	return { kind: input.kind, solutionIds: ids(input.solutionIds), caseIds: ids(input.caseIds) };
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
			(options.kind && !["matrix", "pressure", "stress"].includes(options.kind))
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
		if (options.kind === "stress") throw new ManualProjectError("随机对拍已停用。", 410);
		if (options.kind === "pressure") {
			if (options.caseIds !== undefined) throw new ManualProjectError("压力测试必须覆盖完整数据集，不能抽样。", 422);
			const selected = solutions.filter((item) =>
				options.solutionIds ? options.solutionIds.includes(item.id) : item.expectation.kind !== "AC",
			);
			if (
				!selected.length ||
				selected.some((item) => item.expectation.kind === "AC" || item.id === project.referenceSolutionId)
			)
				throw new ManualProjectError("请选择设置了 WA、TLE、MLE、RE 或分数区间预期的错误解。", 422);
		}
		if (options.caseIds?.some((id) => !cases.some((item) => key(item) === id)))
			throw new ManualProjectError("所选测试点不存在。", 422);
		if (
			cases.some((item) => item.origin === "generated") &&
			project.generatedFromHash !==
				(await this.projects.pipeline.generatedHash(
					projectId,
					project,
					cases.filter((item) => item.origin === "manual"),
				))
		)
			throw new ManualProjectError("Gen、脚本、标程或手动测试点已修改，请重新生成数据。", 422);
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
		compilationCache?: SandboxCompilationCache,
	): Promise<VerificationRun> {
		if (replayOf) throw new ManualProjectError("随机对拍重放已停用，旧记录仍可查看和下载。", 410);
		await this.validate(current.id, options);
		if (options.kind === "stress") throw new ManualProjectError("随机对拍已停用。", 410);
		const project = current;
		const allCases = this.cases(project);
		const selectedCases = allCases.filter((item) => !options.caseIds || options.caseIds.includes(key(item)));
		const solutions = projectSolutions(project).filter((item) =>
			options.solutionIds
				? options.solutionIds.includes(item.id)
				: options.kind !== "pressure" || item.expectation.kind !== "AC",
		);
		if (!solutions.length || !selectedCases.length || selectedCases.length * solutions.length > 10000)
			throw new ManualProjectError("请选择测试数据，单次矩阵最多 10000 个单元。", 422);
		const primaryId = project.referenceSolutionId ?? "reference";
		const primary = projectSolutions(project).find((item) => item.id === primaryId);
		if (!primary?.code.trim()) throw new ManualProjectError("请填写主标程。", 422);
		const image =
			compilationCache?.image ??
			(
				await promisify(execFile)("docker", ["image", "inspect", "--format", "{{.Id}}", this.projects.image], {
					timeout: 15000,
					signal: context?.signal,
				})
			).stdout.trim();
		if (!/^sha256:[a-f0-9]{64}$/u.test(image)) throw new ManualProjectError("无法固定沙箱镜像版本。", 503);
		const run: VerificationRun = {
			id: randomUUID(),
			taskId: context?.id,
			projectId: current.id,
			revision: project.revision,
			fingerprint: "",
			image,
			sandboxArgs: sandboxRuntimeArgs(),
			verificationContractVersion,
			problemType: resolveProblemType(project),
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
			total: selectedCases.length * solutions.length,
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
				compilationCache,
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
					resolveProblemType(project) === "interactive"
						? { language: project.interactorStandard ?? "cpp17", code: project.interactorSource ?? "" }
						: undefined,
				communication: resolveProblemType(project) === "communication" ? project.communication : undefined,
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
			});
			await checkpoints.stop();
			if (resolveProblemType(project) === "communication")
				result.cells = result.cells.map((cell) =>
					cell.verdict === "CE" || cell.verdict === "SYSTEM_ERROR" || isCompleteCommunicationResult(cell)
						? cell
						: {
								...cell,
								verdict: "SYSTEM_ERROR",
								score: 0,
								scoreRatio: 0,
								message: "通信轮次结果不完整或不一致。",
							},
				);
			run.checks = result.checks;
			context?.signal.throwIfAborted();
			{
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
			}
			const infrastructureError = result.checks.find((item) => item.stage === "verification-system" && !item.passed);
			run.error = infrastructureError?.message;
			run.state = run.error ? "failed" : "complete";
			run.finishedAt = new Date().toISOString();
			run.progress!.elapsedMs = Date.now() - started;
			run.progress!.message = run.error ?? "执行完成";
			const artifacts = await diagnostics();
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

	async required(
		project: ManualProject,
		context?: ExecutionContext,
		compilationCache?: SandboxCompilationCache,
	): Promise<VerificationRun> {
		return this.executeLocked(
			{ ...project, ...(await this.projects.caseList(project)) },
			{
				kind: "matrix",
				solutionIds: projectSolutions(project)
					.filter((item) => item.required)
					.map((item) => item.id),
			},
			context,
			undefined,
			compilationCache,
		);
	}
	async archive(projectId: string, id: string): Promise<string> {
		await this.get(projectId, id);
		const path = await this.database.filePath("verification-file", id, "reproduction.zip");
		if (!path) throw new ManualProjectError("此记录没有反例复现包。", 404);
		return path;
	}
	async importCase(_projectId: string, _id: string, _input: Record<string, unknown>): Promise<ManualProjectSnapshot> {
		throw new ManualProjectError("随机对拍反例入库已停用；已有测试数据保留。", 410);
	}
}
