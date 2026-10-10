import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Solution, VerificationRun } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { firstOutputDifference, RunCheckpoints } from "../src/verification-diagnostics.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";
import { sandboxIt } from "./sandbox-test.ts";

let root: string;
let store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-diagnostics-"));
	store = new ManualProjectStore({ root });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
const solution = (id: string, code: string): Solution => ({
	id,
	name: id,
	code,
	language: "python3",
	purpose: "accepted",
	expectation: { kind: "AC" },
	required: id === "reference",
});

it("finds differences beyond preview limits, including Unicode and EOF", () => {
	expect(firstOutputDifference("same\n", "same\n")).toBeUndefined();
	expect(firstOutputDifference(`${"a\n".repeat(3000)}😀a`, `${"a\n".repeat(3000)}😀b`)).toMatchObject({
		line: 3001,
		column: 2,
		actual: { focus: "a" },
		expected: { focus: "b" },
	});
	expect(firstOutputDifference("abc", "abcd")).toMatchObject({
		line: 1,
		column: 4,
		actual: { focus: "" },
		expected: { focus: "d" },
	});
	expect(firstOutputDifference("a😀", "a😁")).toMatchObject({
		column: 2,
		actual: { focus: "😀" },
		expected: { focus: "😁" },
	});
});
it("drains checkpoint writes before a terminal save and never schedules afterwards", async () => {
	const writes: string[] = [];
	let unblock!: () => void;
	const gate = new Promise<void>((resolve) => {
		unblock = resolve;
	});
	const checkpoints = new RunCheckpoints(async () => {
		writes.push("progress");
		await gate;
	});
	checkpoints.schedule();
	await vi.waitFor(() => expect(writes).toHaveLength(1));
	let finished = false;
	const stopped = checkpoints.stop().then(() => {
		writes.push("terminal");
		finished = true;
	});
	expect(finished).toBe(false);
	unblock();
	await stopped;
	checkpoints.schedule();
	await new Promise((resolve) => setTimeout(resolve, 450));
	expect(writes).toEqual(["progress", "terminal"]);
});
it("paginates tied timestamps without duplication and scopes task/kind/project filters", async () => {
	const project = await store.create("acm"),
		other = await store.create("acm");
	for (let index = 0; index < 8; index++) {
		const run: VerificationRun = {
			id: `run-${index}`,
			projectId: index === 7 ? other.id : project.id,
			revision: 1,
			image: "fixture",
			fingerprint: "fixture",
			createdAt: "2026-10-03T00:00:00.000Z",
			state: "complete",
			taskId: `task-${index}`,
			solutions: [],
			options:
				index === 6
					? {
							kind: "stress",
							baselineId: "reference",
							solutionIds: ["other"],
							command: "gen {seed}",
							seed: 1,
							rounds: 100,
							budgetMs: 60000,
						}
					: { kind: "matrix" },
		};
		await store.database.put("verification-run", run.id, run);
	}
	let cursor: string | undefined;
	const ids: string[] = [];
	do {
		const page = await store.runs.page(project.id, { kind: "matrix", limit: 2, cursor });
		ids.push(...page.runs.map((run) => run.id));
		cursor = page.nextCursor;
	} while (cursor);
	expect(ids).toEqual(["run-5", "run-4", "run-3", "run-2", "run-1", "run-0"]);
	expect((await store.runs.page(project.id, { taskId: "task-6" })).runs[0].options.kind).toBe("stress");
	await expect(store.runs.get(other.id, "run-0")).rejects.toThrow("不存在");
	await expect(store.runs.page(project.id, { cursor: "broken" })).rejects.toThrow("分页");
	await expect(store.runs.page(project.id, { limit: 0 })).rejects.toThrow("分页");
});
it("recovers checkpointed cells after interruption, isolates accounts, and cleans project records", async () => {
	const project = await store.create("acm");
	const run: VerificationRun = {
		id: randomUUID(),
		taskId: randomUUID(),
		projectId: project.id,
		revision: project.revision,
		image: "fixture",
		fingerprint: "fixture",
		createdAt: new Date().toISOString(),
		state: "running",
		solutions: [solution("reference", "print(1)")],
		options: { kind: "matrix" },
		matrix: { cases: [], cells: [], solutions: [], full: true, requiredPassed: false },
		progress: { completed: 1, total: 2, elapsedMs: 1000, message: "manual:1 · AC" },
	};
	await store.database.storeBuffer("verification-file", run.id, "result.json", Buffer.from(JSON.stringify(run)));
	await store.database.put("verification-run", run.id, run);
	const cell = {
		caseId: "manual:1",
		solutionId: "reference",
		verdict: "AC",
		score: 100,
		durationMs: 10,
		message: "ok",
	};
	await store.database.put("verification-progress", `${run.id}:00000000`, {
		projectId: project.id,
		runId: run.id,
		cells: [cell],
		checks: [],
	});
	await store.runs.interrupt(run.taskId!);
	const reopened = new ManualProjectStore({ root });
	const recovered = await reopened.runs.get(project.id, run.id);
	expect(recovered).toMatchObject({
		state: "failed",
		progress: { completed: 1 },
		matrix: { cells: [cell], requiredPassed: false },
	});
	expect(recovered.error).toContain("中断");
	const foreign = new ManualProjectStore({ root, database: new WorkspaceDatabase(root, randomUUID()) });
	await expect(foreign.runs.get(project.id, run.id)).rejects.toThrow("不存在");
	expect(await foreign.database.list("verification-progress")).toEqual([]);
	await store.delete(project.id);
	expect(await store.database.list("verification-progress")).toEqual([]);
	expect(await store.database.list("verification-run")).toEqual([]);
});
sandboxIt(
	"publishes partial cells before completion, keeps full diagnostics, and locates a late difference",
	async () => {
		const project = await store.create("acm");
		await store.update(project.id, {
			checkerMode: "text",
			solutions: [
				solution("reference", 'print("a"*4000 + "x")'),
				solution(
					"wrong",
					'import sys,time\ntime.sleep(0.7)\nsys.stderr.write("diagnostic"*1000)\nprint("a"*4000 + "y")',
				),
			],
			referenceSolutionId: "reference",
		});
		for (let i = 1; i <= 3; i++) await store.addTextCase(project.id, { name: `${i}.in`, input: "1\n" });
		const controller = new AbortController();
		let settled = false;
		const executing = store.runs
			.execute(project.id, { kind: "matrix" }, { id: randomUUID(), signal: controller.signal, emit() {} })
			.finally(() => {
				settled = true;
			});
		void executing.catch(() => {});
		try {
			await vi.waitFor(
				async () => {
					const first = (await store.runs.list(project.id))[0];
					expect(first?.progress?.completed).toBeGreaterThan(0);
					expect(first?.progress?.completed).toBeLessThan(6);
					expect(settled).toBe(false);
					const live = await store.runs.get(project.id, first.id);
					expect(live.matrix?.requiredPassed).toBe(false);
					expect(live.matrix?.cells.length).toBeGreaterThan(0);
				},
				{ timeout: 45000, interval: 100 },
			);
			const run = await executing;
			expect(run.matrix?.cells).toHaveLength(6);
			expect(run.diagnostics).toBe(true);
			const detail = await store.runs.cell(project.id, run.id, "wrong", "manual:1");
			expect(detail).toMatchObject({
				previewOnly: false,
				difference: { line: 1, column: 4001, actual: { focus: "y" }, expected: { focus: "x" } },
			});
			const stderr = detail.cell.artifacts!.logs.find((name) => name.includes("outputs_candidate"))!;
			expect((await readFile(await store.runs.diagnosticFile(project.id, run.id, stderr), "utf8")).length).toBe(
				10000,
			);
			expect((await readFile(await store.runs.diagnosticFile(project.id, run.id))).subarray(0, 2).toString()).toBe(
				"PK",
			);
			await expect(store.runs.diagnosticFile(project.id, run.id, "logs/../../project.json")).rejects.toThrow("路径");
		} finally {
			controller.abort();
			await executing.catch(() => {});
		}
	},
	120000,
);
sandboxIt.each(["cancelled", "timeout"])(
	"retains completed cells and logs after %s",
	async (reason) => {
		const project = await store.create("acm");
		await store.update(project.id, {
			checkerMode: "text",
			solutions: [solution("reference", "print(1)"), solution("slow", "import time\ntime.sleep(0.8)\nprint(1)")],
			referenceSolutionId: "reference",
		});
		for (let i = 0; i < 5; i++) await store.addTextCase(project.id, { name: `${i}.in`, input: "1\n" });
		const controller = new AbortController();
		const result = store.runs
			.execute(project.id, { kind: "matrix" }, { id: randomUUID(), signal: controller.signal, emit() {} })
			.catch((error: unknown) => error);
		try {
			await vi.waitFor(
				async () => expect((await store.runs.list(project.id))[0]?.progress?.completed).toBeGreaterThan(0),
				{ timeout: 45000 },
			);
			controller.abort(reason === "timeout" ? new Error("任务运行超过时间上限，请检查程序后重试。") : undefined);
			expect(await result).toBeInstanceOf(Error);
			const summary = (await store.runs.list(project.id))[0];
			const run = await store.runs.get(project.id, summary.id);
			expect(run.state).toBe(reason === "timeout" ? "failed" : "cancelled");
			expect(run.error).toContain(reason === "timeout" ? "时间上限" : "取消");
			expect(run.matrix?.cells.length).toBeGreaterThan(0);
			expect(run.matrix?.requiredPassed).toBe(false);
			expect(run.diagnostics).toBe(true);
		} finally {
			controller.abort();
			await result;
		}
	},
	120000,
);
