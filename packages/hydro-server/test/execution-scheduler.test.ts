import { describe, expect, it } from "vitest";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";

describe("installation execution limits", () => {
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
