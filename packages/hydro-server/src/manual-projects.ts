import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildHydroProblemFiles,
	DEFAULT_HYDRO_JUDGE_LIMITS,
	type HydroJudgeLimits,
	type HydroProblemSpec,
	isSafeFlatName,
	parseHydroTimeLimitMs,
	validateHydroDirectory,
	validateHydroProblemSpec,
	writeHydroDirectoryArchive,
	writeStoredArchiveFromFiles,
} from "@hydro-problem-make/authoring";
import { formatHydroStatement } from "@hydro-problem-make/authoring/statement";
import { type CheckerMode, effectiveChecker } from "./acm-checker.ts";
import { writeDomjudgeProblemArchive } from "./domjudge-export.ts";
import { writeLegacyProblemExport } from "./legacy-exports.ts";
import type { HydroLiveVerificationResult } from "./live-hydro.ts";
import {
	type CppLanguage,
	cppLanguages,
	type ManualProgram,
	type ManualSandboxReport,
	runManualSandbox,
	type SandboxCase,
} from "./manual-sandbox.ts";

const projectIdPattern = /^[a-f0-9-]{36}$/;
const dataNamePattern = /^([A-Za-z0-9][A-Za-z0-9._-]*)\.(in|out|ans)$/;
const defaultMaxFileBytes = 64 * 1024 * 1024;
const defaultMaxProjectBytes = 512 * 1024 * 1024;
const maxTextCaseBytes = 1024 * 1024;

export interface ManualSubtask {
	id: number;
	type: "sum" | "min" | "max";
	score: number;
}

export interface ManualProject {
	id: string;
	scoringMode: "acm" | "oi";
	revision: number;
	createdAt: string;
	updatedAt: string;
	slug: string;
	title: string;
	tags: string[];
	statement: string;
	samples: Array<{ input: string; output: string }>;
	timeLimit: string;
	memoryLimit: string;
	reference: ManualProgram;
	oracle?: ManualProgram;
	generatorSource: string;
	generatorStandard: CppLanguage;
	generatorScript: string;
	checkerSource: string;
	checkerMode?: CheckerMode;
	checkerStandard: CppLanguage;
	validatorSource: string;
	validatorStandard: CppLanguage;
	subtasks: ManualSubtask[];
	caseSubtasks: Record<string, number>;
	attachments: Array<{ name: string; contentBase64: string }>;
	domjudgePdf?: { size: number; sha256: string };
	generatedFromHash?: string;
	latestReleaseId?: string;
	lastReport?: ManualVerificationReport;
}

export interface ManualCaseSummary {
	id: string;
	origin: "manual" | "generated";
	inputFile: string;
	outputFile?: string;
	inputBytes: number;
	outputBytes?: number;
	subtaskId: number;
}

export interface ManualProjectSnapshot extends ManualProject {
	cases: ManualCaseSummary[];
	orphanOutputs: string[];
}

export interface AddedManualCase {
	inputFile: string;
	outputFile?: string;
	project: ManualProjectSnapshot;
}

export interface ManualVerificationReport extends ManualSandboxReport {
	revision: number;
	projectHash: string;
	issues: Array<{ severity: "error" | "warning"; code: string; path: string; message: string }>;
	verifiedAt: string;
}

export interface ManualRelease {
	id: string;
	scoringMode: "acm" | "oi";
	projectId: string;
	revision: number;
	projectHash: string;
	slug: string;
	title: string;
	createdAt: string;
	report: ManualVerificationReport;
	checkerMode?: CheckerMode;
	domjudgePdf?: boolean;
	liveVerification?: HydroLiveVerificationResult;
}

export class ManualProjectError extends Error {
	readonly statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.name = "ManualProjectError";
		this.statusCode = statusCode;
	}
}

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

function dataStem(name: string): { stem: string; extension: "in" | "out" | "ans" } {
	const match = dataNamePattern.exec(name);
	if (!match || !isSafeFlatName(name))
		throw new ManualProjectError("测试文件名必须是平铺的 .in、.out 或 .ans 文件名。", 400);
	return { stem: match[1], extension: match[2] as "in" | "out" | "ans" };
}

