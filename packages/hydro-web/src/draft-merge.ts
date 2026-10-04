import type { ProjectSnapshot } from "@setdraft/contracts";
import { editableProject } from "./problem.ts";

export interface DraftDifference {
	path: string;
	before: unknown;
	after: unknown;
}
export interface DraftConflict {
	path: string;
	base: unknown;
	local: unknown;
	server: unknown;
}
export type DraftChoices = Record<string, "local" | "server">;
const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
export function draftValueEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((value: unknown, index: number) => draftValueEqual(value, b[index]));
	if (record(a) && record(b))
		return [...new Set([...Object.keys(a), ...Object.keys(b)])].every((key) => draftValueEqual(a[key], b[key]));
	return false;
}
const keyed = (value: unknown): value is Array<Record<string, unknown> & { id: string }> =>
	Array.isArray(value) && value.every((item: unknown) => record(item) && typeof item.id === "string");

function merge(
	base: unknown,
	local: unknown,
	server: unknown,
	path: string,
	conflicts: DraftConflict[],
	choices: DraftChoices,
): unknown {
	if (draftValueEqual(base, local)) return server;
	if (draftValueEqual(base, server) || draftValueEqual(local, server)) return local;
	if (record(base) && record(local) && record(server)) {
		const result: Record<string, unknown> = {};
		for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(server)])) {
			const value = merge(base[key], local[key], server[key], path ? `${path}.${key}` : key, conflicts, choices);
			if (value !== undefined) result[key] = value;
		}
		return result;
	}
	if (
		keyed(base) &&
		keyed(local) &&
		keyed(server) &&
		["solutions", "generators", "boundaryConditions"].includes(path)
	) {
		const result: unknown[] = [];
		for (const id of new Set([
			...server.map((item) => item.id),
			...local.map((item) => item.id),
			...base.map((item) => item.id),
		])) {
			const value = merge(
				base.find((item) => item.id === id),
				local.find((item) => item.id === id),
				server.find((item) => item.id === id),
				`${path}[${id}]`,
				conflicts,
				choices,
			);
			if (value !== undefined) result.push(value);
		}
		return result;
	}
	conflicts.push({ path, base, local, server });
	return choices[path] === "server" ? server : local;
}

export function mergeDraft(
	base: ProjectSnapshot,
	local: ProjectSnapshot,
	server: ProjectSnapshot,
	choices: DraftChoices = {},
) {
	const conflicts: DraftConflict[] = [];
	const patch = merge(editableProject(base), editableProject(local), editableProject(server), "", conflicts, choices);
	const project = { ...server, ...(record(patch) ? patch : {}) };
	// The update API uses null to remove the legacy oracle; snapshots use an absent field.
	if (project.oracle === null) delete project.oracle;
	return { project, conflicts };
}

export function draftDifferences(before: ProjectSnapshot, after: ProjectSnapshot): DraftDifference[] {
	const differences: DraftDifference[] = [];
	const visit = (a: unknown, b: unknown, path: string) => {
		if (draftValueEqual(a, b)) return;
		if (record(a) && record(b)) {
			for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
				visit(a[key], b[key], path ? `${path}.${key}` : key);
		} else if (keyed(a) && keyed(b) && ["solutions", "generators", "boundaryConditions"].includes(path)) {
			for (const id of new Set([...a.map((item) => item.id), ...b.map((item) => item.id)]))
				visit(
					a.find((item) => item.id === id),
					b.find((item) => item.id === id),
					`${path}[${id}]`,
				);
		} else differences.push({ path, before: a, after: b });
	};
	visit(
		{ ...editableProject(before), cases: before.cases, domjudgePdf: before.domjudgePdf },
		{ ...editableProject(after), cases: after.cases, domjudgePdf: after.domjudgePdf },
		"",
	);
	return differences;
}
