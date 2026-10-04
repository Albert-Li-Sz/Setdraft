export { interactiveReferenceTemplate, interactorTemplate } from "./interactive-templates.ts";

import { type BoundaryCondition, isBoundaryConditions } from "./authoring-insights.ts";
import { type Generator, type GeneratorLanguage, isGenerator } from "./generators.ts";
import {
	type CommunicationConfig,
	isCompleteCommunicationResult,
	isProblemType,
	isProtocolSamples,
	type ProblemType,
	type ProtocolSample,
	type RoundResult,
	resolveProblemType,
	synchronizeProblemType,
	usesProtocol,
} from "./problem-types.ts";
import type { Solution, VerificationOptions } from "./verification.ts";
import { isSolution } from "./verification.ts";

export * from "./authoring-insights.ts";
export * from "./communication-templates.ts";
export * from "./generators.ts";
export * from "./problem-types.ts";
export * from "./verification.ts";

export type CheckerMode = "text" | "custom";
export const verificationContractVersion = 7;
export const exportContractVersion = 5;
export type JudgingMode = "default" | "interactive";
export type InteractionInputMode = "provided" | "empty";
export type ChatProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

import { cppLanguages } from "./languages.ts";

export { cppLanguages } from "./languages.ts";
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
	verdict?: "AC" | "WA" | "CE" | "RE" | "TLE" | "MLE" | "SYSTEM_ERROR";
	score?: number;
	scoreRatio?: number;
	durationMs?: number;
	memoryBytes?: number;
	logPath?: string;
	rounds?: RoundResult[];
	failedRound?: 1 | 2;
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
	interactorUsed?: boolean;
	communicationUsed?: boolean;
	toolchain?: { cpp: string; python: string; java: string };
}

export interface ManualSubtask {
	id: number;
	type: "sum" | "min" | "max";
	score: number;
}

export interface StatementSections {
	description: string;
	input: string;
	output: string;
	interaction: string;
	communication?: string;
	firstRound?: string;
	secondRound?: string;
	notes: string;
}

export interface ManualProject {
	id: string;
	scoringMode: "acm" | "oi";
	problemType?: ProblemType;
	communication?: CommunicationConfig;
	protocolSamples?: ProtocolSample[];
	judgingMode?: JudgingMode;
	interactionInputMode?: InteractionInputMode;
	interactorSource?: string;
	interactorStandard?: CppLanguage;
	revision: number;
	createdAt: string;
	updatedAt: string;
	slug: string;
	title: string;
	tags: string[];
	statement: string;
	statementSections?: StatementSections;
	samples: Array<{ input: string; output: string }>;
	timeLimit: string;
	memoryLimit: string;
	reference: ManualProgram;
	oracle?: ManualProgram;
	solutions?: Solution[];
	referenceSolutionId?: string;
	generatorSource: string;
	generatorStandard: GeneratorLanguage;
	generators?: Generator[];
	generatorSequence?: number;
	generatorScript: string;
	checkerSource: string;
	checkerMode?: CheckerMode;
	checkerStandard: CppLanguage;
	validatorSource: string;
	validatorStandard: CppLanguage;
	subtasks: ManualSubtask[];
	caseSubtasks: Record<string, number>;
	boundaryConditions?: BoundaryCondition[];
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
	inputHash?: string;
	outputBytes?: number;
	outputHash?: string;
	subtaskId: number;
}

export interface ManualProjectSnapshot extends ManualProject {
	cases: ManualCaseSummary[];
	orphanOutputs: string[];
	dataIssues?: Array<{ code: "ANSWER_CONFLICT"; files: string[] }>;
}

export interface AddedManualCase {
	inputFile: string;
	outputFile?: string;
	project: ManualProjectSnapshot;
}

export interface ManualVerificationReport extends ManualSandboxReport {
	verificationContractVersion?: number;
	revision: number;
	projectHash: string;
	issues: Array<{ severity: "error" | "warning"; code: string; path: string; message: string }>;
	verifiedAt: string;
	matrixRunId?: string;
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
	problemType?: ProblemType;
	communication?: CommunicationConfig;
	judgingMode?: JudgingMode;
	interactionInputMode?: InteractionInputMode;
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
	exports?: Partial<Record<"domjudge" | "fps" | "qduoj", { contractVersion: number; createdAt: string }>>;
}

export type ContestFormat = "hydro" | "domjudge";

