export type PageRoute = "workspace" | "chat" | "records" | "contests" | "settings";
export type ApiStatus = "checking" | "online" | "offline";
export type CppLanguage = "cpp11" | "cpp14" | "cpp17" | "cpp20" | "cpp23" | "cpp26";
export type ProgramLanguage = CppLanguage | "python3" | "java";

export const cppLanguageOptions: ReadonlyArray<{ value: CppLanguage; label: string }> = [
	{ value: "cpp11", label: "C++11" },
	{ value: "cpp14", label: "C++14" },
	{ value: "cpp17", label: "C++17" },
	{ value: "cpp20", label: "C++20" },
	{ value: "cpp23", label: "C++23" },
	{ value: "cpp26", label: "C++26（实验性）" },
];

export interface ProgramSource {
	language: ProgramLanguage;
	code: string;
}

export interface ProjectCase {
	id: string;
	origin: "manual" | "generated";
	inputFile: string;
	outputFile?: string;
	inputBytes: number;
	outputBytes?: number;
	subtaskId: number;
}

export interface ManualCheck {
	stage: string;
	caseId?: string;
	passed: boolean;
	message: string;
}

export interface ManualReport {
	mode: "generate" | "finalize";
	success: boolean;
	revision?: number;
	projectHash?: string;
	verifiedAt?: string;
	checks: ManualCheck[];
	issues?: Array<{ severity: "error" | "warning"; code: string; path: string; message: string }>;
	caseCount: number;
	generatedCount: number;
	oracleCount: number;
	validatorUsed: boolean;
	checkerUsed: boolean;
}

export interface ProjectSnapshot {
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
	reference: ProgramSource;
	oracle?: ProgramSource;
	generatorSource: string;
	generatorStandard: CppLanguage;
	generatorScript: string;
	checkerSource: string;
	checkerMode?: "text" | "custom";
	checkerStandard: CppLanguage;
	validatorSource: string;
	validatorStandard: CppLanguage;
	subtasks: Array<{ id: number; type: "sum" | "min" | "max"; score: number }>;
	caseSubtasks: Record<string, number>;
	attachments: Array<{ name: string; contentBase64: string }>;
	domjudgePdf?: { size: number; sha256: string };
	generatedFromHash?: string;
	latestReleaseId?: string;
	lastReport?: ManualReport;
	cases: ProjectCase[];
	orphanOutputs: string[];
}

export interface ManualRelease {
	id: string;
	scoringMode?: "acm" | "oi";
	projectId: string;
	revision: number;
	projectHash: string;
	slug: string;
	title: string;
	createdAt: string;
	report: ManualReport;
	checkerMode?: "text" | "custom";
	domjudgePdf?: boolean;
	liveVerification?: {
		success: boolean;
		message: string;
		problemUrl?: string;
		reference: { verdict: string; score?: number; accepted: boolean };
	};
}

export function isContestReadyRelease(release: ManualRelease): boolean {
	return (
		release.report.success &&
		release.report.mode === "finalize" &&
		release.report.checkerUsed &&
		(release.checkerMode === "text" || release.checkerMode === "custom") &&
		(release.scoringMode === "acm" || release.scoringMode === "oi")
	);
}

export interface ContestDraft {
	id: string;
	title: string;
	slug: string;
	releaseIds: string[];
	colors: Record<string, string>;
	colorNames: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface ContestRelease {
	id: string;
	contestId: string;
	title: string;
	slug: string;
	format: "hydro" | "domjudge";
	problems: Array<{
		label: string;
		releaseId: string;
		projectHash: string;
		title: string;
		color?: string;
		colorName?: string;
	}>;
	createdAt: string;
}

export interface SandboxStatus {
	available: boolean;
	image: string;
	message: string;
}

export interface AiProviderOption {
	id: string;
	name: string;
	models: Array<{ id: string; name: string }>;
}

export interface AiProfile {
	id: string;
	name: string;
	provider: string;
	modelId: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
	apiKeyConfigured: boolean;
}

export interface AiConfiguration {
	configured: boolean;
	defaultProfileId?: string;
	profiles: AiProfile[];
	providers: AiProviderOption[];
	error?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	images?: ChatImage[];
	createdAt: string;
	contextSnapshot?: string;
	profileId?: string;
	modelId?: string;
}

export interface ChatImage {
	id: string;
	name: string;
	mimeType: string;
	bytes: number;
}

export interface ChatImageUpload {
	name: string;
	mimeType: string;
	data: string;
}

export interface ChatConversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	profileId?: string;
	messages: ChatMessage[];
}

export function pageFromHash(hash: string): PageRoute {
	if (hash === "#chat") return "chat";
	if (hash === "#records") return "records";
	if (hash === "#contests") return "contests";
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
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("API 根地址只支持 http:// 或 https://。");
	if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("API 根地址只填写协议、域名和端口。");
	}
	return url.origin;
}

export function apiUrl(apiOrigin: string, route: string): string {
	const suffix = route.startsWith("/") ? route : `/${route}`;
	return `${apiOrigin.replace(/\/+$/u, "")}/api${suffix}`;
}

export function apiStatusLabel(status: ApiStatus): string {
	if (status === "online") return "API 已连接";
	if (status === "offline") return "API 未连接";
	return "正在连接 API";
}

export function readAiConfiguration(value: unknown): AiConfiguration | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.configured !== "boolean" || !Array.isArray(record.profiles) || !Array.isArray(record.providers))
		return undefined;
	if (Object.hasOwn(record, "apiKey")) return undefined;
	for (const profile of record.profiles) {
		if (
			typeof profile !== "object" ||
			profile === null ||
			Array.isArray(profile) ||
			typeof profile.id !== "string" ||
			typeof profile.name !== "string" ||
			typeof profile.provider !== "string" ||
			typeof profile.modelId !== "string" ||
			typeof profile.contextWindow !== "number" ||
			typeof profile.maxTokens !== "number" ||
			typeof profile.apiKeyConfigured !== "boolean" ||
			Object.hasOwn(profile, "apiKey")
		)
			return undefined;
	}
	for (const provider of record.providers) {
		if (
			typeof provider !== "object" ||
			provider === null ||
			typeof provider.id !== "string" ||
			typeof provider.name !== "string"
		)
			return undefined;
	}
	return value as AiConfiguration;
}

export function responseError(value: unknown, fallback = "请求失败，请检查本地 API。") {
	if (typeof value !== "object" || value === null) return fallback;
	const message = (value as Record<string, unknown>).message;
	return typeof message === "string" ? message : fallback;
}
