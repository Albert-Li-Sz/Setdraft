import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { TaskQueue } from "../src/tasks.ts";

let root: string;
const queues: TaskQueue[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-tasks-"));
});

afterEach(async () => {
	for (const queue of queues.splice(0)) queue.close();
	await rm(root, { recursive: true, force: true });
});

async function waitFor(queue: TaskQueue, id: string, state: "running" | "queued" | "succeeded"): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (queue.get(id).state === state) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Task did not reach ${state}.`);
}

describe("persistent task queue", () => {
	it("persists release names across restarts and retries", async () => {
		const projects = new ManualProjectStore({ root });
		const project = await projects.create("acm");
		const initial = new TaskQueue(projects, new ContestStore(projects));
		queues.push(initial);
		initial.close();
		const submitted = await initial.submit("finalize", project.id, undefined, "初版");
		expect(initial.get(submitted.id).releaseName).toBe("初版");
		await initial.cancel(submitted.id);
		const next = new TaskQueue(projects, new ContestStore(projects));
		queues.push(next);
		next.close();
		const retried = await next.retry(submitted.id);
		expect(next.get(retried.id).releaseName).toBe("初版");
		projects.database.db.close();
	});
	it("rolls back a terminal state if its event cannot be persisted", async () => {
		const projects = new ManualProjectStore({ root });
		const queue = new TaskQueue(projects, new ContestStore(projects));
		queues.push(queue);
		queue.close();
		const project = await projects.create("oi");
		const task = await queue.submit("generate", project.id);
		projects.database.db.exec(
			"CREATE TEMP TRIGGER reject_terminal_event BEFORE INSERT ON task_events WHEN NEW.type='cancelled' BEGIN SELECT RAISE(ABORT, 'event storage failed'); END",
		);
		await expect(queue.cancel(task.id)).rejects.toThrow("event storage failed");
		expect(queue.get(task.id).state).toBe("queued");
		expect(queue.events(task.id).map((event) => event.type)).toEqual(["queued"]);
		projects.database.db.exec("DROP TRIGGER reject_terminal_event");
		await queue.cancel(task.id);
		expect(queue.get(task.id).state).toBe("cancelled");
		expect(queue.events(task.id).at(-1)?.type).toBe("cancelled");
		projects.database.db.close();
	});

	it("limits global concurrency to two and rejects another task for the same project", async () => {
		const projects = new ManualProjectStore({ root });
		const resolvers = new Map<string, () => void>();
		vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id) => {
			await new Promise<void>((resolveWork) => resolvers.set(id, resolveWork));
			return {
				project: await projects.get(id),
				report: {
					mode: "generate",
					success: true,
					checks: [],
					caseCount: 0,
					generatedCount: 0,
					oracleCount: 0,
					validatorUsed: false,
					checkerUsed: false,
				},
			};
		});
		const queue = new TaskQueue(projects, new ContestStore(projects));
		queues.push(queue);
		const ids = await Promise.all([projects.create("oi"), projects.create("oi"), projects.create("oi")]);
		const first = await queue.submit("generate", ids[0].id);
		const second = await queue.submit("generate", ids[1].id);
		const third = await queue.submit("generate", ids[2].id);
		await waitFor(queue, first.id, "running");
		await waitFor(queue, second.id, "running");
		expect(queue.get(third.id).state).toBe("queued");
		const competing = new TaskQueue(projects, new ContestStore(projects));
		queues.push(competing);
		await expect(competing.submit("finalize", ids[0].id)).rejects.toThrow("已有排队或运行中的任务");
		resolvers.get(ids[0].id)?.();
		await waitFor(queue, first.id, "succeeded");
		await waitFor(queue, third.id, "running");
		resolvers.get(ids[1].id)?.();
		resolvers.get(ids[2].id)?.();
		await waitFor(queue, second.id, "succeeded");
		await waitFor(queue, third.id, "succeeded");
		expect(queue.events(first.id).map((event) => event.type)).toEqual(["queued", "running", "succeeded"]);
		competing.close();
		queue.close();
		projects.database.db.close();
	});

	it("marks orphaned running work interrupted and keeps it retryable", async () => {
		const projects = new ManualProjectStore({ root });
		const id = randomUUID();
		const now = new Date().toISOString();
		projects.database.db
			.prepare(
				"INSERT INTO tasks (id,kind,resource,state,fingerprint,created_at,updated_at,owner_pid) VALUES (?,?,?,?,?,?,?,?)",
			)
			.run(id, "generate", `project:${randomUUID()}`, "running", "old-hash", now, now, 999999);
		const queue = new TaskQueue(projects, new ContestStore(projects));
		queues.push(queue);
		expect(queue.get(id).state).toBe("interrupted");
		expect(queue.events(id).at(-1)).toMatchObject({ type: "interrupted" });
		queue.close();
		projects.database.db.close();
	});

	it("resumes two queued tasks after a service restart", async () => {
		const projects = new ManualProjectStore({ root });
		const resolvers = new Map<string, () => void>();
		vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id) => {
			await new Promise<void>((resolveWork) => resolvers.set(id, resolveWork));
			return {
				project: await projects.get(id),
				report: {
					mode: "generate",
					success: true,
					checks: [],
					caseCount: 0,
					generatedCount: 0,
					oracleCount: 0,
					validatorUsed: false,
					checkerUsed: false,
				},
			};
		});
		const ids = await Promise.all([projects.create("oi"), projects.create("oi"), projects.create("oi")]);
		const initial = new TaskQueue(projects, new ContestStore(projects));
		queues.push(initial);
		initial.close();
		const queued = await Promise.all(ids.map((project) => initial.submit("generate", project.id)));
		const recovered = new TaskQueue(projects, new ContestStore(projects));
		queues.push(recovered);
		await waitFor(recovered, queued[0].id, "running");
		await waitFor(recovered, queued[1].id, "running");
		expect(recovered.get(queued[2].id).state).toBe("queued");
		resolvers.get(ids[0].id)?.();
		resolvers.get(ids[1].id)?.();
		await waitFor(recovered, queued[2].id, "running");
		resolvers.get(ids[2].id)?.();
		for (const task of queued) await waitFor(recovered, task.id, "succeeded");
		recovered.close();
		projects.database.db.close();
	});
});
