export type PageRoute = "workspace" | "runs" | "settings";
export type ApiStatus = "checking" | "online" | "offline";
export type AgentRunStatus = "queued" | "running" | "needs_input" | "succeeded" | "failed" | "cancelled";
export type AgentRunPhase =
	| "analyzing"
	| "authoring"
	| "quick_verification"
	| "full_verification"
	| "packaging"
	| "validating"
	| "clarification";

export interface ValidationIssue {
	severity: "error" | "warning";
	code: string;
	path: string;
	message: string;
}

export interface ValidationReport {
	valid: boolean;
	issues: ValidationIssue[];
}

export interface AgentRunSummary {
	id: string;
	status: AgentRunStatus;
	title: string;
	sourcePreview: string;
	createdAt: string;
	updatedAt: string;
	model?: string;
	modelSettings?: { contextWindow: number; maxTokens: number };
	judgingType?: "default" | "interactive" | "submit_answer";
	artifact?: {
		slug: string;
		report: ValidationReport;
		verification?: SandboxReport;
		authoring?: AuthoringSummary;
		liveVerification?: LiveHydroVerification;
	};
	phase?: AgentRunPhase;
	phaseMessage?: string;
	phaseStartedAt?: string;
	lastEventSequence: number;
	metrics?: AgentMetrics;
}

export interface AgentMetrics {
	modelTurns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	modelWaitMs: number;
	sandboxMs: number;
	toolCalls: number;
	quickVerifications: number;
	fullVerifications: number;
}

export interface AgentRun extends AgentRunSummary {
	source: string;
	assistantText: string;
	error?: string;
	conversation?: Array<{ role: "user" | "assistant"; content: string }>;
	referenceProgram?: ReferenceProgram;
	attachments: Array<{ name: string; contentBase64: string }>;
}

export interface AuthoringSummary {
	verificationId: string;
	revision?: number;
	type?: "default" | "interactive" | "submit_answer";
	success: boolean;
	testCases: number;
	generatedCases: number;
	oracleCases: number;
	validatorNegativeCases: number;
	checker: "default" | "testlib";
	checkerProbes: number;
	wrongPrograms: number;
}

export interface AuthoringReport {
	success: boolean;
	mode: "quick" | "full";
	checks: Array<{ stage: string; caseId?: string; passed: boolean; message: string }>;
	cases: Array<{ id: string; durationMs: number; timeLimitMs: number; memoryLimitMb: number }>;
}

export interface LiveHydroVerification {
	success: boolean;
	startedAt: string;
	finishedAt: string;
	problemUrl?: string;
	import: { success: boolean; message: string };
	reference: { name: string; verdict: string; score?: number; accepted: boolean };
	wrongPrograms: Array<{ name: string; verdict: string; score?: number; accepted: boolean }>;
	message: string;
}

export interface ReferenceProgram {
	language: "cpp17" | "python3" | "java";
	code: string;
}

export interface SandboxStatus {
	available: boolean;
	image: string;
	message: string;
}

export interface SandboxReport {
	success: boolean;
	compiled: boolean;
	compileOutput: string;
	cases: Array<{
		index: number;
		status: "generated" | "passed" | "wrong_answer" | "runtime_error" | "time_limit" | "output_limit";
		stdout: string;
		stderr: string;
		exitCode: number;
		durationMs: number;
	}>;
}

export interface WorkflowStepPresentation {
	className: "pending" | "active" | "attention" | "passed" | "failed";
	message: string;
}

export interface AiModelOption {
	id: string;
	name: string;
}

export interface AiProviderOption {
	id: string;
	name: string;
	models: AiModelOption[];
}

export interface AiConfiguration {
	configured: boolean;
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	apiKeyConfigured: boolean;
	providers: AiProviderOption[];
	error?: string;
}

const agentRunStatuses: readonly AgentRunStatus[] = [
	"queued",
	"running",
	"needs_input",
	"succeeded",
	"failed",
	"cancelled",
];

export function pageFromHash(hash: string): PageRoute {
	if (hash === "#runs") return "runs";
	if (hash === "#settings") return "settings";
	return "workspace";
}

export function normalizeApiOrigin(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("API 根地址必须是完整的 http:// 或 https:// 地址。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("API 根地址只支持 http:// 或 https://。");
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new Error("API 根地址不能包含用户名或密码。");
	}
	if (url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
		throw new Error("API 根地址只填写协议、域名和端口，不要包含路径、查询参数或锚点。");
	}
	return url.origin;
}

export function apiUrl(apiOrigin: string, route: string): string {
	const suffix = route.startsWith("/") ? route : `/${route}`;
	return `${apiOrigin.replace(/\/+$/u, "")}/api${suffix}`;
}

export function readAgentRun(value: unknown): AgentRun | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.status !== "string" ||
		!agentRunStatuses.includes(record.status as AgentRunStatus) ||
		typeof record.source !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		typeof record.assistantText !== "string" ||
		typeof record.title !== "string" ||
		typeof record.sourcePreview !== "string" ||
		typeof record.lastEventSequence !== "number" ||
		!Array.isArray(record.attachments)
	) {
		return undefined;
	}
	return value as AgentRun;
}

export function readAgentRunSummary(value: unknown): AgentRunSummary | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.status !== "string" ||
		!agentRunStatuses.includes(record.status as AgentRunStatus) ||
		typeof record.title !== "string" ||
		typeof record.sourcePreview !== "string" ||
		typeof record.createdAt !== "string" ||
		typeof record.updatedAt !== "string" ||
		typeof record.lastEventSequence !== "number"
	)
		return undefined;
	return value as AgentRunSummary;
}

