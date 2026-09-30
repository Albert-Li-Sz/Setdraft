import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_HYDRO_JUDGE_LIMITS, type HydroJudgeLimits, isSafeFlatName } from "@setdraft/authoring";
import { editableStatementSections, formatHydroStatement } from "@setdraft/authoring/statement";
import {
	type AddedManualCase,
	type CppLanguage,
	cppLanguages,
	type ManualCaseSummary,
	type ManualProgram,
	type ManualProject,
	type ManualProjectSnapshot,
	type ManualRelease,
	type ManualSubtask,
} from "@setdraft/contracts";
import type { ExecutionContext } from "./execution-context.ts";
import { ManualProjectError } from "./project-error.ts";
import { caseOrder, dataStem, hashFile } from "./project-files.ts";
import { ProjectPipeline } from "./project-pipeline.ts";
import { ReleaseStore } from "./releases.ts";
import { WorkspaceDatabase } from "./workspace-db.ts";

export type {
	AddedManualCase,
	HistoricHydroVerification,
	ManualCaseSummary,
	ManualProject,
	ManualProjectSnapshot,
	ManualRelease,
	ManualSubtask,
	ManualVerificationReport,
} from "@setdraft/contracts";
export { parseGeneratorScript } from "./project-files.ts";

const projectIdPattern = /^[a-f0-9-]{36}$/;
const defaultMaxFileBytes = 64 * 1024 * 1024;
const defaultMaxProjectBytes = 512 * 1024 * 1024;
const maxTextCaseBytes = 1024 * 1024;

export { ManualProjectError } from "./project-error.ts";

function assertProjectId(id: string): void {
	if (!projectIdPattern.test(id)) throw new ManualProjectError("项目 ID 无效。", 404);
}

function assertReleaseId(id: string): void {
	if (!projectIdPattern.test(id)) throw new ManualProjectError("发布记录 ID 无效。", 404);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ManualProjectError(`${label} 必须是对象。`);
	}
	return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || value.length > maximum) {
		throw new ManualProjectError(`${label} 必须是长度不超过 ${maximum} 的文本。`);
	}
	return value;
}

function readProgram(value: unknown, label: string): ManualProgram {
	const item = record(value, label);
	if (
		!cppLanguages.some((language) => language === item.language) &&
		item.language !== "python3" &&
		item.language !== "java"
	) {
		throw new ManualProjectError(`${label} 的语言必须是受支持的 C++ 标准、Python 3 或 Java。`);
	}
	return {
		language: item.language as ManualProgram["language"],
		code: boundedString(item.code, `${label}.code`, 200_000),
	};
}

function readCppLanguage(value: unknown, label: string): CppLanguage {
	if (!cppLanguages.some((language) => language === value)) {
		throw new ManualProjectError(`${label} 必须是 C++11、14、17、20、23 或 26。`);
	}
	return value as CppLanguage;
}

export interface ManualProjectStoreOptions {
	root: string;
	database?: WorkspaceDatabase;
	image?: string;
	judgeLimits?: HydroJudgeLimits;
	maxFileBytes?: number;
	maxProjectBytes?: number;
}

export class ManualProjectStore {
	readonly pipeline: ProjectPipeline;
	readonly releases: ReleaseStore;
	readonly root: string;
	readonly database: WorkspaceDatabase;
	readonly image: string;
	readonly judgeLimits: HydroJudgeLimits;
	readonly maxFileBytes: number;
	readonly maxProjectBytes: number;
	private readonly busy = new Set<string>();
	private readonly documentVersions = new WeakMap<object, number>();

