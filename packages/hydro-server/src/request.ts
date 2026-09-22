import type {
	HydroAgentAttachment,
	HydroAiConfigurationInput,
	HydroReferenceProgram,
	HydroSandboxRequest,
} from "@hydro-problem-make/agent";
import {
	type HydroProblemSpec,
	type HydroSubtask,
	type HydroTestCase,
	isSafeFlatName,
} from "@hydro-problem-make/authoring";

export class InvalidRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidRequestError";
	}
}

function readRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new InvalidRequestError(`${path} must be an object.`);
	}
	return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
	if (!Array.isArray(value)) throw new InvalidRequestError(`${path} must be an array.`);
	return value;
}

function readString(record: Record<string, unknown>, key: string, path: string): string {
	const value = record[key];
	if (typeof value !== "string") throw new InvalidRequestError(`${path}.${key} must be a string.`);
	return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new InvalidRequestError(`${path}.${key} must be a string.`);
	return value;
}

function readInteger(record: Record<string, unknown>, key: string, path: string): number {
	const value = record[key];
	if (!Number.isSafeInteger(value)) throw new InvalidRequestError(`${path}.${key} must be an integer.`);
	return value as number;
}

function readOptionalInteger(record: Record<string, unknown>, key: string, path: string): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value)) throw new InvalidRequestError(`${path}.${key} must be an integer.`);
	return value as number;
}

function readIntegerArray(record: Record<string, unknown>, key: string, path: string): number[] | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return readArray(value, `${path}.${key}`).map((item, index) => {
		if (!Number.isSafeInteger(item)) throw new InvalidRequestError(`${path}.${key}[${index}] must be an integer.`);
		return item as number;
	});
}

function readTestCase(value: unknown, path: string): HydroTestCase {
	const record = readRecord(value, path);
	return {
		inputFile: readString(record, "inputFile", path),
		input: readString(record, "input", path),
		outputFile: readString(record, "outputFile", path),
		output: readString(record, "output", path),
		timeLimit: readOptionalString(record, "timeLimit", path),
		memoryLimit: readOptionalString(record, "memoryLimit", path),
	};
}

function readSubtask(value: unknown, index: number): HydroSubtask {
	const path = `problem.subtasks[${index}]`;
	const record = readRecord(value, path);
	const type = readString(record, "type", path);
	if (type !== "sum" && type !== "min") throw new InvalidRequestError(`${path}.type must be sum or min.`);
	return {
		id: readInteger(record, "id", path),
		type,
		score: readInteger(record, "score", path),
		dependsOn: readIntegerArray(record, "dependsOn", path),
		timeLimit: readOptionalString(record, "timeLimit", path),
		memoryLimit: readOptionalString(record, "memoryLimit", path),
		cases: readArray(record.cases, `${path}.cases`).map((testCase, caseIndex) =>
			readTestCase(testCase, `${path}.cases[${caseIndex}]`),
		),
	};
}

function decodeBase64(value: string, path: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
		throw new InvalidRequestError(`${path} must be canonical base64.`);
	}
	return Buffer.from(value, "base64");
}

export function parseProblemRequest(value: unknown): HydroProblemSpec {
	const root = readRecord(value, "request");
	const problem = readRecord(root.problem, "problem");
	let checker: HydroProblemSpec["checker"];
	if (problem.checker !== undefined) {
		const value = readRecord(problem.checker, "problem.checker");
		if (value.type !== "testlib") throw new InvalidRequestError("problem.checker.type must be testlib.");
		checker = { type: "testlib", source: readString(value, "source", "problem.checker") };
	}
	const tags = readArray(problem.tags, "problem.tags").map((tag, index) => {
		if (typeof tag !== "string") throw new InvalidRequestError(`problem.tags[${index}] must be a string.`);
		return tag;
	});
	const attachmentsValue = problem.attachments;
	const attachments =
		attachmentsValue === undefined
			? undefined
			: readArray(attachmentsValue, "problem.attachments").map((attachment, index) => {
					const path = `problem.attachments[${index}]`;
					const record = readRecord(attachment, path);
					return {
						name: readString(record, "name", path),
						content: decodeBase64(readString(record, "contentBase64", path), `${path}.contentBase64`),
					};
				});
	return {
		slug: readString(problem, "slug", "problem"),
		title: readString(problem, "title", "problem"),
		pid: readOptionalString(problem, "pid", "problem"),
		tags,
		language: readString(problem, "language", "problem"),
		statement: readString(problem, "statement", "problem"),
		timeLimit: readString(problem, "timeLimit", "problem"),
		memoryLimit: readString(problem, "memoryLimit", "problem"),
		subtasks: readArray(problem.subtasks, "problem.subtasks").map(readSubtask),
		attachments,
		checker,
	};
}

