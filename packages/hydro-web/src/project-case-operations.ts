import type { ProjectSnapshot } from "@setdraft/contracts";
import { apiUrl, requestJson } from "./api-client.ts";
import type { ProjectSession } from "./project-session.ts";

export interface CaseOperationScope {
	projectId: string;
	signal: AbortSignal;
	expectedRevision?: number;
}

export async function manageProjectCases(
	session: ProjectSession,
	apiOrigin: string,
	scope: CaseOperationScope,
	action: "batch-delete" | "renumber" | "clear-generated",
	stems?: string[],
): Promise<ProjectSnapshot> {
	const assertScope = () => {
		const project = session.getSnapshot().project;
		if (!project || scope.projectId !== project.id || scope.signal !== session.signal || scope.signal.aborted)
			throw new DOMException("题目会话已变化", "AbortError");
		return project;
	};
	assertScope();
	await session.flush();
	const target = assertScope();
	if (scope.expectedRevision !== undefined && target.revision !== scope.expectedRevision)
		throw new Error("题目版本已变化，请重新预览编号。");
	const path =
		action === "clear-generated"
			? `/projects/${scope.projectId}/generated`
			: `/projects/${scope.projectId}/cases/${action}`;
	const snapshot = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, path), {
		method: action === "clear-generated" ? "DELETE" : "POST",
		signal: scope.signal,
		headers: { "content-type": "application/json", "x-expected-revision": String(target.revision) },
		...(action !== "clear-generated" ? { body: JSON.stringify({ stems, expectedRevision: target.revision }) } : {}),
	});
	assertScope();
	return snapshot;
}