export function readAgentRunList(value: unknown): AgentRunSummary[] {
	if (typeof value !== "object" || value === null) return [];
	const runs = (value as Record<string, unknown>).runs;
	if (!Array.isArray(runs)) return [];
	return runs.flatMap((run) => readAgentRunSummary(run) ?? []);
}

function readOptionalText(record: Record<string, unknown>, key: string): string | undefined | false {
	const value = record[key];
	return value === undefined || typeof value === "string" ? value : false;
}

function readOptionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined | false {
	const value = record[key];
	return value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)
		? (value as number | undefined)
		: false;
}

export function readAiConfiguration(value: unknown): AiConfiguration | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.configured !== "boolean" ||
		typeof record.apiKeyConfigured !== "boolean" ||
		!Array.isArray(record.providers) ||
		Object.hasOwn(record, "apiKey")
	) {
		return undefined;
	}
	const provider = readOptionalText(record, "provider");
	const modelId = readOptionalText(record, "modelId");
	const baseUrl = readOptionalText(record, "baseUrl");
	const error = readOptionalText(record, "error");
	const contextWindow = readOptionalPositiveInteger(record, "contextWindow");
	const maxTokens = readOptionalPositiveInteger(record, "maxTokens");
	if (
		provider === false ||
		modelId === false ||
		baseUrl === false ||
		error === false ||
		contextWindow === false ||
		maxTokens === false
	)
		return undefined;
	const providers: AiProviderOption[] = [];
	for (const item of record.providers) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
		const candidate = item as Record<string, unknown>;
		if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || !Array.isArray(candidate.models)) {
			return undefined;
		}
		const models: AiModelOption[] = [];
		for (const itemModel of candidate.models) {
			if (typeof itemModel !== "object" || itemModel === null || Array.isArray(itemModel)) return undefined;
			const model = itemModel as Record<string, unknown>;
			if (typeof model.id !== "string" || typeof model.name !== "string") return undefined;
			models.push({ id: model.id, name: model.name });
		}
		providers.push({ id: candidate.id, name: candidate.name, models });
	}
	return {
		configured: record.configured,
		provider,
		modelId,
		baseUrl,
		contextWindow,
		maxTokens,
		apiKeyConfigured: record.apiKeyConfigured,
		providers,
		error,
	};
}

export function runDisplayTitle(run: AgentRun | AgentRunSummary): string {
	if (!("source" in run)) return run.title || run.artifact?.slug || `任务 ${run.id.slice(0, 8)}`;
	const statementTitle = run.source
		.split("## 用户提供的题面")[1]
		?.match(/^#\s+(.+)$/mu)?.[1]
		?.trim();
	if (statementTitle) return statementTitle;
	const requestedTitle = run.source.match(/^- 建议题目名称：(.+)$/mu)?.[1]?.trim();
	if (requestedTitle) return requestedTitle;
	if (run.artifact?.slug) return run.artifact.slug;
	const heading = run.source.match(/^#\s+(.+)$/mu)?.[1]?.trim();
	return heading || `任务 ${run.id.slice(0, 8)}`;
}

export function algorithmValidationPresentation(
	run: AgentRun | AgentRunSummary | undefined,
	sandbox: SandboxStatus | undefined,
): WorkflowStepPresentation {
	const authoring = run?.artifact?.authoring;
	if (authoring?.success === true) {
		return {
			className: "passed",
			message: `${authoring.testCases} 个测试点验证通过 · ${authoring.oracleCases} 次独立对拍`,
		};
	}
	const verification = run?.artifact?.verification;
	if (verification?.success === true) {
		return {
			className: "passed",
			message: `${verification.cases.length} 个测试点验证通过`,
		};
	}
	if (sandbox?.available !== true) {
		return { className: "failed", message: sandbox?.message ?? "请检查 Linux 沙箱" };
	}
	if (run?.status === "queued") return { className: "active", message: "等待进入 Linux 沙箱验证" };
	if (run?.status === "running") return { className: "active", message: "正在生成数据并执行验证" };
	if (run?.status === "needs_input") return { className: "attention", message: "等待补充信息后继续验证" };
	if (run?.status === "failed") return { className: "failed", message: "算法或数据验证未通过，请查看任务详情" };
	if (run?.status === "cancelled") return { className: "failed", message: "任务已取消，验证未完成" };
	if (run?.status === "succeeded") return { className: "attention", message: "题目包已生成，但没有算法验证证据" };
	return { className: "pending", message: "Linux 沙箱已就绪，运行 Pi Agent 后开始验证" };
}

export function isTerminalAgentRun(status: AgentRunStatus): boolean {
	return status === "needs_input" || status === "succeeded" || status === "failed" || status === "cancelled";
}

export function agentStatusLabel(status: AgentRunStatus): string {
	if (status === "queued") return "排队中";
	if (status === "running") return "生成中";
	if (status === "needs_input") return "需要补充信息";
	if (status === "succeeded") return "已生成";
	if (status === "cancelled") return "已取消";
	return "失败";
}

export function apiStatusLabel(status: ApiStatus): string {
	if (status === "online") return "API 已连接";
	if (status === "offline") return "API 未连接";
	return "正在连接 API";
}
