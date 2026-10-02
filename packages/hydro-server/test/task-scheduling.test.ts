import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManualRelease, type TaskRecord, type TaskState, verificationContractVersion } from "@setdraft/contracts";
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
	it.each(["cancel", "timeout"] as const)("releases a granted queued slot after %s telemetry fails", async (kind) => {
		const policy = { ...sandboxPolicy({}), concurrency: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const internals = queue as unknown as {
			executeObserved(task: TaskRecord, controller: AbortController): Promise<void>;
			recordQueueEnd(id: string, result: "cancelled" | "timeout"): Promise<void>;
			pump(): Promise<void>;
		};
		let entered = false;
		const entry = vi.spyOn(internals, "executeObserved").mockImplementation(async (_task, controller) => {
			entered = true;
			await new Promise<void>((resolve) =>
				controller.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		});
		const record = internals.recordQueueEnd.bind(queue);
		const telemetry = vi.spyOn(internals, "recordQueueEnd").mockImplementationOnce(async (id, result) => {
			if (kind === "cancel") await expect(queue.cancel(id)).rejects.toMatchObject({ statusCode: 409 });
			const metadata = vi
				.spyOn(projects.database, "get")
				.mockRejectedValueOnce(new Error("telemetry metadata unavailable"));
			try {
				await record(id, result);
			} finally {
				metadata.mockRestore();
			}
		});
		try {
			const task = await queue.submit("generate", (await projects.create("acm")).id);
			await vi.waitFor(() => expect(entered).toBe(true));
			expect(scheduler.status("alice")).toMatchObject({ running: 1, outstanding: 1 });
			if (kind === "cancel") await expect(queue.cancel(task.id)).resolves.toMatchObject({ state: "cancelled" });
			else {
				await projects.database.sql.execute("UPDATE tasks SET created_at=$1 WHERE id=$2", [
					new Date(0).toISOString(),
					task.id,
				]);
				await expect(internals.pump()).resolves.toBeUndefined();
			}
			await queue.idle();
			expect((await queue.get(task.id)).state).toBe(kind === "cancel" ? "cancelled" : "failed");
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		} finally {
			queue.close();
			await queue.idle();
			entry.mockRestore();
			telemetry.mockRestore();
		}
	});
	it.each(["cancel", "timeout"] as const)(
		"retains a queued owner if the %s terminal transaction rolls back",
		async (kind) => {
			const policy = { ...sandboxPolicy({}), concurrency: 1 };
			const scheduler = new ExecutionScheduler(1, policy);
			const { projects, queue } = await fixture("alice", scheduler, policy);
			const internals = queue as unknown as {
				executeObserved(task: TaskRecord, controller: AbortController): Promise<void>;
				pump(): Promise<void>;
			};
			let signal: AbortSignal | undefined;
			vi.spyOn(internals, "executeObserved").mockImplementation(async (_task, controller) => {
				signal = controller.signal;
				await new Promise<void>((resolve) =>
					controller.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
			});
			const task = await queue.submit("generate", (await projects.create("acm")).id);
			await vi.waitFor(() => expect(signal).toBeDefined());
			const restore = await rejectWrites(
				"task_events",
				"INSERT",
				"type",
				kind === "cancel" ? "cancelled" : "failed",
				"terminal unavailable",
			);
			try {
				if (kind === "cancel") await expect(queue.cancel(task.id)).rejects.toThrow("terminal unavailable");
				else {
					await projects.database.sql.execute("UPDATE tasks SET created_at=$1 WHERE id=$2", [
						new Date(0).toISOString(),
						task.id,
					]);
					await expect(internals.pump()).rejects.toThrow("terminal unavailable");
				}
				expect((await queue.get(task.id)).state).toBe("queued");
				expect(signal?.aborted).toBe(false);
				expect(scheduler.status("alice")).toMatchObject({ running: 1, outstanding: 1 });
			} finally {
				await restore();
			}
			if (kind === "cancel") await queue.cancel(task.id);
			else await internals.pump();
			await queue.idle();
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		},
	);
	it("owns an entry failure until terminal storage recovers without redispatching or blocking later work", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "entry", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const first = await queue.submit("generate", (await projects.create("acm")).id);
		const execution = queue as unknown as { execute(task: TaskRecord, controller: AbortController): Promise<void> };
		const execute = execution.execute.bind(queue);
		vi.spyOn(execution, "execute").mockImplementationOnce(async (task, controller) => {
			const metadata = vi.spyOn(projects.database, "get").mockRejectedValueOnce(new Error("entry unavailable"));
			try {
				await execute(task, controller);
			} finally {
				metadata.mockRestore();
			}
		});
		const run = vi.spyOn(projects.pipeline, "generate").mockImplementation((id) => generated(projects, id));
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const restore = await rejectWrites("task_events", "INSERT", "type", "failed", "terminal unavailable");
		try {
			unblock();
			await vi.waitFor(() =>
				expect(warning).toHaveBeenCalledWith("Completed execution retained until terminal storage recovers."),
			);
			expect((await queue.get(first.id)).state).toBe("queued");
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 1 });
			const nextProject = await projects.create("acm");
			const next = await queue.submit("generate", nextProject.id);
			await reaches(queue, next.id, "succeeded");
			expect(run).toHaveBeenCalledTimes(1);
			expect(run.mock.calls[0][0]).toBe(nextProject.id);
		} finally {
			await restore();
			warning.mockRestore();
			unblock();
		}
		await reaches(queue, first.id, "failed");
		await queue.idle();
		expect(run).toHaveBeenCalledTimes(1);
		expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
	});
	it("settles an entry metadata failure and lets the next task run with telemetry disabled", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("blocker", "entry", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const task = await queue.submit("generate", (await projects.create("acm")).id);
		const execution = queue as unknown as { execute(task: TaskRecord, controller: AbortController): Promise<void> };
		const execute = execution.execute.bind(queue);
		const failure = vi.spyOn(execution, "execute").mockImplementation(async (record, controller) => {
			const metadata = vi
				.spyOn(projects.database, "get")
				.mockRejectedValueOnce(new Error("entry metadata unavailable"));
			try {
				await execute(record, controller);
			} finally {
				metadata.mockRestore();
			}
		});
		const run = vi.spyOn(projects.pipeline, "generate").mockImplementation((id) => generated(projects, id));
		try {
			unblock();
			await reaches(queue, task.id, "failed");
			await queue.idle();
			expect((await queue.get(task.id)).error).toContain("entry metadata unavailable");
			expect(run).not.toHaveBeenCalled();
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
			failure.mockRestore();
			const next = await queue.submit("generate", (await projects.create("acm")).id);
			await reaches(queue, next.id, "succeeded");
			await queue.idle();
			expect(run).toHaveBeenCalledTimes(1);
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		} finally {
			failure.mockRestore();
			unblock();
		}
	});
	it("rolls back a failed running event and settles it without executing business work", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const restore = await rejectWrites("task_events", "INSERT", "type", "running", "running event unavailable");
		const run = vi.spyOn(projects.pipeline, "generate").mockImplementation((id) => generated(projects, id));
		try {
			const task = await queue.submit("generate", (await projects.create("acm")).id);
			await reaches(queue, task.id, "failed");
			await queue.idle();
			expect(run).not.toHaveBeenCalled();
			expect((await queue.events(task.id)).map((event) => event.type)).toEqual(["queued", "failed"]);
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		} finally {
			await restore();
		}
	});
	it("deduplicates release exports at admission and cancels them through the shared scheduler", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 1, maxOutstanding: 1, maxOutstandingPerUser: 1 };
		const scheduler = new ExecutionScheduler(1, policy);
		const blocker = await scheduler.acquire("other", "blocker", new AbortController().signal);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const project = await projects.create("acm");
		const id = randomUUID();
		const release: ManualRelease = {
			id,
			name: "v1",
			projectId: project.id,
			revision: 1,
			scoringMode: "acm",
			checkerMode: "text",
			projectHash: "test",
			title: "Test",
			slug: "test",
			createdAt: new Date().toISOString(),
			report: {
				verificationContractVersion,
				mode: "finalize",
				success: true,
				checks: [{ stage: "reference", passed: true, message: "ok" }],
				caseCount: 1,
				generatedCount: 0,
				oracleCount: 0,
				checkerUsed: true,
				validatorUsed: false,
				issues: [],
				projectHash: "test",
				revision: 1,
				verifiedAt: new Date().toISOString(),
			},
		};
		await projects.database.put("release", id, release);
		let aborted = false;
		const run = vi.spyOn(projects.releases, "exportDomjudge").mockImplementation(async (_id, context) => {
			if (!context) throw new Error("Execution context required");
			await new Promise<void>((resolve) =>
				context.signal.addEventListener(
					"abort",
					() => {
						aborted = true;
						resolve();
					},
					{ once: true },
				),
			);
			context.signal.throwIfAborted();
			return { path: "unused", size: 0, name: "test.domjudge.zip" };
		});
		try {
			const jobs = await Promise.all(
				Array.from({ length: 8 }, () => queue.submit("release-export", id, "domjudge")),
			);
			expect(new Set(jobs.map((task) => task.id)).size).toBe(1);
			expect(scheduler.status("alice")).toMatchObject({ running: 1, outstanding: 1 });
			expect(run).not.toHaveBeenCalled();
			await expect(projects.releases.deleteRelease(id)).rejects.toMatchObject({ statusCode: 409 });
			blocker();
			await reaches(queue, jobs[0].id, "running");
			await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
			await queue.cancelAll();
			await reaches(queue, jobs[0].id, "cancelled");
			await queue.idle();
			expect(aborted).toBe(true);
			expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0 });
		} finally {
			blocker();
		}
	});
	it("dispatches multiple projects for one user when configured", async () => {
		const policy = { ...sandboxPolicy({}), concurrency: 3, concurrencyPerUser: 2 };
		const scheduler = new ExecutionScheduler(3, policy);
		const { projects, queue } = await fixture("alice", scheduler, policy);
		const gates: Array<() => void> = [];
		vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id, context) => {
			await new Promise<void>((done) => {
				gates.push(done);
				context?.signal.addEventListener("abort", () => done(), { once: true });
			});
			return generated(projects, id);
		});
		const ids = [];
		for (let i = 0; i < 3; i++) ids.push((await queue.submit("generate", (await projects.create("acm")).id)).id);
		try {
			await vi.waitFor(() => expect(gates).toHaveLength(2), { timeout: 3000 });
			expect(scheduler.status("alice").running).toBe(2);
			expect((await queue.get(ids[2])).state).toBe("queued");
			gates[0]();
			await vi.waitFor(() => expect(gates).toHaveLength(3), { timeout: 3000 });
		} finally {
			queue.close();
			for (const done of gates) done();
		}
	});
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
