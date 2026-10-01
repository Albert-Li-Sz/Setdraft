import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { sandboxPolicy } from "../src/sandbox-policy.ts";
import { TaskQueue } from "../src/tasks.ts";
import { rejectWrites } from "./database-setup.ts";

let root: string;
const queues: TaskQueue[] = [];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-tasks-"));
});

afterEach(async () => {
	for (const queue of queues.splice(0)) {
		queue.close();
		await queue.idle();
	}
	await rm(root, { recursive: true, force: true });
});

async function waitFor(queue: TaskQueue, id: string, state: "running" | "queued" | "succeeded"): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await queue.get(id)).state === state) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Task did not reach ${state}.`);
}

describe("persistent task queue", () => {
	it("retains a completed result and admission until terminal storage recovers without rerunning", async () => {
		const projects = new ManualProjectStore({ root });
		const scheduler = new ExecutionScheduler(1, sandboxPolicy({}));
		const queue = new TaskQueue(projects, new ContestStore(projects), {
			scheduler,
			userId: "alice",
			enabled: async () => true,
		});
		queues.push(queue);
		await queue.ready;
		const project = await projects.create("acm");
		const run = vi.spyOn(projects.pipeline, "generate").mockResolvedValue({
			project,
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
		});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const recover = await rejectWrites("task_events", "INSERT", "type", "succeeded", "terminal unavailable");
		const task = await queue.submit("generate", project.id);
		await vi.waitFor(() =>
			expect(warning).toHaveBeenCalledWith("Completed execution retained until terminal storage recovers."),
		);
		expect(await queue.get(task.id)).toMatchObject({ state: "running" });
		expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 1 });
		await recover();
		await vi.waitFor(async () => expect((await queue.get(task.id)).state).toBe("succeeded"));
		expect(run).toHaveBeenCalledTimes(1);
		expect((await queue.events(task.id)).filter((event) => event.type === "succeeded")).toHaveLength(1);
		expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		warning.mockRestore();
	});
	it("persists release names across restarts and retries", async () => {
		const projects = new ManualProjectStore({ root });
		const project = await projects.create("acm");
		const initial = new TaskQueue(projects, new ContestStore(projects));
		await initial.ready;
		queues.push(initial);
		initial.close();
		const submitted = await initial.submit("finalize", project.id, undefined, "初版");
		expect((await initial.get(submitted.id)).releaseName).toBe("初版");
		expect((await initial.get(submitted.id)).resourceTitle).toBe(project.title);
		await initial.cancel(submitted.id);
		const next = new TaskQueue(projects, new ContestStore(projects));
		await next.ready;
		queues.push(next);
		next.close();
		const retried = await next.retry(submitted.id);
		expect((await next.get(retried.id)).releaseName).toBe("初版");
		projects.database.sql.close();
	});
	it("recovers a container's stale PID and keeps every task run in its problem group", async () => {
		const projects = new ManualProjectStore({ root });
		const project = await projects.create("acm");
		const now = new Date().toISOString();
		const insert = (...values: unknown[]) =>
			projects.database.sql.execute(
				"INSERT INTO tasks(id,kind,resource,state,fingerprint,created_at,updated_at,owner_pid) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
				values,
			);
		for (let index = 0; index < 101; index++)
			await insert(randomUUID(), "finalize", `project:${project.id}`, "succeeded", "hash", now, now, null);
		const runningId = randomUUID();
		await insert(runningId, "generate", `project:${project.id}`, "running", "hash", now, now, process.pid);
		vi.stubEnv("SETDRAFT_CONTAINER_LOCKED", "1");
		try {
			const queue = new TaskQueue(projects, new ContestStore(projects));
			await queue.ready;
			queues.push(queue);
			queue.close();
			expect((await queue.get(runningId)).state).toBe("interrupted");
			expect(await queue.list()).toHaveLength(102);
			expect((await queue.list()).every((task) => task.resourceTitle === project.title)).toBe(true);
		} finally {
			vi.unstubAllEnvs();
			projects.database.sql.close();
		}
	});
	it("rolls back a terminal state if its event cannot be persisted", async () => {
		const projects = new ManualProjectStore({ root });
		const queue = new TaskQueue(projects, new ContestStore(projects));
		await queue.ready;
		queues.push(queue);
		queue.close();
		const project = await projects.create("oi");
		const task = await queue.submit("generate", project.id);
		const removeFailure = await rejectWrites("task_events", "INSERT", "type", "cancelled", "event storage failed");
		await expect(queue.cancel(task.id)).rejects.toThrow("event storage failed");
		expect((await queue.get(task.id)).state).toBe("queued");
		expect((await queue.events(task.id)).map((event) => event.type)).toEqual(["queued"]);
		await removeFailure();
		await queue.cancel(task.id);
		expect((await queue.get(task.id)).state).toBe("cancelled");
		expect((await queue.events(task.id)).at(-1)?.type).toBe("cancelled");
		projects.database.sql.close();
	});

	it("limits global concurrency to two and rejects another task for the same project", async () => {
		const projects = new ManualProjectStore({ root });
		const resolvers = new Map<string, () => void>();
		vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id, context) => {
			await new Promise<void>((resolveWork) => {
				resolvers.set(id, resolveWork);
				context?.signal.addEventListener("abort", () => resolveWork(), { once: true });
			});
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
		await queue.ready;
		queues.push(queue);
		const ids = await Promise.all([projects.create("oi"), projects.create("oi"), projects.create("oi")]);
		const first = await queue.submit("generate", ids[0].id);
		const second = await queue.submit("generate", ids[1].id);
		const third = await queue.submit("generate", ids[2].id);
		await waitFor(queue, first.id, "running");
		await waitFor(queue, second.id, "running");
		expect((await queue.get(third.id)).state).toBe("queued");
		const competing = queue;
		await expect(competing.submit("finalize", ids[0].id)).rejects.toThrow("已有排队或运行中的任务");
		await vi.waitFor(() => expect(resolvers.has(ids[0].id)).toBe(true));
		resolvers.get(ids[0].id)?.();
		await waitFor(queue, first.id, "succeeded");
		await waitFor(queue, third.id, "running");
		await vi.waitFor(() => expect(resolvers.has(ids[1].id)).toBe(true));
		resolvers.get(ids[1].id)?.();
		await vi.waitFor(() => expect(resolvers.has(ids[2].id)).toBe(true));
		resolvers.get(ids[2].id)?.();
		await waitFor(queue, second.id, "succeeded");
		await waitFor(queue, third.id, "succeeded");
		expect((await queue.events(first.id)).map((event) => event.type)).toEqual(["queued", "running", "succeeded"]);
		competing.close();
		queue.close();
		projects.database.sql.close();
	});

	it("marks orphaned running work interrupted and keeps it retryable", async () => {
		const projects = new ManualProjectStore({ root });
		const id = randomUUID();
		const now = new Date().toISOString();
		await projects.database.sql.execute(
			"INSERT INTO tasks (id,kind,resource,state,fingerprint,created_at,updated_at,owner_pid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
			[id, "generate", `project:${randomUUID()}`, "running", "old-hash", now, now, 999999],
		);
		const queue = new TaskQueue(projects, new ContestStore(projects));
		await queue.ready;
		queues.push(queue);
		expect((await queue.get(id)).state).toBe("interrupted");
		expect((await queue.events(id)).at(-1)).toMatchObject({ type: "interrupted" });
		queue.close();
		projects.database.sql.close();
	});

	it("resumes queued tasks in durable order when submission timestamps tie", async () => {
		const projects = new ManualProjectStore({ root });
		const resolvers = new Map<string, () => void>();
		vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id, context) => {
			await new Promise<void>((resolveWork) => {
				resolvers.set(id, resolveWork);
				context?.signal.addEventListener("abort", () => resolveWork(), { once: true });
			});
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
		await initial.ready;
		queues.push(initial);
		initial.close();
		const queued = await Promise.all(ids.map(async (project) => await initial.submit("generate", project.id)));
		for (const task of queued)
			await projects.database.sql.execute("UPDATE tasks SET created_at=$1 WHERE id=$2", [
				queued[0].createdAt,
				task.id,
			]);
		queued.sort((left, right) => left.id.localeCompare(right.id));
		const recovered = new TaskQueue(projects, new ContestStore(projects));
		await recovered.ready;
		queues.push(recovered);
		await waitFor(recovered, queued[0].id, "running");
		await waitFor(recovered, queued[1].id, "running");
		expect((await recovered.get(queued[2].id)).state).toBe("queued");
		await vi.waitFor(() => expect(resolvers.has(queued[0].resource.split(":")[1])).toBe(true));
		resolvers.get(queued[0].resource.split(":")[1])?.();
		await vi.waitFor(() => expect(resolvers.has(queued[1].resource.split(":")[1])).toBe(true));
		resolvers.get(queued[1].resource.split(":")[1])?.();
		await waitFor(recovered, queued[2].id, "running");
		await vi.waitFor(() => expect(resolvers.has(queued[2].resource.split(":")[1])).toBe(true));
		resolvers.get(queued[2].resource.split(":")[1])?.();
		for (const task of queued) await waitFor(recovered, task.id, "succeeded");
		recovered.close();
		projects.database.sql.close();
	});
});