function readReferenceProgram(value: unknown): HydroReferenceProgram | undefined {
	if (value === undefined) return undefined;
	const program = readRecord(value, "referenceProgram");
	const language = readString(program, "language", "referenceProgram");
	if (language !== "cpp17" && language !== "python3" && language !== "java")
		throw new InvalidRequestError("标准程序语言须为 cpp17、python3 或 java。");
	const code = readString(program, "code", "referenceProgram");
	if (!code.trim() || code.length > 200_000) throw new InvalidRequestError("标准程序须为 1–200000 个字符。");
	return { language, code };
}

function readAgentAttachments(value: unknown): HydroAgentAttachment[] | undefined {
	if (value === undefined) return undefined;
	const names = new Set<string>();
	let totalBytes = 0;
	const attachments = readArray(value, "request.attachments").map((value, index) => {
		const path = `request.attachments[${index}]`;
		const record = readRecord(value, path);
		const name = readString(record, "name", path);
		if (!isSafeFlatName(name) || names.has(name))
			throw new InvalidRequestError(`${path}.name must be a unique flat ASCII filename.`);
		names.add(name);
		const contentBase64 = readString(record, "contentBase64", path);
		const content = decodeBase64(contentBase64, `${path}.contentBase64`);
		if (content.byteLength > 1024 * 1024) throw new InvalidRequestError(`${path} exceeds 1 MiB.`);
		totalBytes += content.byteLength;
		return { name, contentBase64 };
	});
	if (attachments.length > 20 || totalBytes > 10 * 1024 * 1024)
		throw new InvalidRequestError("Agent attachments exceed 20 files or 10 MiB.");
	return attachments;
}

export function parseAgentRunRequest(value: unknown): {
	source: string;
	referenceProgram?: HydroReferenceProgram;
	attachments?: HydroAgentAttachment[];
} {
	const root = readRecord(value, "request");
	const source = readString(root, "source", "request").trim();
	if (source.length === 0) throw new InvalidRequestError("request.source cannot be empty.");
	if (source.length > 200_000) throw new InvalidRequestError("request.source exceeds 200000 characters.");
	return {
		source,
		referenceProgram: readReferenceProgram(root.referenceProgram),
		attachments: readAgentAttachments(root.attachments),
	};
}

export function parseContinueRequest(value: unknown): {
	message: string;
	referenceProgram?: HydroReferenceProgram | null;
	attachments?: HydroAgentAttachment[] | null;
} {
	const root = readRecord(value, "request");
	const message = readString(root, "message", "request").trim();
	if (!message || message.length > 200_000) throw new InvalidRequestError("补充信息须为 1–200000 个字符。");
	return {
		message,
		referenceProgram: root.referenceProgram === null ? null : readReferenceProgram(root.referenceProgram),
		attachments: root.attachments === null ? null : readAgentAttachments(root.attachments),
	};
}

export function parseSandboxRequest(value: unknown): HydroSandboxRequest {
	const root = readRecord(value, "request");
	const program = readReferenceProgram(root.program);
	if (!program) throw new InvalidRequestError("请添加标准程序。");
	const cases = readArray(root.cases, "request.cases").map((value, index) => {
		const path = `request.cases[${index}]`;
		const item = readRecord(value, path);
		return {
			input: readString(item, "input", path),
			expectedOutput: readOptionalString(item, "expectedOutput", path),
		};
	});
	if (!cases.length || cases.length > 100) throw new InvalidRequestError("每次运行需要 1–100 个测试点。");
	const timeLimitMs = root.timeLimitMs === undefined ? 2000 : readInteger(root, "timeLimitMs", "request");
	const memoryLimitMb = root.memoryLimitMb === undefined ? 256 : readInteger(root, "memoryLimitMb", "request");
	if (timeLimitMs < 50 || timeLimitMs > 10000) throw new InvalidRequestError("时间限制须为 50–10000 ms。");
	if (memoryLimitMb < 32 || memoryLimitMb > 512) throw new InvalidRequestError("内存限制须为 32–512 MiB。");
	return { program, cases, timeLimitMs, memoryLimitMb };
}

export function parseAiConfigurationRequest(value: unknown): HydroAiConfigurationInput {
	const root = readRecord(value, "request");
	const provider = readString(root, "provider", "request").trim();
	const modelId = readString(root, "modelId", "request").trim();
	const apiKey = readOptionalString(root, "apiKey", "request")?.trim();
	const baseUrl = readOptionalString(root, "baseUrl", "request")?.trim();
	const contextWindow = readOptionalInteger(root, "contextWindow", "request");
	const maxTokens = readOptionalInteger(root, "maxTokens", "request");
	if (provider.length === 0) throw new InvalidRequestError("request.provider cannot be empty.");
	if (modelId.length === 0) throw new InvalidRequestError("request.modelId cannot be empty.");
	return {
		provider,
		modelId,
		apiKey: apiKey && apiKey.length > 0 ? apiKey : undefined,
		baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : undefined,
		contextWindow,
		maxTokens,
	};
}
