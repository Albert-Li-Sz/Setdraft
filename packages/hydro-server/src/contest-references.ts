import type { ContestDraft } from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

/** Caller holds the same workspace transaction used for selection and deletion. */
export async function assertReleasesUnreferenced(database: WorkspaceDatabase, releaseIds: string[]): Promise<void> {
	const targeted = new Set(releaseIds);
	for (const draft of await database.list<ContestDraft>("contest")) {
		if (draft.releaseIds.some((id) => targeted.has(id)))
			throw new ManualProjectError(`题目已被竞赛“${draft.title}”引用，请先从竞赛移出再删除。`, 409);
	}
}
