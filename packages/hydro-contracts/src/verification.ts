import type { ManualCaseSummary, ManualCheck, ManualProgram, ManualProject, ManualSubtask } from "./index.ts";
import { cppLanguages } from "./languages.ts";
import type { ProblemType, RoundResult } from "./problem-types.ts";
import { isCompleteCommunicationResult } from "./problem-types.ts";

export type SolutionPurpose = "accepted" | "brute" | "wrong" | "slow" | "partial";
export type SolutionExpectation =
	| { kind: "AC" | "WA" | "TLE" | "MLE" | "RE" }
	| { kind: "score"; min: number; max: number };
export interface Solution extends ManualProgram {
	id: string;
	name: string;
	purpose: SolutionPurpose;
	expectation: SolutionExpectation;
	required: boolean;
}

export function isSolution(value: unknown): value is Solution {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	if (
		typeof item.id !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(item.id) ||
		typeof item.name !== "string" ||
		!item.name.trim() ||
		item.name.length > 100 ||
		typeof item.code !== "string" ||
		item.code.length > 200_000 ||
		![...cppLanguages, "python3", "java"].includes(String(item.language)) ||
		!["accepted", "brute", "wrong", "slow", "partial"].includes(String(item.purpose)) ||
		typeof item.required !== "boolean"
	)
		return false;
	if (!item.expectation || typeof item.expectation !== "object") return false;
	const expectation = item.expectation as Record<string, unknown>;
	return (
		["AC", "WA", "TLE", "MLE", "RE"].includes(String(expectation.kind)) ||
		(expectation.kind === "score" &&
			typeof expectation.min === "number" &&
			typeof expectation.max === "number" &&
			Number.isFinite(expectation.min) &&
			Number.isFinite(expectation.max) &&
			expectation.min >= 0 &&
			expectation.max <= 100 &&
			expectation.min <= expectation.max)
	);
}

/** Legacy fields are views of this collection, never a second editable source. */
export function projectSolutions(project: Pick<ManualProject, "reference" | "oracle" | "solutions">): Solution[] {
	return (
		project.solutions ?? [
			{
				...project.reference,
				id: "reference",
				name: "标准程序",
				purpose: "accepted",
				expectation: { kind: "AC" },
				required: true,
			},
			...(project.oracle
				? [
						{
							...project.oracle,
							id: "oracle",
							name: "第二标准程序",
							purpose: "accepted" as const,
							expectation: { kind: "AC" as const },
							required: true,
						},
					]
				: []),
		]
	);
}

export function legacyOracleSolution(project: ManualProject): Solution | undefined {
	const eligible = projectSolutions(project).filter(
		(item) =>
			item.id !== (project.referenceSolutionId ?? "reference") && item.required && item.expectation.kind === "AC",
	);
	return eligible.find((item) => item.id === "oracle") ?? eligible[0];
}

export function synchronizeSolutions(project: ManualProject): void {
	project.solutions = projectSolutions(project);
	project.referenceSolutionId ??= "reference";
	const primary = project.solutions.find((item) => item.id === project.referenceSolutionId);
	if (!primary) throw new Error("主标程不存在。");
	project.reference = { language: primary.language, code: primary.code };
	const oracle = legacyOracleSolution(project);
	project.oracle = oracle ? { language: oracle.language, code: oracle.code } : undefined;
}