/** Parse one gen invocation per line without invoking a shell. */
export function parseGeneratorScript(script: string): string[][] {
	const commands: string[][] = [];
	for (const [index, line] of script.split(/\r?\n/u).entries()) {
		const tokens: string[] = [];
		let token = "";
		let quote: "'" | '"' | undefined;
		let started = false;
		let escaped = false;
		for (const character of line) {
			if (escaped) {
				token += character;
				escaped = false;
				started = true;
				continue;
			}
			if (character === "\\") {
				escaped = true;
				continue;
			}
			if (quote) {
				if (character === quote) quote = undefined;
				else token += character;
				continue;
			}
			if (character === "'" || character === '"') {
				quote = character;
				started = true;
				continue;
			}
			if (character === "#") break;
			if (/[|;&<>$`]/u.test(character))
				throw new ManualProjectError(`生成脚本第 ${index + 1} 行包含 Shell 操作符。`);
			if (/\s/u.test(character)) {
				if (started) tokens.push(token);
				token = "";
				started = false;
			} else {
				token += character;
				started = true;
			}
		}
		if (quote || escaped) throw new ManualProjectError(`生成脚本第 ${index + 1} 行引号或转义不完整。`);
		if (started) tokens.push(token);
		if (tokens.length === 0) continue;
		if (tokens[0] !== "gen") throw new ManualProjectError(`生成脚本第 ${index + 1} 行必须以 gen 开头。`);
		if (tokens.length > 64 || tokens.some((item) => item.length > 1000)) {
			throw new ManualProjectError(`生成脚本第 ${index + 1} 行参数过多或过长。`);
		}
		commands.push(tokens.slice(1));
	}
	return commands;
}

function generatedHash(project: ManualProject, manualCases: ManualCaseSummary[]): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				project.generatorSource,
				project.generatorStandard,
				project.generatorScript,
				project.reference,
				manualCases.map((item) => item.inputFile).sort(),
			]),
		)
		.digest("hex");
}

async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const block of createReadStream(path)) hash.update(block);
	return hash.digest("hex");
}

async function fileEntries(directory: string): Promise<Array<{ name: string; size: number }>> {
	try {
		const result: Array<{ name: string; size: number }> = [];
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (!entry.isFile()) throw new ManualProjectError(`项目数据目录包含非普通文件：${entry.name}`);
			dataStem(entry.name);
			result.push({ name: entry.name, size: (await stat(join(directory, entry.name))).size });
		}
		return result;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function caseOrder(left: ManualCaseSummary, right: ManualCaseSummary): number {
	if (left.origin !== right.origin) return left.origin === "manual" ? -1 : 1;
	const leftNumber = /^\d+$/u.test(left.id) ? Number(left.id) : Number.POSITIVE_INFINITY;
	const rightNumber = /^\d+$/u.test(right.id) ? Number(right.id) : Number.POSITIVE_INFINITY;
	if (leftNumber !== rightNumber) return leftNumber - rightNumber;
	return left.id.localeCompare(right.id, "en");
}

export interface ManualProjectStoreOptions {
	root: string;
	image?: string;
	judgeLimits?: HydroJudgeLimits;
	maxFileBytes?: number;
	maxProjectBytes?: number;
}

export class ManualProjectStore {
	readonly root: string;
	readonly image: string;
	readonly judgeLimits: HydroJudgeLimits;
	readonly maxFileBytes: number;
	readonly maxProjectBytes: number;
	private readonly busy = new Set<string>();

	constructor(options: ManualProjectStoreOptions) {
		this.root = resolve(options.root);
		this.image = options.image ?? "hydro-problem-make/sandbox:local";
		this.judgeLimits = options.judgeLimits ?? DEFAULT_HYDRO_JUDGE_LIMITS;
		this.maxFileBytes = options.maxFileBytes ?? defaultMaxFileBytes;
		this.maxProjectBytes = options.maxProjectBytes ?? defaultMaxProjectBytes;
		if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1)
			throw new Error("maxFileBytes must be a positive integer.");
		if (!Number.isSafeInteger(this.maxProjectBytes) || this.maxProjectBytes < this.maxFileBytes) {
			throw new Error("maxProjectBytes must be an integer at least as large as maxFileBytes.");
		}
	}

	private projectDirectory(id: string): string {
		assertProjectId(id);
		return join(this.root, "projects", id);
	}

	private releaseDirectory(id: string): string {
		assertReleaseId(id);
		return join(this.root, "releases", id);
	}

	async cleanLegacyAgentData(): Promise<void> {
		const marker = join(this.root, ".legacy-agent-cleaned");
		try {
			await stat(marker);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(this.root, { recursive: true });
		for (const name of ["runs.json", "runs.json.legacy.json", "run-records", "sessions", "artifacts", "agent"]) {
			await rm(join(this.root, name), { recursive: true, force: true });
		}
		await writeFile(marker, "Legacy Agent records removed; ai-config.json preserved.\n");
	}

	async create(scoringMode: "acm" | "oi"): Promise<ManualProjectSnapshot> {
		const id = randomUUID();
		const now = new Date().toISOString();
		const project: ManualProject = {
			id,
			scoringMode,
			revision: 0,
			createdAt: now,
			updatedAt: now,
			slug: "",
			title: "",
			tags: [],
			statement: "",
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
		return this.get(id);
	}

	private async load(id: string): Promise<ManualProject> {
		try {
			const stored = JSON.parse(
				await readFile(join(this.projectDirectory(id), "project.json"), "utf8"),
			) as ManualProject;
			return {
				...stored,
				scoringMode: stored.scoringMode ?? "oi",
				checkerMode: stored.checkerMode ?? (stored.checkerSource.trim() ? "custom" : "text"),
				generatorStandard: stored.generatorStandard ?? "cpp17",
				checkerStandard: stored.checkerStandard ?? "cpp17",
				validatorStandard: stored.validatorStandard ?? "cpp17",
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError("项目不存在。", 404);
			throw error;
		}
	}

	private async save(project: ManualProject): Promise<void> {
		const path = join(this.projectDirectory(project.id), "project.json");
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(project, null, 2)}\n`);
		await rename(temporary, path);
	}

	private async caseList(project: ManualProject): Promise<{ cases: ManualCaseSummary[]; orphanOutputs: string[] }> {
		const cases: ManualCaseSummary[] = [];
		const orphanOutputs: string[] = [];
		for (const origin of ["manual", "generated"] as const) {
			const files = await fileEntries(join(this.projectDirectory(project.id), origin));
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
		const project = await this.load(id);
		return { ...project, ...(await this.caseList(project)) };
	}

	async list(): Promise<ManualProjectSnapshot[]> {
		const directory = join(this.root, "projects");
		let ids: string[];
		try {
			ids = (await readdir(directory, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && projectIdPattern.test(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return (await Promise.all(ids.map((id) => this.get(id)))).sort((left, right) =>
			right.updatedAt.localeCompare(left.updatedAt),
		);
	}

	async update(id: string, value: unknown): Promise<ManualProjectSnapshot> {
		this.assertNotBusy(id);
		const project = await this.load(id);
		const input = record(value, "项目草稿");
		if (input.scoringMode !== undefined && input.scoringMode !== project.scoringMode) {
			throw new ManualProjectError("题目赛制在创建后不可更改；请新建题目。", 422);
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
		] as const;
		for (const field of fields) {
			if (input[field] !== undefined)
				project[field] = boundedString(input[field], field, field === "statement" ? 1_000_000 : 200_000);
		}
		for (const field of ["generatorStandard", "checkerStandard", "validatorStandard"] as const) {
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
		project.revision += 1;
		project.updatedAt = new Date().toISOString();
		await this.save(project);
		return this.get(id);
	}

	private assertNotBusy(id: string): void {
		if (this.busy.has(id)) throw new ManualProjectError("项目正在生成或验证，请稍后重试。", 409);
	}

	private async projectDataBytes(id: string): Promise<number> {
		let total = 0;
		for (const source of ["manual", "generated"] as const) {
			for (const item of await fileEntries(join(this.projectDirectory(id), source))) total += item.size;
		}
		return total;
	}

	async addTextCase(id: string, value: unknown): Promise<AddedManualCase> {
		this.assertNotBusy(id);
		this.busy.add(id);
		let stage: string | undefined;
		let inputTarget: string | undefined;
		let outputTarget: string | undefined;
		let committed = false;
		try {
			const project = await this.load(id);
			const request = record(value, "手动测试点");
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
			const directory = join(this.projectDirectory(id), "manual");
			await mkdir(directory, { recursive: true });
			stage = await mkdtemp(join(this.projectDirectory(id), ".case-"));
			await writeFile(join(stage, inputFile), input);
			const outputFile = output === undefined ? undefined : `${stem}.out`;
			if (outputFile && output !== undefined) await writeFile(join(stage, outputFile), output);
			inputTarget = join(directory, inputFile);
			await rename(join(stage, inputFile), inputTarget);
			if (outputFile) {
				outputTarget = join(directory, outputFile);
				await rename(join(stage, outputFile), outputTarget);
			}
			project.caseSubtasks[`manual:${stem}`] = subtaskId as number;
			project.revision += 1;
			project.updatedAt = new Date().toISOString();
			await this.save(project);
			committed = true;
			return { inputFile, outputFile, project: { ...project, ...(await this.caseList(project)) } };
		} catch (error) {
			if (!committed) {
				if (inputTarget) await rm(inputTarget, { force: true });
				if (outputTarget) await rm(outputTarget, { force: true });
			}
			throw error;
		} finally {
			if (stage) await rm(stage, { recursive: true, force: true });
			this.busy.delete(id);
		}
	}

	async upload(id: string, name: string, request: IncomingMessage): Promise<ManualProjectSnapshot> {
		this.assertNotBusy(id);
		this.busy.add(id);
		try {
			await this.load(id);
			dataStem(name);
			const directory = join(this.projectDirectory(id), "manual");
			await mkdir(directory, { recursive: true });
			const target = join(directory, name);
			const currentBytes = await this.projectDataBytes(id);
			const previous = await stat(target)
				.then((item) => item.size)
				.catch(() => 0);
			const temporary = `${target}.${randomUUID()}.tmp`;
			const file = await open(temporary, "wx");
			let size = 0;
			try {
				for await (const raw of request) {
					const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
					size += bytes.byteLength;
					if (size > this.maxFileBytes)
						throw new ManualProjectError(`单个数据文件不能超过 ${this.maxFileBytes} 字节。`, 413);
					let offset = 0;
					while (offset < bytes.byteLength) {
						const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset);
						if (bytesWritten === 0) throw new Error("数据文件写入中断。");
						offset += bytesWritten;
					}
				}
			} catch (error) {
				await file.close();
				await rm(temporary, { force: true });
				throw error;
			}
			await file.close();
			if (currentBytes - previous + size > this.maxProjectBytes) {
				await rm(temporary, { force: true });
				throw new ManualProjectError(`项目数据总量不能超过 ${this.maxProjectBytes} 字节。`, 413);
			}
			await rename(temporary, target);
			const project = await this.load(id);
			project.revision += 1;
			project.updatedAt = new Date().toISOString();
			await this.save(project);
			return this.get(id);
		} finally {
			this.busy.delete(id);
		}
	}

	async uploadDomjudgePdf(id: string, request: IncomingMessage): Promise<ManualProjectSnapshot> {
		this.assertNotBusy(id);
		this.busy.add(id);
		const directory = join(this.projectDirectory(id), "domjudge");
		const target = join(directory, "problem.pdf");
		const temporary = `${target}.${randomUUID()}.tmp`;
		const backup = `${target}.${randomUUID()}.bak`;
		let originalExists = false;
		let replaced = false;
		let committed = false;
		try {
			const project = await this.load(id);
			if (project.scoringMode !== "acm") {
				throw new ManualProjectError("只有 ACM 题目可以上传 DOMjudge PDF。", 422);
			}
			await mkdir(directory, { recursive: true });
			const file = await open(temporary, "wx");
			let size = 0;
			try {
				for await (const raw of request) {
					const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
					size += bytes.byteLength;
					if (size > this.maxFileBytes) throw new ManualProjectError("PDF 超过单文件大小限制。", 413);
					let offset = 0;
					while (offset < bytes.byteLength) {
						const result = await file.write(bytes, offset, bytes.byteLength - offset);
						if (result.bytesWritten <= 0) throw new Error("PDF 写入中断。");
						offset += result.bytesWritten;
					}
				}
			} finally {
				await file.close();
			}
			const header = Buffer.alloc(5);
			const source = await open(temporary, "r");
			try {
				await source.read(header, 0, header.length, 0);
			} finally {
				await source.close();
			}
			if (!header.equals(Buffer.from("%PDF-"))) throw new ManualProjectError("上传文件不是 PDF。", 422);
			const sha256 = await hashFile(temporary);
			try {
				await copyFile(target, backup);
				originalExists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await rename(temporary, target);
			replaced = true;
			project.domjudgePdf = { size, sha256 };
			project.revision += 1;
			project.updatedAt = new Date().toISOString();
			await this.save(project);
			committed = true;
			return this.get(id);
		} catch (error) {
			if (replaced && !committed) {
				if (originalExists) await rename(backup, target);
				else await rm(target, { force: true });
			}
			throw error;
		} finally {
			await rm(temporary, { force: true });
			await rm(backup, { force: true });
			this.busy.delete(id);
		}
	}

	async deleteDomjudgePdf(id: string): Promise<ManualProjectSnapshot> {
		this.assertNotBusy(id);
		const project = await this.load(id);
		await rm(join(this.projectDirectory(id), "domjudge", "problem.pdf"), { force: true });
		delete project.domjudgePdf;
		project.revision += 1;
		project.updatedAt = new Date().toISOString();
		await this.save(project);
		return this.get(id);
	}

	async domjudgePdfFile(id: string): Promise<{ path: string; size: number }> {
		const project = await this.load(id);
		if (!project.domjudgePdf) throw new ManualProjectError("尚未上传 DOMjudge PDF。", 404);
		return { path: join(this.projectDirectory(id), "domjudge", "problem.pdf"), size: project.domjudgePdf.size };
	}

	async file(id: string, name: string, origin?: ManualCaseSummary["origin"]): Promise<{ path: string; size: number }> {
		await this.load(id);
		dataStem(name);
		for (const source of origin ? [origin] : (["manual", "generated"] as const)) {
			const path = join(this.projectDirectory(id), source, name);
			try {
				const info = await stat(path);
				if (info.isFile()) return { path, size: info.size };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		throw new ManualProjectError("数据文件不存在。", 404);
	}

	async deleteFile(id: string, name: string): Promise<ManualProjectSnapshot> {
		this.assertNotBusy(id);
		const project = await this.load(id);
		dataStem(name);
		await rm(join(this.projectDirectory(id), "manual", name), { force: true });
		project.revision += 1;
		project.updatedAt = new Date().toISOString();
		await this.save(project);
		return this.get(id);
	}

	private limits(project: ManualProject): { timeLimitMs: number; memoryLimitMb: number } {
		const timeLimitMs = parseHydroTimeLimitMs(project.timeLimit);
		const memory = /^(\d+(?:\.\d+)?)(k|m|g|kb|mb|gb)$/iu.exec(project.memoryLimit);
		const memoryLimitMb = memory
			? Math.ceil(
					Number(memory[1]) *
						(memory[2].toLowerCase().startsWith("g")
							? 1024
							: memory[2].toLowerCase().startsWith("k")
								? 1 / 1024
								: 1),
				)
			: NaN;
		if (
			!timeLimitMs ||
			timeLimitMs < 50 ||
			timeLimitMs > 10_000 ||
			!Number.isSafeInteger(memoryLimitMb) ||
			memoryLimitMb < 32 ||
			memoryLimitMb > 512
		) {
			throw new ManualProjectError("本地沙箱要求时间 50–10000 ms、内存 32–512 MiB。", 422);
		}
		return { timeLimitMs, memoryLimitMb };
	}

	async generate(id: string): Promise<{ project: ManualProjectSnapshot; report: ManualSandboxReport }> {
		this.assertNotBusy(id);
		this.busy.add(id);
		let stage: string | undefined;
		try {
			const project = await this.load(id);
			if (!project.reference.code.trim()) throw new ManualProjectError("请先添加标准程序。", 422);
			if (!project.generatorSource.trim()) throw new ManualProjectError("请上传或填写 Gen 源码。", 422);
			const commands = parseGeneratorScript(project.generatorScript);
			if (commands.length === 0) throw new ManualProjectError("生成脚本没有 gen 命令。", 422);
			const { cases } = await this.caseList(project);
			const manual = cases.filter((item) => item.origin === "manual");
			if (manual.length + commands.length > this.judgeLimits.maxTestCases)
				throw new ManualProjectError("生成后测试点超过评测机上限。", 422);
			const numericMax = Math.max(
				0,
				...manual.filter((item) => /^\d+$/u.test(item.id)).map((item) => Number(item.id)),
			);
			const startNumber = Math.max(manual.length, numericMax) + 1;
			stage = await mkdtemp(join(this.projectDirectory(id), ".generate-"));
			const report = await runManualSandbox({
				mode: "generate",
				stage,
				image: this.image,
				reference: project.reference,
				oracle: project.oracle,
				generator: project.generatorSource,
				generatorStandard: project.generatorStandard,
				commands,
				startNumber,
				checker: effectiveChecker(project.checkerMode, project.checkerSource),
				checkerStandard: project.checkerStandard,
				validator: project.validatorSource,
				validatorStandard: project.validatorStandard,
				maxFileBytes: this.maxFileBytes,
				...this.limits(project),
			});
			if (!report.success) return { project: await this.get(id), report };
			const previousBytes = (await fileEntries(join(this.projectDirectory(id), "generated"))).reduce(
				(sum, item) => sum + item.size,
				0,
			);
			const newBytes = (await fileEntries(join(stage, "generated"))).reduce((sum, item) => sum + item.size, 0);
			if ((await this.projectDataBytes(id)) - previousBytes + newBytes > this.maxProjectBytes) {
				throw new ManualProjectError("生成数据超过项目容量上限。", 413);
			}
			const destination = join(this.projectDirectory(id), "generated");
			const backup = join(this.projectDirectory(id), `.generated-backup-${randomUUID()}`);
			await rename(destination, backup).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			try {
				await rename(join(stage, "generated"), destination);
			} catch (error) {
				await rename(backup, destination).catch(() => {});
				throw error;
			}
			await rm(backup, { recursive: true, force: true });
			project.generatedFromHash = generatedHash(project, manual);
			project.revision += 1;
			project.updatedAt = new Date().toISOString();
			await this.save(project);
			return { project: await this.get(id), report };
		} finally {
			if (stage) await rm(stage, { recursive: true, force: true });
			this.busy.delete(id);
		}
	}

	private async projectHash(project: ManualProject, cases: ManualCaseSummary[]): Promise<string> {
		const hash = createHash("sha256").update(
			JSON.stringify({
				slug: project.slug,
				scoringMode: project.scoringMode,
				title: project.title,
				tags: project.tags,
				statement: project.statement,
				samples: project.samples,
				timeLimit: project.timeLimit,
				memoryLimit: project.memoryLimit,
				reference: project.reference,
				oracle: project.oracle,
				generatorSource: project.generatorSource,
				generatorStandard: project.generatorStandard,
				generatorScript: project.generatorScript,
				checkerSource: project.checkerSource,
				checkerMode: project.checkerMode,
				checkerStandard: project.checkerStandard,
				validatorSource: project.validatorSource,
				validatorStandard: project.validatorStandard,
				subtasks: project.subtasks,
				caseSubtasks: project.caseSubtasks,
				attachments: project.attachments,
				domjudgePdf: project.domjudgePdf,
			}),
		);
		for (const item of cases) {
			const directory = join(this.projectDirectory(project.id), item.origin);
			hash
				.update(item.origin)
				.update(item.inputFile)
				.update(await hashFile(join(directory, item.inputFile)));
			if (item.outputFile) hash.update(item.outputFile).update(await hashFile(join(directory, item.outputFile)));
		}
		return hash.digest("hex");
	}

	private spec(project: ManualProject, cases: ManualCaseSummary[]): HydroProblemSpec {
		return {
			type: "default",
			slug: project.slug,
			title: project.title,
			tags: project.tags,
			language: "zh",
			statement: formatHydroStatement(project),
			timeLimit: project.timeLimit,
			memoryLimit: project.memoryLimit,
			checker: { type: "testlib", source: effectiveChecker(project.checkerMode, project.checkerSource) ?? "" },
			attachments: project.attachments.map((item) => ({
				name: item.name,
				content: Buffer.from(item.contentBase64, "base64"),
			})),
			subtasks: project.subtasks.map((subtask) => ({
				...subtask,
				cases: cases
					.filter((item) => item.subtaskId === subtask.id)
					.map((item) => ({
						inputFile: item.inputFile,
						input: "",
						outputFile: item.outputFile ?? `${item.id}.out`,
						output: "",
					})),
			})),
		};
	}

	async finalize(id: string): Promise<{ release?: ManualRelease; report: ManualVerificationReport }> {
		this.assertNotBusy(id);
		this.busy.add(id);
		let stage: string | undefined;
		let releaseDirectory: string | undefined;
		try {
			const project = await this.load(id);
			if (!project.reference.code.trim()) throw new ManualProjectError("标准程序是打包前的必填项。", 422);
			if (!effectiveChecker(project.checkerMode, project.checkerSource)) {
				throw new ManualProjectError("请选择文本比对 Checker，或提供 C++ testlib Checker 源码。", 422);
			}
			if (
				project.scoringMode === "acm" &&
				(project.subtasks.length !== 1 ||
					project.subtasks[0].id !== 1 ||
					project.subtasks[0].type !== "min" ||
					project.subtasks[0].score !== 100)
			) {
				throw new ManualProjectError("ACM 题目仅允许一个 100 分 min 分组。", 422);
			}
			const { cases, orphanOutputs } = await this.caseList(project);
			if (orphanOutputs.length)
				throw new ManualProjectError(`存在没有对应 .in 的输出文件：${orphanOutputs.join(", ")}`, 422);
			if (cases.length === 0) throw new ManualProjectError("请先上传测试数据或运行 Gen。", 422);
			if (project.scoringMode === "acm" && cases.some((item) => item.subtaskId !== 1)) {
				throw new ManualProjectError("ACM 题目的所有测试点必须位于唯一分组。", 422);
			}
			if (cases.some((item) => item.origin === "generated")) {
				if (
					project.generatedFromHash !==
					generatedHash(
						project,
						cases.filter((item) => item.origin === "manual"),
					)
				) {
					throw new ManualProjectError("Gen、脚本、标程或手动测试点编号已修改，请重新生成数据。", 422);
				}
				const names = new Set<string>();
				for (const item of cases) {
					for (const name of [item.inputFile, item.outputFile ?? `${item.id}.out`]) {
						if (names.has(name)) throw new ManualProjectError(`测试文件 ${name} 重名，请重新生成数据。`, 422);
						names.add(name);
					}
				}
			}
			const spec = this.spec(project, cases);
			const structural = validateHydroProblemSpec(spec, this.judgeLimits);
			if (!structural.valid)
				throw new ManualProjectError(
					structural.issues.map((item) => `${item.path}: ${item.message}`).join("\n"),
					422,
				);
			stage = await mkdtemp(join(this.projectDirectory(id), ".verify-"));
			const sandboxCases: SandboxCase[] = cases.map((item) => ({
				id: item.id,
				inputPath: join(this.projectDirectory(id), item.origin, item.inputFile),
				outputPath: item.outputFile ? join(this.projectDirectory(id), item.origin, item.outputFile) : undefined,
				outputName: item.outputFile ?? `${item.id}.out`,
			}));
			const sandbox = await runManualSandbox({
				mode: "finalize",
				stage,
				image: this.image,
				reference: project.reference,
				oracle: project.oracle,
				generatorStandard: project.generatorStandard,
				checker: effectiveChecker(project.checkerMode, project.checkerSource),
				checkerStandard: project.checkerStandard,
				validator: project.validatorSource,
				validatorStandard: project.validatorStandard,
				cases: sandboxCases,
				samples: project.samples,
				maxFileBytes: this.maxFileBytes,
				...this.limits(project),
			});
			const report: ManualVerificationReport = {
				...sandbox,
				revision: project.revision,
				projectHash: await this.projectHash(project, cases),
				issues: structural.issues,
				verifiedAt: new Date().toISOString(),
			};
			project.lastReport = report;
			await this.save(project);
			if (!report.success) return { report };

			const releaseId = randomUUID();
			releaseDirectory = this.releaseDirectory(releaseId);
			await mkdir(join(releaseDirectory, "hydro", project.slug), { recursive: true });
			const hydroRoot = join(releaseDirectory, "hydro", project.slug);
			for (const [name, content] of buildHydroProblemFiles(spec, this.judgeLimits)) {
				const path = join(hydroRoot, name);
				await mkdir(join(path, ".."), { recursive: true });
				await writeFile(path, content);
			}
			for (const item of cases) {
				await copyFile(
					join(this.projectDirectory(id), item.origin, item.inputFile),
					join(hydroRoot, "testdata", item.inputFile),
				);
				await copyFile(
					join(stage, "verified", item.outputFile ?? `${item.id}.out`),
					join(hydroRoot, "testdata", item.outputFile ?? `${item.id}.out`),
				);
			}
			const directoryReport = await validateHydroDirectory(hydroRoot, { judgeLimits: this.judgeLimits });
			if (!directoryReport.valid)
				throw new ManualProjectError(directoryReport.issues.map((item) => item.message).join("\n"), 422);
			await writeHydroDirectoryArchive(hydroRoot, join(releaseDirectory, "hydro.zip"), {
				judgeLimits: this.judgeLimits,
			});

			const sourceRoot = join(releaseDirectory, "source");
			await mkdir(sourceRoot, { recursive: true });
			const sourceFiles = new Map<string, string>();
			const sourceTexts: Record<string, string> = {
				"project.json": JSON.stringify(project, null, 2),
				"report.json": JSON.stringify(report, null, 2),
				"reference.txt": project.reference.code,
				"generator.cc": project.generatorSource,
				"generate.txt": project.generatorScript,
				"checker.cc": effectiveChecker(project.checkerMode, project.checkerSource) ?? "",
				"validator.cc": project.validatorSource,
				"oracle.txt": project.oracle?.code ?? "",
			};
			for (const [name, content] of Object.entries(sourceTexts)) {
				const path = join(sourceRoot, name);
				await writeFile(path, content);
				sourceFiles.set(name, path);
			}
			if (project.domjudgePdf) {
				const pdfSource = join(this.projectDirectory(id), "domjudge", "problem.pdf");
				if ((await hashFile(pdfSource)) !== project.domjudgePdf.sha256) {
					throw new ManualProjectError("DOMjudge PDF 已在项目目录外被修改，请重新上传。", 422);
				}
				await copyFile(pdfSource, join(releaseDirectory, "problem.pdf"));
				const sourceTarget = join(sourceRoot, "problem.pdf");
				await copyFile(pdfSource, sourceTarget);
				sourceFiles.set("problem.pdf", sourceTarget);
			}
			for (const item of cases) {
				for (const name of [item.inputFile, item.outputFile].filter(
					(value): value is string => value !== undefined,
				)) {
					const relative = `data/${item.origin}/${name}`;
					const target = join(sourceRoot, relative);
					await mkdir(join(target, ".."), { recursive: true });
					await copyFile(join(this.projectDirectory(id), item.origin, name), target);
					sourceFiles.set(relative, target);
				}
				const verifiedName = item.outputFile ?? `${item.id}.out`;
				const verifiedRelative = `data/verified/${verifiedName}`;
				const verifiedTarget = join(sourceRoot, verifiedRelative);
				await mkdir(join(verifiedTarget, ".."), { recursive: true });
				await copyFile(join(hydroRoot, "testdata", verifiedName), verifiedTarget);
				sourceFiles.set(verifiedRelative, verifiedTarget);
			}
			for (const name of ["testlib.h", "LICENSE"]) {
				const source = fileURLToPath(new URL(`../sandbox/testlib/${name}`, import.meta.url));
				const relative = `testlib/${name}`;
				const target = join(sourceRoot, relative);
				await mkdir(join(target, ".."), { recursive: true });
				await copyFile(source, target);
				sourceFiles.set(relative, target);
			}
			const fileHashes = Object.fromEntries(
				await Promise.all([...sourceFiles].map(async ([name, path]) => [name, await hashFile(path)] as const)),
			);
			const manifest = {
				projectId: id,
				revision: project.revision,
				projectHash: report.projectHash,
				sandboxImage: this.image,
				toolchain: { cpp: "GCC 16.2.0", python: "Python 3.14", java: "Java 21" },
				languages: {
					reference: project.reference.language,
					oracle: project.oracle?.language,
					generator: project.generatorStandard,
					checker: project.checkerStandard,
					validator: project.validatorStandard,
				},
				testlibCommit: "1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd",
				generatorCommands: project.generatorScript.trim() ? parseGeneratorScript(project.generatorScript) : [],
				cases: cases.map((item) => ({
					id: item.id,
					origin: item.origin,
					inputFile: item.inputFile,
					outputFile: item.outputFile ?? `${item.id}.out`,
					subtaskId: item.subtaskId,
				})),
				files: fileHashes,
			};
			const manifestPath = join(sourceRoot, "manifest.json");
			await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
			sourceFiles.set("manifest.json", manifestPath);
			await writeStoredArchiveFromFiles(
				join(releaseDirectory, "source.zip"),
				`${project.slug}.authoring`,
				sourceFiles,
			);
			const release: ManualRelease = {
				id: releaseId,
				scoringMode: project.scoringMode,
				projectId: id,
				revision: project.revision,
				projectHash: report.projectHash,
				slug: project.slug,
				title: project.title,
				createdAt: new Date().toISOString(),
				report,
				checkerMode: project.checkerMode,
				domjudgePdf: Boolean(project.domjudgePdf),
			};
			await writeFile(join(releaseDirectory, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
			project.latestReleaseId = releaseId;
			await this.save(project);
			releaseDirectory = undefined;
			return { release, report };
		} finally {
			if (stage) await rm(stage, { recursive: true, force: true });
			if (releaseDirectory) await rm(releaseDirectory, { recursive: true, force: true });
			this.busy.delete(id);
		}
	}

	async release(id: string): Promise<ManualRelease> {
		try {
			return JSON.parse(await readFile(join(this.releaseDirectory(id), "release.json"), "utf8")) as ManualRelease;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError("发布记录不存在。", 404);
			throw error;
		}
	}

	async listReleases(): Promise<ManualRelease[]> {
		let entries: string[];
		try {
			entries = (await readdir(join(this.root, "releases"), { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && projectIdPattern.test(entry.name))
				.map((entry) => entry.name);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		return (await Promise.all(entries.map((id) => this.release(id)))).sort((left, right) =>
			right.createdAt.localeCompare(left.createdAt),
		);
	}

	async releaseReference(id: string): Promise<ManualProgram> {
		await this.release(id);
		const snapshot = JSON.parse(
			await readFile(join(this.releaseDirectory(id), "source", "project.json"), "utf8"),
		) as ManualProject;
		return snapshot.reference;
	}

	async recordLiveVerification(id: string, result: HydroLiveVerificationResult): Promise<ManualRelease> {
		const release = await this.release(id);
		const updated = { ...release, liveVerification: result };
		const target = join(this.releaseDirectory(id), "release.json");
		const temporary = `${target}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`);
		await rename(temporary, target);
		return updated;
	}

	async exportDomjudge(id: string): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		try {
			await writeDomjudgeProblemArchive(this.releaseDirectory(id), release, this.image);
		} catch (error) {
			throw new ManualProjectError(error instanceof Error ? error.message : "DOMjudge 导出失败。", 422);
		}
		return this.releaseFile(id, "domjudge");
	}

	async exportLegacy(id: string, format: "fps" | "qduoj"): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		try {
			await writeLegacyProblemExport(this.releaseDirectory(id), release, format);
		} catch (error) {
			throw new ManualProjectError(error instanceof Error ? error.message : "题目格式导出失败。", 422);
		}
		return this.releaseFile(id, format);
	}

	async releaseFile(
		id: string,
		kind: "hydro" | "source" | "domjudge" | "fps" | "qduoj",
	): Promise<{ path: string; size: number; name: string }> {
		const release = await this.release(id);
		const path = join(this.releaseDirectory(id), `${kind}.${kind === "fps" ? "xml" : "zip"}`);
		let size: number;
		try {
			size = (await stat(path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ManualProjectError("该格式尚未导出。", 404);
			throw error;
		}
		return {
			path,
			size,
			name: `${release.slug}.${kind === "source" ? "authoring" : kind}.${kind === "fps" ? "xml" : "zip"}`,
		};
	}

	async delete(id: string): Promise<void> {
		this.assertNotBusy(id);
		await this.load(id);
		const releases = await readdir(join(this.root, "releases"), { withFileTypes: true }).catch(() => []);
		for (const entry of releases) {
			if (!entry.isDirectory() || !projectIdPattern.test(entry.name)) continue;
			const release = await this.release(entry.name);
			if (release.projectId === id) await rm(this.releaseDirectory(entry.name), { recursive: true, force: true });
		}
		await rm(this.projectDirectory(id), { recursive: true, force: true });
	}
}
