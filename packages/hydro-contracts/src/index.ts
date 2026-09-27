export type CheckerMode = "text" | "custom";
export type ChatProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";
export const cppLanguages = ["cpp11", "cpp14", "cpp17", "cpp20", "cpp23", "cpp26"] as const;
export type CppLanguage = (typeof cppLanguages)[number];
export type ProgramLanguage = CppLanguage | "python3" | "java";
export interface ManualProgram {
	language: ProgramLanguage;
	code: string;
}

export interface ManualCheck {
	stage: string;
	caseId?: string;
	passed: boolean;
	message: string;
	verdict?: "AC" | "WA" | "CE" | "RE" | "TLE" | "SYSTEM_ERROR";
	score?: number;
	durationMs?: number;
	logPath?: string;
}

export interface ManualSandboxReport {
	mode: "generate" | "finalize";
	success: boolean;
	checks: ManualCheck[];
	caseCount: number;
	generatedCount: number;
	oracleCount: number;
	validatorUsed: boolean;
	checkerUsed: boolean;
	toolchain?: { cpp: string; python: string; java: string };
}

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

export interface HistoricHydroVerification {
	success: boolean;
	startedAt: string;
	finishedAt: string;
	problemUrl?: string;
	import: { success: boolean; message: string };
	reference: { name: string; verdict: string; score?: number; accepted: boolean };
	wrongPrograms: Array<{ name: string; verdict: string; score?: number; accepted: boolean }>;
	message: string;
}

export interface ManualRelease {
	name?: string;
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
	liveVerification?: HistoricHydroVerification;
}

export type ContestFormat = "hydro" | "domjudge";

export interface ContestDraft {
	id: string;
	revision: number;
	title: string;
	slug: string;
	releaseIds: string[];
	colors: Record<string, string>;
	colorNames: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export interface ContestRelease {
	name?: string;
	id: string;
	contestId: string;
	title: string;
	slug: string;
	format: ContestFormat;
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

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	images?: ChatImage[];
	createdAt: string;
	contextSnapshot?: string;
	profileId?: string;
	modelId?: string;
	api?: ChatProtocol;
	requestId?: string;
	usage?: ChatUsage;
}

export interface ChatConversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	profileId?: string;
	messages: ChatMessage[];
}