	constructor(options: ManualProjectStoreOptions) {
		this.root = resolve(options.root);
		this.database = options.database ?? new WorkspaceDatabase(this.root);
		if (this.database.root !== this.root) throw new Error("Workspace database root must match the project root.");
		this.image = options.image ?? "setdraft/sandbox:local";
		this.judgeLimits = options.judgeLimits ?? DEFAULT_HYDRO_JUDGE_LIMITS;
		this.maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes;
		this.maxProjectBytes = options.maxProjectBytes ?? defaultMaxProjectBytes;
		if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1)
			throw new Error("maxFileBytes must be a positive integer.");
		if (!Number.isSafeInteger(this.maxProjectBytes) || this.maxProjectBytes < this.maxFileBytes) {
			throw new Error("maxProjectBytes must be an integer at least as large as maxFileBytes.");
		}
		this.pipeline = new ProjectPipeline(this);
		this.releases = new ReleaseStore(this);
	}

	projectDirectory(id: string): string {
		assertProjectId(id);
		return join(this.root, "projects", id);
	}

	releaseDirectory(id: string): string {
		assertReleaseId(id);
		return join(this.root, "releases", id);
	}

	async dataFile(id: string, origin: "manual" | "generated", name: string): Promise<string> {
		const path = await this.database.filePath(origin, id, name);
		if (!path) throw new ManualProjectError(`测试文件 ${name} 不存在于数据索引。`, 404);
		return path;
	}

	async create(scoringMode: "acm" | "oi"): Promise<ManualProjectSnapshot> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const project: ManualProject = {
			id,
			scoringMode,
			judgingMode: "default",
			interactionInputMode: "provided",
			interactorSource: "",
			interactorStandard: "cpp17",
			revision: 0,
			createdAt: now,
			updatedAt: now,
			slug: "",
			title: "",
			tags: [],
			statement: "",
			statementSections: editableStatementSections({ statement: "" }),
			samples: [],
			timeLimit: "1s",
			memoryLimit: "256m",
			reference: { language: "cpp17", code: "" },
			generatorSource: "",
			generatorStandard: "cpp17",
			generatorScript: "",
			checkerSource: "",
			checkerMode: "text",
			checkerStandard: "cpp17",
			validatorSource: "",
			validatorStandard: "cpp17",
			subtasks: [{ id: 1, type: scoringMode === "acm" ? "min" : "sum", score: 100 }],
			caseSubtasks: {},
			attachments: [],
		};
		const directory = this.projectDirectory(id);
		await mkdir(join(directory, "manual"), { recursive: true });
		await this.save(project);
		return await this.get(id);
	}

	async load(id: string): Promise<ManualProject> {
		try {
			const document = await this.database.getVersioned<ManualProject>("project", id);
			if (!document) throw new ManualProjectError("项目不存在。", 404);
			const { value: stored, version } = document;
			const project = {
				...stored,
				scoringMode: stored.scoringMode ?? "oi",
				judgingMode: stored.judgingMode ?? "default",
				interactionInputMode: stored.interactionInputMode ?? "provided",
				interactorSource: stored.interactorSource ?? "",
				interactorStandard: stored.interactorStandard ?? "cpp17",
				checkerMode: stored.checkerMode ?? (stored.checkerSource.trim() ? "custom" : "text"),
				generatorStandard: stored.generatorStandard ?? "cpp17",
				checkerStandard: stored.checkerStandard ?? "cpp17",
				validatorStandard: stored.validatorStandard ?? "cpp17",
			};
			if (version !== undefined) this.documentVersions.set(project, version);
			return project;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError("项目不存在。", 404);
			throw error;
		}
	}

	async save(project: ManualProject, context?: ExecutionContext): Promise<void> {
		const knownVersion = this.documentVersions.get(project);
		const expectedVersion = knownVersion ?? (await this.database.version("project", project.id)) ?? -1;
		try {
			await this.database.transaction(async () => {
				context?.signal.throwIfAborted();
				await this.assertTaskAccess(project.id, context);
				await this.database.put("project", project.id, project, expectedVersion);
			});
		} catch (error) {
			if (String(error).includes("VERSION_CONFLICT")) {
				throw new ManualProjectError(
					"题目版本已变化，请检查最新内容后重试。",
					409,
					await this.snapshot(project.id),
				);
			}
			throw error;
		}
		this.documentVersions.set(project, expectedVersion + 1);
	}

	private async assertExpectedRevision(project: ManualProject, expectedRevision?: number): Promise<void> {
		if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
			throw new ManualProjectError("题目版本无效。", 422);
		}
		if (expectedRevision !== undefined && expectedRevision !== project.revision) {
			throw new ManualProjectError("题目版本已变化，请检查最新内容后重试。", 409, await this.snapshot(project.id));
		}
	}

	async caseList(project: ManualProject): Promise<{ cases: ManualCaseSummary[]; orphanOutputs: string[] }> {
		const cases: ManualCaseSummary[] = [];
		const orphanOutputs: string[] = [];
		for (const origin of ["manual", "generated"] as const) {
			const files = await this.database.fileEntries(origin, project.id);
			const byName = new Map(files.map((item) => [item.name, item.size]));
			for (const file of files) {
				const { stem, extension } = dataStem(file.name);
				if (extension !== "in") {
					if (!byName.has(`${stem}.in`)) orphanOutputs.push(file.name);
					continue;
				}
				const outputFile = byName.has(`${stem}.out`)
					? `${stem}.out`
					: byName.has(`${stem}.ans`)
						? `${stem}.ans`
						: undefined;
				if (byName.has(`${stem}.out`) && byName.has(`${stem}.ans`)) {
					throw new ManualProjectError(`${stem} 同时存在 .out 与 .ans，请删除其中一个。`);
				}
				cases.push({
					id: stem,
					origin,
					inputFile: file.name,
					outputFile,
					inputBytes: file.size,
					outputBytes: outputFile ? byName.get(outputFile) : undefined,
					subtaskId: project.caseSubtasks[`${origin}:${stem}`] ?? 1,
				});
			}
		}
		return { cases: cases.sort(caseOrder), orphanOutputs };
	}

	async get(id: string): Promise<ManualProjectSnapshot> {
		return await this.snapshot(id);
	}

	async snapshot(id: string): Promise<ManualProjectSnapshot> {
		const project = await this.load(id);
		return { ...project, ...(await this.caseList(project)) };
	}

	async list(): Promise<ManualProjectSnapshot[]> {
		const ids = (await this.database.list<ManualProject>("project")).map((item) => item.id);
		return (await Promise.all(ids.map(async (id) => await this.get(id)))).sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	async update(id: string, value: unknown): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		const project = await this.load(id);
		const previousStatement = JSON.stringify([project.statement, project.statementSections, project.samples]);
		const input = record(value, "题目");
		if (input.expectedRevision !== undefined && input.expectedRevision !== project.revision) {
			throw new ManualProjectError("题目版本已变化，请检查最新内容后重试。", 409, await this.get(id));
		}
		if (input.scoringMode !== undefined && input.scoringMode !== project.scoringMode) {
			throw new ManualProjectError("题目赛制在创建后不可更改；请新建题目。", 422);
		}
		for (const field of ["judgingMode", "interactionInputMode", "interactorSource", "interactorStandard"] as const) {
			if (input[field] !== undefined && input[field] !== project[field]) project.lastReport = undefined;
		}
		if (input.judgingMode !== undefined) {
			if (input.judgingMode !== "default" && input.judgingMode !== "interactive")
				throw new ManualProjectError("判题模式无效。", 422);
			project.judgingMode = input.judgingMode;
		}
		if (input.interactionInputMode !== undefined) {
			if (input.interactionInputMode !== "provided" && input.interactionInputMode !== "empty")
				throw new ManualProjectError("交互题输入模式无效。", 422);
			project.interactionInputMode = input.interactionInputMode;
		}
		const fields = [
			"slug",
			"title",
			"statement",
			"timeLimit",
			"memoryLimit",
			"generatorSource",
			"generatorScript",
			"checkerSource",
			"validatorSource",
			"interactorSource",
		] as const;
		for (const field of fields) {
			if (field === "statement" && input.statementSections !== undefined) continue;
			if (input[field] !== undefined)
				project[field] = boundedString(input[field], field, field === "statement" ? 1_000_000 : 200_000);
		}
		if (input.statementSections !== undefined) {
			const sections = record(input.statementSections, "题面分栏");
			project.statementSections = {
				description: boundedString(sections.description, "描述", 1_000_000),
				input: boundedString(sections.input, "输入", 1_000_000),
				output: boundedString(sections.output, "输出", 1_000_000),
				interaction: boundedString(sections.interaction, "交互描述", 1_000_000),
				notes: boundedString(sections.notes, "提示", 1_000_000),
			};
			if (Object.values(project.statementSections).reduce((size, text) => size + text.length, 0) > 1_000_000)
				throw new ManualProjectError("题面分栏合计不能超过 1000000 字符。", 422);
		} else if (input.statement !== undefined) {
			project.statementSections = undefined;
		}
		for (const field of [
			"generatorStandard",
			"checkerStandard",
			"validatorStandard",
			"interactorStandard",
		] as const) {
			if (input[field] !== undefined) project[field] = readCppLanguage(input[field], field);
		}
		if (input.checkerMode !== undefined) {
			if (input.checkerMode !== "text" && input.checkerMode !== "custom") {
				throw new ManualProjectError("Checker 模式无效。");
			}
			project.checkerMode = input.checkerMode;
		}
		if (input.reference !== undefined) project.reference = readProgram(input.reference, "reference");
		if (input.oracle !== undefined)
			project.oracle = input.oracle === null ? undefined : readProgram(input.oracle, "oracle");
		if (input.tags !== undefined) {
			if (!Array.isArray(input.tags) || input.tags.some((tag) => typeof tag !== "string" || tag.length > 100)) {
				throw new ManualProjectError("标签必须是短文本数组。");
			}
			project.tags = input.tags as string[];
		}
		if (input.samples !== undefined) {
			if (!Array.isArray(input.samples) || input.samples.length > 20)
				throw new ManualProjectError("样例最多 20 组。");
			project.samples = input.samples.map((sample, index) => {
				const item = record(sample, `样例 ${index + 1}`);
				return {
					input: boundedString(item.input, "样例输入", 200_000),
					output: boundedString(item.output, "样例输出", 200_000),
				};
			});
		}
		if (input.subtasks !== undefined) {
			if (!Array.isArray(input.subtasks) || input.subtasks.length > 50)
				throw new ManualProjectError("子任务最多 50 个。");
			project.subtasks = input.subtasks.map((subtask, index) => {
				const item = record(subtask, `子任务 ${index + 1}`);
				if (
					!Number.isSafeInteger(item.id) ||
					!Number.isSafeInteger(item.score) ||
					!["sum", "min", "max"].includes(String(item.type))
				) {
					throw new ManualProjectError(`子任务 ${index + 1} 的编号、分值或计分方式无效。`);
				}
				return { id: item.id as number, score: item.score as number, type: item.type as ManualSubtask["type"] };
			});
		}
		if (input.caseSubtasks !== undefined) {
			const assignments = record(input.caseSubtasks, "测试点分组");
			if (Object.keys(assignments).length > 500) throw new ManualProjectError("测试点分组过多。");
			for (const [name, subtaskId] of Object.entries(assignments)) {
				if (!/^(manual|generated):[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || !Number.isSafeInteger(subtaskId)) {
					throw new ManualProjectError("测试点分组无效。");
				}
			}
			project.caseSubtasks = assignments as Record<string, number>;
		}
		if (input.attachments !== undefined) {
			if (!Array.isArray(input.attachments) || input.attachments.length > 20)
				throw new ManualProjectError("附件最多 20 个。");
			project.attachments = input.attachments.map((attachment, index) => {
				const item = record(attachment, `附件 ${index + 1}`);
				const name = boundedString(item.name, "附件名", 120);
				const contentBase64 = boundedString(item.contentBase64, "附件内容", 1_400_000);
				if (!isSafeFlatName(name) || Buffer.from(contentBase64, "base64").byteLength > 1024 * 1024) {
					throw new ManualProjectError(`附件 ${index + 1} 无效或超过 1 MiB。`);
				}
				return { name, contentBase64 };
			});
		}
		if (project.statementSections) project.statement = formatHydroStatement(project);
		if (JSON.stringify([project.statement, project.statementSections, project.samples]) !== previousStatement)
			project.lastReport = undefined;
		project.revision += 1;
		project.updatedAt = new Date().toISOString();
		await this.save(project);
		return await this.get(id);
	}

	async assertNotBusy(id: string, context?: ExecutionContext): Promise<void> {
		if (this.busy.has(id)) throw new ManualProjectError("项目正在生成或验证，请稍后重试。", 409);
		await this.assertTaskAccess(id, context);
	}

	async lock(id: string, context?: ExecutionContext): Promise<() => void> {
		await this.assertNotBusy(id, context);
		// Another operation can acquire the in-process lock while the task query awaits PostgreSQL.
		if (this.busy.has(id)) throw new ManualProjectError("项目正在生成或验证，请稍后重试。", 409);
		this.busy.add(id);
		return () => this.busy.delete(id);
	}

	private async assertTaskAccess(id: string, context?: ExecutionContext): Promise<void> {
		const running = (await this.database.sql.one("SELECT id FROM tasks WHERE resource=$1 AND state='running'", [
			`project:${id}`,
		])) as { id: string } | undefined;
		if (running && running.id !== context?.id) {
			throw new ManualProjectError("项目正在生成或验证，请稍后重试。", 409);
		}
	}

	async projectDataBytes(id: string): Promise<number> {
		const files = (
			await Promise.all(["manual", "generated"].map(async (kind) => await this.database.fileEntries(kind, id)))
		).flat();
		return files.reduce((sum, file) => sum + file.size, 0);
	}

	async addTextCase(id: string, value: unknown): Promise<AddedManualCase> {
		await this.assertNotBusy(id);
		this.busy.add(id);

		try {
			const project = await this.load(id);
			const request = record(value, "手动测试点");
			await this.assertExpectedRevision(project, request.expectedRevision as number | undefined);
			if (typeof request.input !== "string") throw new ManualProjectError("请输入测试输入文本；无输入题可留空。");
			if (request.output !== undefined && typeof request.output !== "string") {
				throw new ManualProjectError("期望输出必须是文本。");
			}
			if (request.name !== undefined && typeof request.name !== "string") {
				throw new ManualProjectError("测试文件名必须是文本。");
			}
			const input = Buffer.from(request.input, "utf8");
			const output = request.output === undefined ? undefined : Buffer.from(request.output, "utf8");
			if (input.byteLength > maxTextCaseBytes || (output && output.byteLength > maxTextCaseBytes)) {
				throw new ManualProjectError("手动填写的输入和输出各不能超过 1 MiB；更大数据请上传文件。", 413);
			}
			if (input.byteLength > this.maxFileBytes || (output && output.byteLength > this.maxFileBytes)) {
				throw new ManualProjectError(`单个数据文件不能超过 ${this.maxFileBytes} 字节。`, 413);
			}
			const { cases, orphanOutputs } = await this.caseList(project);
			if (cases.length >= this.judgeLimits.maxTestCases) {
				throw new ManualProjectError("测试点已达到评测机上限。", 422);
			}
			const requestedName = (request.name as string | undefined)?.trim() ?? "";
			const nextNumber =
				Math.max(0, ...cases.filter((item) => /^\d+$/u.test(item.id)).map((item) => Number(item.id))) + 1;
			if (!Number.isSafeInteger(nextNumber)) throw new ManualProjectError("测试点编号已超过安全范围。", 422);
			const inputFile = requestedName || `${nextNumber}.in`;
			if (inputFile.length > 254) throw new ManualProjectError("测试文件名不能超过 254 个字符。");
			const { stem, extension } = dataStem(inputFile);
			if (extension !== "in") throw new ManualProjectError("手动测试点文件名必须以 .in 结尾。");
			if (cases.some((item) => item.id === stem) || orphanOutputs.some((name) => dataStem(name).stem === stem)) {
				throw new ManualProjectError(`测试点 ${stem} 已存在，请换一个文件名。`, 409);
			}
			const subtaskId = request.subtaskId ?? project.subtasks[0]?.id;
			if (!Number.isSafeInteger(subtaskId) || !project.subtasks.some((item) => item.id === subtaskId)) {
				throw new ManualProjectError("请选择有效的子任务。", 422);
			}
			if ((await this.projectDataBytes(id)) + input.byteLength + (output?.byteLength ?? 0) > this.maxProjectBytes) {
				throw new ManualProjectError(`项目数据总量不能超过 ${this.maxProjectBytes} 字节。`, 413);
			}
			const outputFile = output === undefined ? undefined : `${stem}.out`;
			project.caseSubtasks[`manual:${stem}`] = subtaskId as number;
			project.revision++;
			project.updatedAt = new Date().toISOString();
			await this.database.commitFiles(
				[
					{ ownerKind: "manual", ownerId: id, name: inputFile, source: { bytes: input } },
					...(outputFile && output !== undefined
						? [{ ownerKind: "manual", ownerId: id, name: outputFile, source: { bytes: output } }]
						: []),
				],
				async () => await this.save(project),
			);
			return { inputFile, outputFile, project: await this.snapshot(id) };
		} finally {
			this.busy.delete(id);
		}
	}

	private async receiveFile(
		id: string,
		request: AsyncIterable<Uint8Array | string>,
	): Promise<{ path: string; size: number }> {
		const directory = this.projectDirectory(id);
		await mkdir(directory, { recursive: true });
		const path = join(directory, `.upload-${randomUUID()}`);
		const file = await open(path, "wx");
		let size = 0;
		let received = false;
		try {
			for await (const raw of request) {
				const bytes = Buffer.from(raw);
				size += bytes.length;
				if (size > this.maxFileBytes)
					throw new ManualProjectError(`单个文件不能超过 ${this.maxFileBytes} 字节。`, 413);
				let offset = 0;
				while (offset < bytes.length) {
					const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
					if (!bytesWritten) throw new Error("文件写入中断。");
					offset += bytesWritten;
				}
			}
			received = true;
			return { path, size };
		} finally {
			await file.close();
			if (!received) await rm(path, { force: true });
		}
	}

	async upload(
		id: string,
		name: string,
		request: AsyncIterable<Uint8Array | string>,
		expectedRevision?: number,
	): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		this.busy.add(id);
		let path: string | undefined;
		try {
			const project = await this.load(id);
			await this.assertExpectedRevision(project, expectedRevision);
			dataStem(name);
			const uploaded = await this.receiveFile(id, request);
			path = uploaded.path;
			const previous =
				(await this.database.fileEntries("manual", id)).find((entry) => entry.name === name)?.size ?? 0;
			if ((await this.projectDataBytes(id)) - previous + uploaded.size > this.maxProjectBytes)
				throw new ManualProjectError(`项目数据总量不能超过 ${this.maxProjectBytes} 字节。`, 413);
			project.revision++;
			project.updatedAt = new Date().toISOString();
			await this.database.commitFiles(
				[{ ownerKind: "manual", ownerId: id, name, source: { path } }],
				async () => await this.save(project),
			);
			return await this.snapshot(id);
		} finally {
			this.busy.delete(id);
			if (path) await rm(path, { force: true });
		}
	}

	async uploadDomjudgePdf(
		id: string,
		request: AsyncIterable<Uint8Array | string>,
		expectedRevision?: number,
	): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		this.busy.add(id);
		let path: string | undefined;
		try {
			const project = await this.load(id);
			await this.assertExpectedRevision(project, expectedRevision);
			if (project.scoringMode !== "acm") throw new ManualProjectError("只有 ACM 题目可以上传 DOMjudge PDF。", 422);
			const uploaded = await this.receiveFile(id, request);
			path = uploaded.path;
			const source = await open(path, "r");
			const header = Buffer.alloc(5);
			try {
				await source.read(header, 0, 5, 0);
			} finally {
				await source.close();
			}
			if (!header.equals(Buffer.from("%PDF-"))) throw new ManualProjectError("上传文件不是 PDF。", 422);
			project.domjudgePdf = { size: uploaded.size, sha256: await hashFile(path) };
			project.revision++;
			project.updatedAt = new Date().toISOString();
			await this.database.commitFiles(
				[{ ownerKind: "pdf", ownerId: id, name: "problem.pdf", source: { path } }],
				async () => await this.save(project),
			);
			return await this.snapshot(id);
		} finally {
			this.busy.delete(id);
			if (path) await rm(path, { force: true });
		}
	}

	async deleteDomjudgePdf(id: string, expectedRevision?: number): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		const project = await this.load(id);
		await this.assertExpectedRevision(project, expectedRevision);
		delete project.domjudgePdf;
		project.revision++;
		project.updatedAt = new Date().toISOString();
		await this.database.transaction(async () => {
			await this.save(project);
			await this.database.removeFile("pdf", id, "problem.pdf");
		});
		return await this.snapshot(id);
	}

	async domjudgePdfFile(id: string): Promise<{ path: string; size: number }> {
		const project = await this.load(id);
		if (!project.domjudgePdf) throw new ManualProjectError("尚未上传 DOMjudge PDF。", 404);
		return {
			path:
				(await this.database.filePath("pdf", id, "problem.pdf")) ??
				join(this.projectDirectory(id), "domjudge", "problem.pdf"),
			size: project.domjudgePdf.size,
		};
	}

	async file(id: string, name: string, origin?: ManualCaseSummary["origin"]): Promise<{ path: string; size: number }> {
		await this.load(id);
		dataStem(name);
		for (const source of origin ? [origin] : (["manual", "generated"] as const)) {
			const path = await this.database.filePath(source, id, name);
			if (!path) continue;
			try {
				const info = await stat(path);
				if (info.isFile()) return { path, size: info.size };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		throw new ManualProjectError("数据文件不存在。", 404);
	}

	async deleteFile(id: string, name: string, expectedRevision?: number): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		dataStem(name);
		const project = await this.load(id);
		await this.assertExpectedRevision(project, expectedRevision);
		project.revision++;
		project.updatedAt = new Date().toISOString();
		await this.database.transaction(async () => {
			await this.save(project);
			await this.database.removeFile("manual", id, name);
		});
		return await this.snapshot(id);
	}

	async deleteCases(id: string, stems: string[], expectedRevision?: number): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		const project = await this.load(id);
		await this.assertExpectedRevision(project, expectedRevision);
		if (!stems.length || stems.length > 500 || new Set(stems).size !== stems.length)
			throw new ManualProjectError("请选择有效的测试点。", 422);
		const cases = (await this.caseList(project)).cases.filter((item) => item.origin === "manual");
		const selected = stems.map((stem) => {
			const item = cases.find((entry) => entry.id === stem);
			if (!item) throw new ManualProjectError(`手动测试点 ${stem} 不存在。`, 404);
			return item;
		});
		for (const item of selected) delete project.caseSubtasks[`manual:${item.id}`];
		project.revision++;
		project.updatedAt = new Date().toISOString();
		await this.database.transaction(async () => {
			await this.save(project);
			for (const item of selected)
				for (const name of [item.inputFile, item.outputFile])
					if (name) await this.database.removeFile("manual", id, name);
		});
		return await this.snapshot(id);
	}

	async clearGenerated(id: string, expectedRevision?: number): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		const project = await this.load(id);
		await this.assertExpectedRevision(project, expectedRevision);
		project.generatedFromHash = undefined;
		project.revision++;
		project.updatedAt = new Date().toISOString();
		await this.database.transaction(async () => {
			await this.save(project);
			await this.database.removeOwnerFiles("generated", id);
		});
		return await this.snapshot(id);
	}

	async renumberPreviewSnapshot(
		id: string,
	): Promise<{ revision: number; changes: Array<{ from: string; to: string }> }> {
		return await this.database.transaction(async () => {
			const project = await this.load(id);
			return { revision: project.revision, changes: await this.renumberPreview(id) };
		});
	}

	async renumberPreview(id: string): Promise<Array<{ from: string; to: string }>> {
		const project = await this.load(id);
		const cases = (await this.caseList(project)).cases;
		const numeric = cases.filter((item) => item.origin === "manual" && /^\d+$/u.test(item.id)).sort(caseOrder);
		const reserved = new Set(
			cases.filter((item) => item.origin !== "manual" || !/^\d+$/u.test(item.id)).map((item) => item.id),
		);
		return numeric.map((item, index) => {
			const to = String(index + 1);
			if (reserved.has(to))
				throw new ManualProjectError(`编号 ${to} 已被自定义或 Gen 测试点占用，请先移除冲突数据。`, 409);
			return { from: item.id, to };
		});
	}

	async renumberCases(id: string, expectedRevision?: number): Promise<ManualProjectSnapshot> {
		await this.assertNotBusy(id);
		const project = await this.load(id);
		await this.assertExpectedRevision(project, expectedRevision);
		const preview = (await this.renumberPreview(id)).filter((item) => item.from !== item.to);
		if (!preview.length) return await this.snapshot(id);
		const names = new Set((await this.database.fileEntries("manual", id)).map((file) => file.name));
		const changes = preview.flatMap(({ from, to }) =>
			["in", "out", "ans"]
				.filter((extension) => names.has(`${from}.${extension}`))
				.map((extension) => ({ from: `${from}.${extension}`, to: `${to}.${extension}` })),
		);
		const originalAssignments = { ...project.caseSubtasks };
		for (const item of preview) delete project.caseSubtasks[`manual:${item.from}`];
		for (const item of preview) {
			const subtask = originalAssignments[`manual:${item.from}`];
			if (subtask !== undefined) project.caseSubtasks[`manual:${item.to}`] = subtask;
		}
		project.revision++;
		project.updatedAt = new Date().toISOString();
		await this.database.transaction(async () => {
			await this.save(project);
			await this.database.renameFiles("manual", id, changes);
		});
		return await this.snapshot(id);
	}

	async casePreview(
		id: string,
		origin: "manual" | "generated",
		stem: string,
	): Promise<{ input: string; output?: string; verified?: string; truncated: boolean }> {
		const project = await this.get(id);
		const item = project.cases.find((entry) => entry.origin === origin && entry.id === stem);
		if (!item) throw new ManualProjectError("测试点不存在。", 404);
		const read = async (path: string) => {
			const bytes = await readFile(path);
			return { text: bytes.subarray(0, 32 * 1024).toString("utf8"), truncated: bytes.length > 32 * 1024 };
		};
		const input = await read(await this.dataFile(id, origin, item.inputFile));
		const output = item.outputFile ? await read(await this.dataFile(id, origin, item.outputFile)) : undefined;
		const released = project.latestReleaseId
			? await this.releases.release(project.latestReleaseId).catch(() => undefined)
			: undefined;
		const verified =
			released?.revision === project.revision
				? await read(
						join(
							this.releaseDirectory(released.id),
							"hydro",
							released.slug,
							"testdata",
							item.outputFile ?? `${stem}.out`,
						),
					).catch(() => undefined)
				: undefined;
		return {
			input: input.text,
			output: output?.text,
			verified: verified?.text,
			truncated: input.truncated || !!output?.truncated || !!verified?.truncated,
		};
	}

	async delete(id: string): Promise<void> {
		const releases = await this.database.transaction(async () => {
			await this.assertNotBusy(id);
			await this.load(id);
			const releases = (await this.database.list<ManualRelease>("release")).filter((item) => item.projectId === id);
			for (const release of releases) {
				if (
					await this.database.sql.one(
						"SELECT 1 FROM tasks WHERE resource LIKE $1 AND state IN ('queued','running')",
						[`release:${release.id}:%`],
					)
				)
					throw new ManualProjectError("项目的发布包正在导出，请等待完成或取消任务。", 409);
				await this.database.delete("release", release.id);
				await this.database.removeOwnerFiles("release-file", release.id);
			}
			for (const kind of ["manual", "generated", "pdf"]) await this.database.removeOwnerFiles(kind, id);
			await this.database.delete("project", id);
			return releases;
		});
		for (const release of releases) await rm(this.releaseDirectory(release.id), { recursive: true, force: true });
		await rm(this.projectDirectory(id), { recursive: true, force: true });
		await this.database.pruneBlobs();
	}
}