export interface ContestPdfOptions {
	enabled: boolean;
	subtitle: string;
	author: string;
	date: string;
	coverNotes: string;
	titlePage: boolean;
	problemList: boolean;
	headerFooter: boolean;
	language: "zh" | "en";
	titlePageLanguage: "auto" | "zh" | "en";
	problemLanguage: "auto" | "zh" | "en";
}

export const defaultContestPdfOptions: Readonly<ContestPdfOptions> = {
	enabled: false,
	subtitle: "试题册",
	author: "",
	date: "",
	coverNotes: "",
	titlePage: true,
	problemList: true,
	headerFooter: true,
	language: "zh",
	titlePageLanguage: "auto",
	problemLanguage: "auto",
};

export interface ContestDraft {
	id: string;
	revision: number;
	title: string;
	slug: string;
	releaseIds: string[];
	colors: Record<string, string>;
	colorNames: Record<string, string>;
	pdf?: ContestPdfOptions;
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
	pdf?: ContestPdfOptions;
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

export interface SearchResult {
	id: number;
	title: string;
	url: string;
	snippet: string;
}
export type SearchHealth =
	| "healthy"
	| "partial"
	| "no-match"
	| "engines-unavailable"
	| "filtered-empty"
	| "configuration"
	| "timeout"
	| "network"
	| "http"
	| "invalid-response";
export interface SearchDiagnostics {
	status: SearchHealth;
	checkedAt: string;
	durationMs: number;
	candidateCount: number;
	acceptedCount: number;
	httpStatus?: number;
	engines: Array<{ name: string; category: "timeout" | "captcha" | "http" | "network" | "other" }>;
}
export interface SearchDiagnosticReport {
	provider: "searxng" | "tavily";
	language: "zh" | "en";
	aggregate: SearchDiagnostics;
	engines: Array<{ name: string; diagnostics: SearchDiagnostics }>;
}
export interface SearchSnapshot {
	cached?: boolean;
	query: string;
	queries?: string[];
	provider: "searxng" | "tavily";
	searchedAt: string;
	results: SearchResult[];
	diagnostics?: SearchDiagnostics;
}
export type SearchPhase = "planning" | "searching" | "complete" | "failed";
export interface SearchQueryResult {
	query: string;
	state?: "pending" | "searching" | "complete" | "failed" | "cancelled";
	status?: SearchHealth;
	message?: string;
	count?: number;
	durationMs?: number;
	cached?: boolean;
}
export interface SearchPlan {
	queries: string[];
	source: "manual" | "ai";
	state: "ready" | "failed";
	usage?: ChatUsage;
	results?: SearchQueryResult[];
}
export interface ChatMessage {
	finishReason?: "stop" | "length" | "refusal" | "toolUse";
	complete?: boolean;
	search?: SearchSnapshot;
	searchError?: string;
	searchStatus?: SearchHealth;
	searchPlan?: SearchPlan;
	answerUsage?: ChatUsage;
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
	webSearch?: boolean;
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	profileId?: string;
	messages: ChatMessage[];
}

export interface ChatRequest {
	id: string;
	attemptId?: string;
	chatId: string;
	state: "queued" | "running" | "done" | "failed";
	createdAt: string;
	updatedAt: string;
	error?: string;
}

export interface ChatRequestEvent {
	sequence: number;
	type: "start" | "delta" | "done" | "error" | "search";
	data: unknown;
}

export type TaskKind =
	| "generate"
	| "finalize"
	| "contest-export"
	| "release-export"
	| "image-build"
	| "matrix"
	| "pressure"
	| "stress";
export type TaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "stale" | "interrupted";

export interface TaskRecord {
	resourceTitle?: string;
	problemType?: ProblemType;
	releaseName?: string;
	verification?: VerificationOptions;
	replayOf?: string;
	id: string;
	kind: TaskKind;
	resource: string;
	format?: ContestFormat;
	state: TaskState;
	cleanupPending?: boolean;
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	error?: string;
	ownerPid?: number;
	queue?: {
		/** Position within this user's FIFO queue, not a global ETA. */
		position: number;
		running: number;
		concurrency: number;
		reason: "user" | "maintenance" | "capacity" | "dispatch";
		expiresAt: string;
	};
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
	Partial<
		Pick<
			ManualVerificationReport,
			"revision" | "projectHash" | "verifiedAt" | "issues" | "verificationContractVersion"
		>
	>;
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
	| { type: "search"; phase: SearchPhase; query: string; message?: string; results?: SearchQueryResult[] }
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
	const primaryChecks = release.report?.checks.filter((check) => check.stage === "interaction:reference") ?? [];
	return (
		!requiresReverification(release) &&
		release.report?.success === true &&
		release.report.mode === "finalize" &&
		(resolveProblemType(release) === "communication"
			? release.report.communicationUsed === true &&
				release.report.caseCount > 0 &&
				primaryChecks.length === release.report.caseCount &&
				new Set(primaryChecks.map((check) => check.caseId)).size === release.report.caseCount &&
				primaryChecks.every(
					(check) =>
						Boolean(check.caseId) &&
						check.passed &&
						check.verdict === "AC" &&
						check.score === 100 &&
						isCompleteCommunicationResult(check),
				)
			: usesProtocol(release)
				? release.report.interactorUsed === true
				: release.report.checkerUsed && (release.checkerMode === "text" || release.checkerMode === "custom")) &&
		(release.scoringMode === "acm" || release.scoringMode === "oi")
	);
}

export function requiresReverification(release: ManualRelease): boolean {
	return release.report?.verificationContractVersion !== verificationContractVersion;
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
		(value.interactorUsed === undefined || typeof value.interactorUsed === "boolean") &&
		(value.communicationUsed === undefined || typeof value.communicationUsed === "boolean") &&
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
	if (value.boundaryConditions !== undefined && !isBoundaryConditions(value.boundaryConditions)) return false;
	if (
		value.solutions !== undefined &&
		(!Array.isArray(value.solutions) ||
			!value.solutions.length ||
			value.solutions.length > 32 ||
			!value.solutions.every(isSolution) ||
			new Set(value.solutions.map((item) => item.id)).size !== value.solutions.length ||
			!value.solutions.some(
				(item) => item.id === value.referenceSolutionId && item.required && item.expectation.kind === "AC",
			))
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
	if (!["checkerStandard", "validatorStandard"].every((key) => cppLanguages.includes(value[key] as CppLanguage)))
		return false;
	if (![...cppLanguages, "python3"].includes(String(value.generatorStandard))) return false;
	if (
		value.generators !== undefined &&
		(!Array.isArray(value.generators) ||
			value.generators.length > 32 ||
			!value.generators.every(isGenerator) ||
			new Set(value.generators.map((item) => item.id)).size !== value.generators.length ||
			new Set(value.generators.map((item) => item.name)).size !== value.generators.length)
	)
		return false;
	if (
		value.generatorSequence !== undefined &&
		(!Number.isSafeInteger(value.generatorSequence) || Number(value.generatorSequence) < 1)
	)
		return false;
	if (value.problemType !== undefined && !isProblemType(value.problemType)) return false;
	if (
		value.communication !== undefined &&
		(!object(value.communication) ||
			typeof value.communication.judgeSource !== "string" ||
			value.communication.judgeSource.length > 200_000 ||
			!cppLanguages.includes(value.communication.judgeStandard as CppLanguage) ||
			!["interactive", "text", "custom"].includes(String(value.communication.secondRound)))
	)
		return false;
	if (value.protocolSamples !== undefined && !isProtocolSamples(value.protocolSamples)) return false;
	if (value.checkerMode !== undefined && value.checkerMode !== "text" && value.checkerMode !== "custom") return false;
	if (value.judgingMode !== undefined && value.judgingMode !== "default" && value.judgingMode !== "interactive")
		return false;
	if (
		value.interactionInputMode !== undefined &&
		value.interactionInputMode !== "provided" &&
		value.interactionInputMode !== "empty"
	)
		return false;
	if (value.interactorSource !== undefined && typeof value.interactorSource !== "string") return false;
	if (
		value.statementSections !== undefined &&
		(!object(value.statementSections) ||
			!["description", "input", "output", "interaction", "notes"].every(
				(key) => typeof (value.statementSections as Record<string, unknown>)[key] === "string",
			) ||
			!["communication", "firstRound", "secondRound"].every(
				(key) =>
					value.statementSections &&
					object(value.statementSections) &&
					(value.statementSections[key] === undefined || typeof value.statementSections[key] === "string"),
			))
	)
		return false;
	if (value.interactorStandard !== undefined && !cppLanguages.includes(value.interactorStandard as CppLanguage))
		return false;
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
	synchronizeProblemType(value);
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
