import type { ManualProjectSnapshot } from "./index.ts";

export type BoundaryRule =
	| { kind: "cases"; caseIds: string[] }
	| { kind: "integer"; token: number; min?: string; max?: string };
export interface BoundaryCondition {
	id: string;
	name: string;
	rule: BoundaryRule;
}

const integer = (value: unknown): value is string => typeof value === "string" && /^-?\d{1,100}$/u.test(value);
export function isBoundaryConditions(value: unknown): value is BoundaryCondition[] {
	if (!Array.isArray(value) || value.length > 32) return false;
	const ids = new Set<string>();
	return value.every((item: unknown) => {
		if (!item || typeof item !== "object") return false;
		const entry = item as Record<string, unknown>;
		if (
			typeof entry.id !== "string" ||
			!/^[\w-]{1,64}$/u.test(entry.id) ||
			ids.has(entry.id) ||
			typeof entry.name !== "string" ||
			!entry.name.trim() ||
			entry.name.length > 120 ||
			!entry.rule ||
			typeof entry.rule !== "object"
		)
			return false;
		ids.add(entry.id);
		const rule = entry.rule as Record<string, unknown>;
		if (rule.kind === "cases")
			return (
				Array.isArray(rule.caseIds) &&
				rule.caseIds.length <= 1000 &&
				rule.caseIds.every((id: unknown) => typeof id === "string" && /^[\w.:-]{1,200}$/u.test(id)) &&
				new Set(rule.caseIds).size === rule.caseIds.length
			);
		if (
			rule.kind !== "integer" ||
			!Number.isSafeInteger(rule.token) ||
			Number(rule.token) < 1 ||
			Number(rule.token) > 10000
		)
			return false;
		if (rule.min === undefined && rule.max === undefined) return false;
		if (rule.min !== undefined && !integer(rule.min)) return false;
		if (rule.max !== undefined && !integer(rule.max)) return false;
		return rule.min === undefined || rule.max === undefined || BigInt(String(rule.min)) <= BigInt(String(rule.max));
	});
}

export interface AuthoringTarget {
	tab: "statement" | "data" | "generator" | "programs" | "validation";
	section?: string;
	caseId?: string;
	solutionId?: string;
	field?: string;
}
export interface AuthoringIssue {
	code: string;
	severity: "error" | "warning";
	message: AuthoringMessage;
	target: AuthoringTarget;
	caseIds?: string[];
}
export type AuthoringMessage = string | { key: string; values: Array<string | number> };
export interface FaultDetection {
	solutionId: string;
	name: string;
	required: boolean;
	state: "detected" | "all-ac" | "pending" | "incomplete";
	matches?: boolean;
	runId?: string;
	caseIds: string[];
}
export interface BoundaryCoverage {
	id: string;
	name: string;
	kind: BoundaryRule["kind"];
	caseIds: string[];
	missingCaseIds: string[];
}
export interface DataQualityReport {
	projectId: string;
	revision: number;
	createdAt: string;
	caseCount: number;
	intentionalEmpty: boolean;
	issues: AuthoringIssue[];
	duplicates: string[][];
	subtasks: Array<{ id: number; score: number; caseCount: number; zeroPointCases: string[] }>;
	faults: FaultDetection[];
	undistinguishedCaseIds: string[];
	discriminationComplete: boolean;
	boundaries: BoundaryCoverage[];
}
export interface ReadinessCheck {
	id: string;
	label: AuthoringMessage;
	state: "ready" | "pending" | "error" | "warning";
	message: AuthoringMessage;
	target: AuthoringTarget;
}
export interface PublicationReadiness {
	projectId: string;
	revision: number;
	checks: ReadinessCheck[];
	platforms: Array<{ id: "hydro" | "domjudge" | "fps" | "qduoj"; supported: boolean; reason: string }>;
	verified: boolean;
}
export interface DraftRevisionSummary {
	id: string;
	projectId: string;
	revision: number;
	savedAt: string;
	title: string;
	caseCount: number;
	current?: boolean;
}
export interface DraftRevision extends DraftRevisionSummary {
	project: ManualProjectSnapshot;
}
