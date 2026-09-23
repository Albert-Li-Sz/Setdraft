import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isSafeFlatName } from "@hydro-problem-make/authoring";
import type { HydroAuthoringProject } from "./authoring-project.ts";
import type { GroupedAuthoringFailure } from "./failure-summary.ts";

export type HydroAuthoringProjectPatch = Partial<
	Omit<HydroAuthoringProject, "checker" | "checkerProbes" | "interactor">
> & {
	checker?: string | null;
	interactor?: string | null;
	checkerProbes?: HydroAuthoringProject["checkerProbes"] | null;
};

export interface HydroAuthoringDraft {
	revision: number;
	project: Partial<HydroAuthoringProject>;
	quickFailure?: { signature: string; revisions: number[]; diagnostic: string };
}

export interface HydroAuthoringDraftUpdate {
	revision: number;
	complete: boolean;
	missingFields: string[];
}

const requiredFields = [
	"reference",
	"oracle",
	"generator",
	"validator",
	"cases",
	"invalidInputs",
	"wrongPrograms",
	"timeLimitMs",
	"memoryLimitMb",
	"analysis",
] as const satisfies ReadonlyArray<keyof HydroAuthoringProject>;

function draftPath(workspaceRoot: string, runId: string): string {
	if (!isSafeFlatName(runId)) throw new Error("runId must be a flat ASCII name.");
	return join(resolve(workspaceRoot), "artifacts", runId, "authoring", "draft.json");
}

async function readDraft(path: string): Promise<HydroAuthoringDraft> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as HydroAuthoringDraft;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, project: {} };
		throw error;
	}
}

function mergePatch(
	project: Partial<HydroAuthoringProject>,
	patch: HydroAuthoringProjectPatch,
): Partial<HydroAuthoringProject> {
	const { checker, checkerProbes, interactor, ...fields } = patch;
	const merged: Partial<HydroAuthoringProject> = { ...project, ...fields };
	if (checker === null) delete merged.checker;
	else if (checker !== undefined) merged.checker = checker;
	if (interactor === null) delete merged.interactor;
	else if (interactor !== undefined) merged.interactor = interactor;
	if (checkerProbes === null) delete merged.checkerProbes;
	else if (checkerProbes !== undefined) merged.checkerProbes = checkerProbes;
	return merged;
}

export function missingAuthoringFields(project: Partial<HydroAuthoringProject>): string[] {
	return requiredFields.filter((field) => project[field] === undefined);
}

export async function updateAuthoringDraft(
	workspaceRoot: string,
	runId: string,
	patch: HydroAuthoringProjectPatch,
): Promise<HydroAuthoringDraftUpdate> {
	const path = draftPath(workspaceRoot, runId);
	const current = await readDraft(path);
	const next: HydroAuthoringDraft = {
		revision: current.revision + 1,
		project: mergePatch(current.project, patch),
		quickFailure: current.quickFailure,
	};
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(next));
	await rename(temporary, path);
	const missingFields = missingAuthoringFields(next.project);
	return { revision: next.revision, complete: missingFields.length === 0, missingFields };
}

export async function recordQuickFailure(
	workspaceRoot: string,
	runId: string,
	revision: number,
	failures: readonly GroupedAuthoringFailure[],
): Promise<{ stalled: boolean; repeatedRevisions: number; diagnostic?: string }> {
	const path = draftPath(workspaceRoot, runId);
	const draft = await readDraft(path);
	if (draft.revision !== revision) return { stalled: false, repeatedRevisions: 0 };
	const primary = failures[0];
	if (!primary) {
		delete draft.quickFailure;
	} else if (draft.quickFailure?.signature === primary.signature) {
		draft.quickFailure = {
			signature: primary.signature,
			revisions: [...new Set([...draft.quickFailure.revisions, revision])].slice(-3),
			diagnostic: primary.message,
		};
	} else {
		draft.quickFailure = { signature: primary.signature, revisions: [revision], diagnostic: primary.message };
	}
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(draft));
	await rename(temporary, path);
	const repeatedRevisions = draft.quickFailure?.revisions.length ?? 0;
	return {
		stalled: repeatedRevisions >= 3,
		repeatedRevisions,
		diagnostic: draft.quickFailure?.diagnostic,
	};
}

export async function loadAuthoringDraft(workspaceRoot: string, runId: string): Promise<HydroAuthoringDraft> {
	return readDraft(draftPath(workspaceRoot, runId));
}

export async function resetQuickFailure(workspaceRoot: string, runId: string): Promise<void> {
	const path = draftPath(workspaceRoot, runId);
	const draft = await readDraft(path);
	if (!draft.quickFailure) return;
	delete draft.quickFailure;
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(draft));
	await rename(temporary, path);
}

export async function loadCompleteAuthoringProject(
	workspaceRoot: string,
	runId: string,
): Promise<{ revision: number; project: HydroAuthoringProject }> {
	const draft = await loadAuthoringDraft(workspaceRoot, runId);
	const missingFields = missingAuthoringFields(draft.project);
	if (missingFields.length)
		throw new Error(`制题草稿尚缺少字段：${missingFields.join("、")}。请先调用 update_hydro_authoring 补齐。`);
	return { revision: draft.revision, project: draft.project as HydroAuthoringProject };
}
