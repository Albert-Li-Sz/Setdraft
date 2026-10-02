import { expect, it } from "vitest";
import { pageFromHash } from "../src/platform.ts";
import { readWorkspaceLocation, workspaceHash } from "../src/workspace-navigation.ts";

it("round trips a matrix link and its filters without interfering with other pages", () => {
	const location = {
		project: "project-id",
		run: "run-id",
		tab: "validation",
		mode: "matrix" as const,
		solution: "wrong",
		subtask: "2",
		abnormal: true,
	};
	expect(readWorkspaceLocation(workspaceHash(location))).toEqual({ ...location, task: undefined });
	expect(pageFromHash("#tasks?task=example")).toBe("tasks");
	expect(pageFromHash(workspaceHash(location))).toBe("workspace");
	expect(readWorkspaceLocation("#tasks?project=example")).toEqual({});
});
it("rejects malformed identifiers and preserves links to queued tasks", () => {
	expect(readWorkspaceLocation("#workspace?project=..%2Fsecret&run=%3Cscript%3E").project).toBeUndefined();
	expect(
		readWorkspaceLocation(
			workspaceHash({ project: "project-id", task: "task-id", mode: "stress", tab: "validation" }),
		),
	).toMatchObject({ project: "project-id", task: "task-id", mode: "stress" });
});
