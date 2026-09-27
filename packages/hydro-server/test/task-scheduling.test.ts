import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskState } from "@setdraft/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { type SandboxPolicy, sandboxPolicy } from "../src/sandbox-policy.ts";
import { TaskQueue } from "../src/tasks.ts";
import { rejectWrites } from "./database-setup.ts";

let root: string;
const queues: TaskQueue[] = [];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-scheduling-"));
});
afterEach(async () => {
	for (const queue of queues) queue.close();
	await Promise.all(queues.splice(0).map((queue) => queue.idle()));
	await rm(root, { recursive: true, force: true });
});
async function fixture(userId: string, scheduler: ExecutionScheduler, policy: SandboxPolicy) {
	const projects = new ManualProjectStore({ root: join(root, userId) });
	const queue = new TaskQueue(projects, new ContestStore(projects), {
		userId,
		scheduler,
		policy,
		enabled: async () => true,
	});
	queues.push(queue);
	await queue.ready;
	return { projects, queue };
}
async function reaches(queue: TaskQueue, id: string, state: TaskState) {
	await vi.waitFor(async () => expect((await queue.get(id)).state).toBe(state), { timeout: 4000, interval: 20 });
}
async function generated(projects: ManualProjectStore, id: string) {
	return {
		project: await projects.get(id),
		report: {
			mode: "generate" as const,
			success: true,
			checks: [],
			caseCount: 0,
			generatedCount: 0,
			oracleCount: 0,
			validatorUsed: false,
			checkerUsed: false,
		},
	};
}