export interface ChatRequest {
	id: string;
	chatId: string;
	state: "queued" | "running" | "done" | "failed";
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface ChatRequestEvent {
	sequence: number;
	type: "start" | "delta" | "done" | "error";
	data: unknown;
}

export type TaskKind = "generate" | "finalize" | "contest-export" | "image-build";
export type TaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale" | "interrupted";

export interface TaskRecord {
	resourceTitle?: string;
	releaseName?: string;
	id: string;
	kind: TaskKind;
	resource: string;
	format?: ContestFormat;
	state: TaskState;
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	error?: string;
	ownerPid?: number;
}

export interface TaskEvent {
	sequence: number;
	taskId: string;
	type: string;
	message: string;
	createdAt: string;
	data?: unknown;
}

export interface ChatUsage {
	input: number;
	output: number;
	totalTokens: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export type ProgramSource = ManualProgram;
export type ProjectCase = ManualCaseSummary;
export type ProjectSnapshot = ManualProjectSnapshot;
export type ManualReport = ManualSandboxReport &
	Partial<Pick<ManualVerificationReport, "revision" | "projectHash" | "verifiedAt" | "issues">>;
export type BackgroundTask<T = unknown> = Omit<TaskRecord, "result"> & { result?: T };
export type ProjectUpdate = Partial<
	Omit<
		ManualProject,
		"id" | "createdAt" | "updatedAt" | "revision" | "lastReport" | "latestReleaseId" | "generatedFromHash" | "oracle"
	>
> & { oracle?: ManualProgram | null; expectedRevision: number };
export interface ApiErrorBody {
	error: string;
	message: string;
	current?: unknown;
}
export type ChatStreamEvent =
	| { type: "start"; chat: ChatConversation }
	| { type: "delta"; delta: string }
	| { type: "done"; chat: ChatConversation }
	| { type: "error"; message: string };
export interface SandboxStatus {
	available: boolean;
	image: string;
	message: string;
	state?: "ready" | "image-missing" | "daemon-unavailable";
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

export function isContestReadyRelease(release: ManualRelease): boolean {
	return (
		release.report.success &&
		release.report.mode === "finalize" &&
		release.report.checkerUsed &&
		(release.checkerMode === "text" || release.checkerMode === "custom") &&
		(release.scoringMode === "acm" || release.scoringMode === "oi")
	);
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function program(value: unknown): boolean {
	return (
		object(value) &&
		typeof value.code === "string" &&
		[...cppLanguages, "python3", "java"].includes(String(value.language))
	);
}
function report(value: unknown): boolean {
	return (
		object(value) &&
		(value.mode === "generate" || value.mode === "finalize") &&
		typeof value.success === "boolean" &&
		typeof value.validatorUsed === "boolean" &&
		typeof value.checkerUsed === "boolean" &&
		["caseCount", "generatedCount", "oracleCount"].every((key) => Number.isSafeInteger(value[key])) &&
		Array.isArray(value.checks) &&
		value.checks.every(
			(item) =>
				object(item) &&
				typeof item.stage === "string" &&
				typeof item.passed === "boolean" &&
				typeof item.message === "string",
		)
	);
}

/** Validate snapshots before adopting a response as the next editable revision. */
export function isProjectSnapshot(value: unknown): value is ProjectSnapshot {
	if (
		!object(value) ||
		!["acm", "oi"].includes(String(value.scoringMode)) ||
		!Number.isSafeInteger(value.revision) ||
		Number(value.revision) < 0
	)
		return false;
	if (
		![
			"id",
			"createdAt",
			"updatedAt",
			"slug",
			"title",
			"statement",
			"timeLimit",
			"memoryLimit",
			"generatorSource",
			"generatorScript",
			"checkerSource",
			"validatorSource",
		].every((key) => typeof value[key] === "string")
	)
		return false;
	if (
		!["generatorStandard", "checkerStandard", "validatorStandard"].every((key) =>
			cppLanguages.includes(value[key] as CppLanguage),
		)
	)
		return false;
	if (value.checkerMode !== undefined && value.checkerMode !== "text" && value.checkerMode !== "custom") return false;
	if (
		!program(value.reference) ||
		(value.oracle !== undefined && !program(value.oracle)) ||
		!strings(value.tags) ||
		!strings(value.orphanOutputs)
	)
		return false;
	if (
		!Array.isArray(value.samples) ||
		!value.samples.every((item) => object(item) && typeof item.input === "string" && typeof item.output === "string")
	)
		return false;
	if (
		!Array.isArray(value.attachments) ||
		!value.attachments.every(
			(item) => object(item) && typeof item.name === "string" && typeof item.contentBase64 === "string",
		)
	)
		return false;
	if (
		!Array.isArray(value.subtasks) ||
		!value.subtasks.every(
			(item) =>
				object(item) &&
				Number.isSafeInteger(item.id) &&
				Number.isSafeInteger(item.score) &&
				["sum", "min", "max"].includes(String(item.type)),
		)
	)
		return false;
	if (!object(value.caseSubtasks) || !Object.values(value.caseSubtasks).every(Number.isSafeInteger)) return false;
	if (
		!Array.isArray(value.cases) ||
		!value.cases.every(
			(item) =>
				object(item) &&
				typeof item.id === "string" &&
				typeof item.inputFile === "string" &&
				["manual", "generated"].includes(String(item.origin)) &&
				Number.isSafeInteger(item.inputBytes) &&
				Number.isSafeInteger(item.subtaskId) &&
				(item.outputFile === undefined || typeof item.outputFile === "string") &&
				(item.outputBytes === undefined || Number.isSafeInteger(item.outputBytes)),
		)
	)
		return false;
	if (value.lastReport !== undefined && !report(value.lastReport)) return false;
	if (
		value.domjudgePdf !== undefined &&
		(!object(value.domjudgePdf) ||
			!Number.isSafeInteger(value.domjudgePdf.size) ||
			typeof value.domjudgePdf.sha256 !== "string")
	)
		return false;
	return ["latestReleaseId", "generatedFromHash"].every(
		(key) => value[key] === undefined || typeof value[key] === "string",
	);
}

export function readProjectSnapshot(value: unknown): ProjectSnapshot {
	if (!isProjectSnapshot(value)) throw new Error("服务端返回的题目格式无效。");
	return value;
}

export type UserRole = "admin" | "user";
export interface UserPreferences {
	locale?: "zh-CN" | "en";
	avatar?: string;
}
export interface AuthUser extends UserPreferences {
	id: string;
	username: string;
	role: UserRole;
	enabled: boolean;
	mustChangePassword: boolean;
	createdAt: string;
}
export interface AuthSession {
	user: AuthUser | null;
	setupRequired: boolean;
	csrfToken?: string;
	expiresAt?: string;
}
