import { describe, expect, it } from "vitest";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { sandboxPolicy } from "../src/sandbox-policy.ts";

describe("installation execution limits", () => {
	it("allows configured per-user parallelism without exceeding either limit", async () => {
		const policy = { ...sandboxPolicy({}), concurrencyPerUser: 2 };
		const scheduler = new ExecutionScheduler(3, policy);
		const signal = new AbortController().signal;
		const first = await scheduler.acquire("alice", "a1", signal);
		let secondStarted = false;
		const second = scheduler.acquire("alice", "a2", signal).then((release) => {
			secondStarted = true;
			return release;
		});
		await Promise.resolve();
		try {
			expect(secondStarted).toBe(true);
		} finally {
			first();
			(await second)();
		}
	});
	it("rotates users instead of draining the oldest user's backlog", async () => {
		const scheduler = new ExecutionScheduler(1);
		const signal = new AbortController().signal;
		const first = await scheduler.acquire("alice", "first", signal);
		const order: string[] = [];
		const enqueue = (user: string, id: string) =>
			scheduler.acquire(user, id, signal).then((release) => {
				order.push(id);
				release();
			});
		const work = [
			enqueue("alice", "a2"),
			enqueue("alice", "a3"),
			enqueue("alice", "a4"),
			enqueue("bob", "b1"),
			enqueue("charlie", "c1"),
		];
		first();
		await Promise.all(work);
		expect(order).toEqual(["a2", "b1", "c1", "a3", "a4"]);
	});
	it("enforces admission limits atomically, supports rollback, and preserves recovered work", () => {
		const scheduler = new ExecutionScheduler(2, { maxOutstanding: 3, maxOutstandingPerUser: 2 });
		const a = scheduler.reserve("alice", "a1");
		scheduler.reserve("alice", "a2");
		expect(() => scheduler.reserve("alice", "a3")).toThrow("你的未完成任务");
		scheduler.reserve("bob", "b1");
		expect(() => scheduler.reserve("charlie", "c1")).toThrow("全站任务队列");
		a();
		a();
		expect(scheduler.status("alice").outstanding).toBe(2);
		scheduler.reserve("charlie", "c1");
		scheduler.reserve("charlie", "recovered", false, true);
		expect(scheduler.status("alice").outstanding).toBe(4);
		expect(() => scheduler.reserve("d", "new")).toThrow("全站任务队列");
	});
	it("rejects duplicate image builds across users and duplicate execution keys", async () => {
		const scheduler = new ExecutionScheduler(2);
		const unreserve = scheduler.reserve("admin-a", "image1", true);
		expect(() => scheduler.reserve("admin-b", "image2", true)).toThrow("已有沙箱镜像构建任务");
		unreserve();
		scheduler.reserve("admin-b", "image2", true)();
		const signal = new AbortController().signal;
		const release = await scheduler.acquire("a", "same", signal);
		await expect(scheduler.acquire("a", "same", signal)).rejects.toThrow("already scheduled");
		release();
		release();
		expect(scheduler.status("a").running).toBe(0);
	});
	it("cancelling a queued maintenance barrier lets other users use free slots", async () => {
		const scheduler = new ExecutionScheduler(2);
		const signal = new AbortController().signal;
		const release = await scheduler.acquire("a", "a", signal);
		const controller = new AbortController();
		const build = scheduler.acquire("admin", "build", controller.signal, true);
		const rejected = expect(build).rejects.toMatchObject({ name: "AbortError" });
		let started = false;
		const other = scheduler.acquire("b", "b", signal).then((done) => {
			started = true;
			return done;
		});
		await Promise.resolve();
		expect(started).toBe(false);
		controller.abort();
		await rejected;
		(await other)();
		release();
	});
	it("validates bounded deployment settings", () => {
		expect(sandboxPolicy({})).toMatchObject({ concurrency: 2, maxOutstanding: 64, maxOutstandingPerUser: 8 });
		expect(sandboxPolicy({ SETDRAFT_SANDBOX_CONCURRENCY: "1" }).concurrency).toBe(1);
		for (const value of ["0", "-1", "2.5", "abc", "65"])
			expect(() => sandboxPolicy({ SETDRAFT_SANDBOX_CONCURRENCY: value })).toThrow("SETDRAFT_SANDBOX_CONCURRENCY");
		expect(() => sandboxPolicy({ SETDRAFT_SANDBOX_RUN_TIMEOUT_MS: "86400001" })).toThrow(
			"SETDRAFT_SANDBOX_RUN_TIMEOUT_MS",
		);
	});
	it("limits total work, serializes one user's work, and reserves image builds exclusively", async () => {
		const scheduler = new ExecutionScheduler(2);
		const signal = new AbortController().signal;
		const first = await scheduler.acquire("alice", "a1", signal);
		let secondUserJob = false;
		const second = scheduler.acquire("alice", "a2", signal).then((release) => {
			secondUserJob = true;
			return release;
		});
		const other = await scheduler.acquire("bob", "b1", signal);
		expect(secondUserJob).toBe(false);
		let exclusive = false;
		const build = scheduler.acquire("admin", "build", signal, true).then((release) => {
			exclusive = true;
			return release;
		});
		first();
		const releaseSecond = await second;
		other();
		await Promise.resolve();
		expect(exclusive).toBe(false);
		releaseSecond();
		const releaseBuild = await build;
		let nextStarted = false;
		const next = scheduler.acquire("bob", "b2", signal).then((release) => {
			nextStarted = true;
			return release;
		});
		await Promise.resolve();
		expect(nextStarted).toBe(false);
		releaseBuild();
		(await next)();
	});
	it("removes cancelled queued work without consuming a slot", async () => {
		const scheduler = new ExecutionScheduler(1);
		const release = await scheduler.acquire("a", "a1", new AbortController().signal);
		const controller = new AbortController();
		const cancelled = scheduler.acquire("b", "b1", controller.signal);
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		release();
		(await scheduler.acquire("c", "c1", new AbortController().signal))();
	});
	it("keeps slots distinct when different workspaces submit the same request ID", async () => {
		const scheduler = new ExecutionScheduler(2);
		const signal = new AbortController().signal;
		const first = await scheduler.acquire("alice", "same-id", signal);
		const second = await scheduler.acquire("bob", "same-id", signal);
		let started = false;
		const waiting = scheduler.acquire("charlie", "same-id", signal).then((release) => {
			started = true;
			return release;
		});
		await Promise.resolve();
		expect(started).toBe(false);
		first();
		(await waiting)();
		second();
	});
});