describe("sandbox admission and durable dispatch", () => {
	it("returns a granted slot when cancellation races with the account check", async () => {
		const policy = sandboxPolicy({});
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const projects = new ManualProjectStore({ root });
		let checking = false;
		let finishCheck: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			finishCheck = resolve;
		});
		const queue = new TaskQueue(projects, new ContestStore(projects), {
			userId: "alice",
			scheduler,
			policy,
			enabled: async () => {
				if (scheduler.status("alice").userRunning) {
					checking = true;
					await gate;
				}
				return true;
			},
		});
		queues.push(queue);
		try {
			const task = await queue.submit("generate", (await projects.create("acm")).id);
			unblock();
			await vi.waitFor(() => expect(checking).toBe(true), { timeout: 3000 });
			await queue.cancel(task.id);
			finishCheck();
			await vi.waitFor(() => expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 }));
			expect((await queue.get(task.id)).state).toBe("cancelled");
		} finally {
			finishCheck();
			unblock();
		}
	});
	it("runs two users concurrently while serializing each user's tasks", async () => {
		const policy = sandboxPolicy({});
		const scheduler = new ExecutionScheduler(2, policy);
		const a = await fixture("alice", scheduler, policy);
		const b = await fixture("bob", scheduler, policy);
		const c = await fixture("charlie", scheduler, policy);
		const gates = new Map<string, () => void>();
		for (const { projects } of [a, b, c]) {
			vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id, context) => {
				await new Promise<void>((done) => {
					gates.set(id, done);
					context?.signal.addEventListener("abort", () => done(), { once: true });
				});
				return generated(projects, id);
			});
		}
		const pa = await a.projects.create("acm");
		const pa2 = await a.projects.create("acm");
		const pb = await b.projects.create("acm");
		const pc = await c.projects.create("acm");
		const ta = await a.queue.submit("generate", pa.id);
		const ta2 = await a.queue.submit("generate", pa2.id);
		const tb = await b.queue.submit("generate", pb.id);
		const tc = await c.queue.submit("generate", pc.id);
		await vi.waitFor(() => expect([gates.has(pa.id), gates.has(pb.id)]).toEqual([true, true]), { timeout: 3000 });
		expect(scheduler.status("alice").running).toBe(2);
		expect((await a.queue.get(ta2.id)).state).toBe("queued");
		expect((await c.queue.get(tc.id)).state).toBe("queued");
		gates.get(pa.id)?.();
		await reaches(a.queue, ta.id, "succeeded");
		await vi.waitFor(() => expect(gates.has(pc.id)).toBe(true), { timeout: 3000 });
		expect(gates.has(pa2.id)).toBe(false);
		gates.get(pb.id)?.();
		await reaches(b.queue, tb.id, "succeeded");
		await vi.waitFor(() => expect(gates.has(pa2.id)).toBe(true), { timeout: 3000 });
		gates.get(pc.id)?.();
		gates.get(pa2.id)?.();
		await reaches(c.queue, tc.id, "succeeded");
		await reaches(a.queue, ta2.id, "succeeded");
	});
	it("bounds parallel submissions across workspaces and releases capacity after cancellation", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1, maxOutstanding: 3, maxOutstandingPerUser: 2 };
		const scheduler = new ExecutionScheduler(policy.concurrency, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const a = await fixture("alice", scheduler, policy);
		const b = await fixture("bob", scheduler, policy);
		const projects = await Promise.all(Array.from({ length: 5 }, () => a.projects.create("acm")));
		const result = await Promise.allSettled(projects.map((p) => a.queue.submit("generate", p.id)));
		expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(2);
		for (const item of result) if (item.status === "rejected") expect(item.reason).toMatchObject({ statusCode: 429 });
		await b.queue.submit("generate", (await b.projects.create("acm")).id);
		const extra = await b.projects.create("acm");
		await expect(b.queue.submit("generate", extra.id)).rejects.toMatchObject({ statusCode: 429 });
		const own = await a.queue.list();
		expect(own.map((item) => item.queue?.position).sort()).toEqual([1, 2]);
		expect(own.every((item) => item.queue?.running === 1)).toBe(true);
		await expect(b.queue.get(own[0].id)).rejects.toMatchObject({ statusCode: 404 });
		await a.queue.cancel(own[0].id);
		await b.queue.submit("generate", extra.id);
		expect(scheduler.status("alice").outstanding).toBe(3);
		a.queue.close();
		b.queue.close();
		unblock();
	});
	it("rolls admission back when the task transaction fails", async () => {
		const policy = { ...sandboxPolicy({}), maxOutstanding: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const project = await projects.create("acm");
		const restore = await rejectWrites("task_events", "INSERT", "type", "queued", "queue write failed");
		await expect(queue.submit("generate", project.id)).rejects.toThrow("queue write failed");
		expect(scheduler.status("alice").outstanding).toBe(0);
		expect(await queue.list()).toHaveLength(0);
		await restore();
		await queue.submit("generate", project.id);
		expect(scheduler.status("alice").outstanding).toBe(1);
		queue.close();
		unblock();
	});
	it("holds a timed-out task's slot until abort cleanup finishes", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1, runTimeoutMs: 100 };
		const scheduler = new ExecutionScheduler(1, policy);
		const a = await fixture("alice", scheduler, policy);
		const b = await fixture("bob", scheduler, policy);
		let finishCleanup: () => void = () => {};
		const cleanup = new Promise<void>((resolve) => {
			finishCleanup = resolve;
		});
		let aborted = false;
		vi.spyOn(a.projects.pipeline, "generate").mockImplementation(async (id, context) => {
			await new Promise<void>((resolve) => {
				if (context?.signal.aborted) resolve();
				else context?.signal.addEventListener("abort", () => resolve(), { once: true });
			});
			aborted = true;
			await cleanup;
			context?.signal.throwIfAborted();
			return generated(a.projects, id);
		});
		const nextRun = vi.spyOn(b.projects.pipeline, "generate").mockImplementation((id) => generated(b.projects, id));
		try {
			const first = await a.queue.submit("generate", (await a.projects.create("acm")).id);
			await vi.waitFor(() => expect(aborted).toBe(true), { timeout: 3000 });
			const next = await b.queue.submit("generate", (await b.projects.create("acm")).id);
			expect((await b.queue.get(next.id)).state).toBe("queued");
			expect(nextRun).not.toHaveBeenCalled();
			expect(scheduler.status("alice").running).toBe(1);
			finishCleanup();
			await reaches(a.queue, first.id, "failed");
			expect((await a.queue.get(first.id)).error).toContain("运行超过时间上限");
			await reaches(b.queue, next.id, "succeeded");
			await a.queue.idle();
			await b.queue.idle();
			expect(scheduler.status("alice").outstanding).toBe(0);
		} finally {
			finishCleanup();
		}
	});
	it("expires queued work without executing it and retries at the back", async () => {
		const policy = sandboxPolicy({});
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const run = vi.spyOn(projects.pipeline, "generate").mockImplementation((id) => generated(projects, id));
		const expired = await queue.submit("generate", (await projects.create("acm")).id);
		const pending = await queue.submit("generate", (await projects.create("acm")).id);
		await projects.database.sql.execute("UPDATE tasks SET created_at=$1 WHERE id=$2", [
			new Date(Date.now() - 3_600_000).toISOString(),
			expired.id,
		]);
		await reaches(queue, expired.id, "failed");
		expect((await queue.get(expired.id)).error).toContain("排队超过时间上限");
		expect(run).not.toHaveBeenCalled();
		const retry = await queue.retry(expired.id);
		expect(retry.queue?.position).toBe(2);
		expect((await queue.get(pending.id)).queue?.position).toBe(1);
		queue.close();
		unblock();
	});
	it("restores old work after limits are reduced and refuses new work until capacity is available", async () => {
		const policy = sandboxPolicy({});
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const first = await queue.submit("generate", (await projects.create("acm")).id);
		const second = await queue.submit("generate", (await projects.create("acm")).id);
		queue.close();
		const lower = { ...policy, maxOutstanding: 1, maxOutstandingPerUser: 1 };
		const recoveredScheduler = new ExecutionScheduler(1, lower);
		const unblockRecovered = await recoveredScheduler.acquire("blocker", "test", new AbortController().signal);
		const recovered = await fixture("alice", recoveredScheduler, lower);
		expect(recoveredScheduler.status("alice").outstanding).toBe(2);
		expect((await recovered.queue.get(first.id)).queue?.position).toBe(1);
		const extra = await projects.create("acm");
		await expect(recovered.queue.submit("generate", extra.id)).rejects.toMatchObject({ statusCode: 429 });
		await recovered.queue.cancel(first.id);
		await recovered.queue.cancel(second.id);
		await recovered.queue.submit("generate", extra.id);
		recovered.queue.close();
		unblockRecovered();
		unblock();
	});
	it("releases slots after preparation failures before sandbox execution", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "test", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const project = await projects.create("acm");
		const task = await queue.submit("generate", project.id);
		const failure = vi.spyOn(projects.database, "fileEntries").mockRejectedValue(new Error("staging unavailable"));
		unblock();
		await reaches(queue, task.id, "failed");
		await queue.idle();
		expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		failure.mockRestore();
		vi.spyOn(projects.pipeline, "generate").mockImplementation((id) => generated(projects, id));
		const retried = await queue.retry(task.id);
		await reaches(queue, retried.id, "succeeded");
	});
});