export interface MatrixCell {
	solutionId: string;
	caseId: string;
	verdict: NonNullable<ManualCheck["verdict"]>;
	score: number;
	/** Unrounded Checker/Interactor fraction, before Hydro case-point allocation. */
	scoreRatio?: number;
	points?: number;
	fullPoints?: number;
	durationMs: number;
	memoryBytes?: number;
	message: string;
	output?: string;
	expected?: string;
	log?: string;
	artifacts?: { output?: string; expected?: string; logs: string[] };
	rounds?: RoundResult[];
	failedRound?: 1 | 2;
}
export interface OutputDifference {
	line: number;
	column: number;
	actual: { before: string; focus: string; after: string };
	expected: { before: string; focus: string; after: string };
}
export interface MatrixDiagnostic {
	cell: MatrixCell;
	difference?: OutputDifference;
	previewOnly: boolean;
}
export interface VerificationRunPage {
	runs: VerificationRun[];
	nextCursor?: string;
}
export interface SolutionResult {
	solutionId: string;
	complete: boolean;
	matches: boolean;
	score: number;
	message: string;
	compile?: ManualCheck;
}
export interface MatrixReport {
	cases: ManualCaseSummary[];
	cells: MatrixCell[];
	solutions: SolutionResult[];
	full: boolean;
	requiredPassed: boolean;
}
export interface MatrixOptions {
	kind: "matrix";
	solutionIds?: string[];
	caseIds?: string[];
}
export interface PressureOptions {
	kind: "pressure";
	solutionIds?: string[];
	caseIds?: string[];
}
export interface StressOptions {
	kind: "stress";
	baselineId: string;
	solutionIds: string[];
	command: string;
	seed: number;
	rounds: number;
	budgetMs: number;
}
export type VerificationOptions = MatrixOptions | PressureOptions | StressOptions;
export interface StressReport {
	completedRounds: number;
	reason: "counterexample" | "rounds" | "budget" | "error";
	message: string;
	seed?: number;
	args?: string[];
	cells: MatrixCell[];
	inputPreview?: string;
	outputPreview?: string;
	truncated?: boolean;
}
export interface VerificationRun {
	id: string;
	taskId?: string;
	projectId: string;
	problemType?: ProblemType;
	verificationContractVersion?: number;
	revision: number;
	fingerprint: string;
	image: string;
	sandboxArgs?: string[];
	createdAt: string;
	finishedAt?: string;
	state: "running" | "complete" | "failed" | "cancelled";
	progress?: { completed: number; total: number; message: string; elapsedMs: number };
	checks?: ManualCheck[];
	diagnostics?: boolean;
	error?: string;
	options: VerificationOptions;
	solutions: Solution[];
	matrix?: MatrixReport;
	stress?: StressReport;
	replayOf?: string;
	importedCase?: string;
}

/** Keep the full exported case order: Hydro assigns sum remainders to the final cases. */
export function allocateCaseScores(subtasks: ManualSubtask[], cases: ManualCaseSummary[]): Map<string, number> {
	const weights = new Map<string, number>();
	for (const subtask of subtasks) {
		const selected = cases.filter((item) => item.subtaskId === subtask.id);
		for (const [index, item] of selected.entries()) {
			const weight =
				subtask.type === "sum"
					? Math.floor(subtask.score / selected.length) +
						(index >= selected.length - (subtask.score % selected.length) ? 1 : 0)
					: subtask.score;
			weights.set(`${item.origin}:${item.id}`, weight);
		}
	}
	return weights;
}

export function aggregateScore(subtasks: ManualSubtask[], cases: ManualCaseSummary[], cells: MatrixCell[]): number {
	const weights = allocateCaseScores(subtasks, cases);
	const results = new Map(cells.map((cell) => [cell.caseId, cell]));
	let total = 0;
	for (const subtask of subtasks) {
		const selected = cases.filter((item) => item.subtaskId === subtask.id);
		if (!selected.length) continue;
		const points = selected.map((item) => {
			const key = `${item.origin}:${item.id}`;
			const cell = results.get(key);
			return Math.floor((weights.get(key) ?? 0) * (cell?.scoreRatio ?? (cell?.score ?? 0) / 100));
		});
		total +=
			subtask.type === "sum"
				? points.reduce((a, b) => a + b, 0)
				: subtask.type === "min"
					? Math.min(...points)
					: Math.max(...points);
	}
	return total;
}

export function evaluateSolution(
	solution: Solution,
	cells: MatrixCell[],
	count: number,
	score: number,
	full: boolean,
): SolutionResult {
	const complete =
		count > 0 &&
		cells.length === count &&
		cells.every(
			(item) =>
				item.verdict !== "CE" &&
				item.verdict !== "SYSTEM_ERROR" &&
				(!item.rounds || isCompleteCommunicationResult(item)),
		);
	const expectation = solution.expectation;
	const matches =
		complete &&
		(expectation.kind === "score"
			? full && score >= expectation.min && score <= expectation.max
			: expectation.kind === "AC"
				? cells.every((item) => item.verdict === "AC" && item.score === 100)
				: cells.some((item) => item.verdict === expectation.kind) &&
					cells.every((item) => item.verdict === "AC" || item.verdict === expectation.kind));
	return {
		solutionId: solution.id,
		complete,
		matches,
		score,
		message: matches
			? "符合预期"
			: !complete
				? "运行不完整，不能判断预期"
				: expectation.kind !== "AC" && cells.every((item) => item.verdict === "AC" && item.score === 100)
					? "提醒出题人：错误解全部 AC，当前数据未检出此错误"
					: `不符合预期：实际 ${[...new Set(cells.map((item) => item.verdict))].join(" / ")}`,
	};
}
