import type { BackgroundTask } from "@setdraft/contracts";
import { expect, it } from "vitest";
import { matchesSearch } from "../src/list-search.ts";
import { groupTasks, matchesTaskFilter, taskNeedsAttention } from "../src/task-list.ts";

it("finds every search term across title, type, slug and tags without case or width differences", () => {
	const fields = ["A + B", "communication", "acm", "a-plus-b", "求和"];
	expect(matchesSearch("  ＡＣＭ 求和  ", fields)).toBe(true);
	expect(matchesSearch("a-plus-b communication", fields)).toBe(true);
	expect(matchesSearch("communication oi", fields)).toBe(false);
	expect(matchesSearch("", fields)).toBe(true);
});

const task = (state: BackgroundTask["state"], resource = "project:a", cleanupPending = false): BackgroundTask => ({
	id: state,
	kind: "matrix",
	resource,
	state,
	fingerprint: "test",
	createdAt: "",
	updatedAt: "",
	cleanupPending,
});
it("distinguishes normal cancellation from failures while surfacing pending container cleanup", () => {
	for (const state of ["failed", "stale", "interrupted"] as const)
		expect(matchesTaskFilter(task(state), "issues")).toBe(true);
	for (const state of ["queued", "running", "succeeded", "cancelled"] as const)
		expect(taskNeedsAttention(task(state))).toBe(false);
	expect(matchesTaskFilter(task("cancelled", "project:a", true), "issues")).toBe(true);
	expect(matchesTaskFilter(task("queued"), "active")).toBe(true);
	expect(matchesTaskFilter(task("cancelled"), "ended")).toBe(true);
	expect(matchesTaskFilter(task("running"), "ended")).toBe(false);
});
it("groups tasks in server order without copying growing groups or mutating the source", () => {
	const tasks = [task("running"), task("failed", "project:b"), task("succeeded")];
	const groups = groupTasks(tasks);
	expect([...groups.keys()]).toEqual(["project:a", "project:b"]);
	expect(groups.get("project:a")).toEqual([tasks[0], tasks[2]]);
	expect(tasks.map((item) => item.state)).toEqual(["running", "failed", "succeeded"]);
});
