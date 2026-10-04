import { readProjectSnapshot } from "@setdraft/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, RevisionConflict, requestJson, waitForTask } from "../src/api-client.ts";
import { projectFixture } from "./project-fixture.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("shared API client", () => {
	it("reports non-JSON outages with a readable error and preserves the HTTP status", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response("<html>Gateway unavailable</html>", { status: 503 }))
				.mockResolvedValueOnce(new Response("broken", { status: 200 })),
		);
		await expect(requestJson("/api/projects")).rejects.toMatchObject({
			status: 503,
			message: "服务暂时不可用，请稍后重试。",
		});
		await expect(requestJson("/api/projects")).rejects.toThrow("服务响应格式错误，请刷新后重试。");
	});

	it("bounds stalled reads while preserving caller cancellation", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
					}),
			),
		);
		const stalled = requestJson("/api/projects");
		const timeout = expect(stalled).rejects.toThrow("请求超时，请检查连接后重试。");
		await vi.advanceTimersByTimeAsync(30000);
		await timeout;
		const controller = new AbortController();
		const cancelled = expect(requestJson("/api/projects", { signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		controller.abort();
		await cancelled;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps long mutations alive and clears the read deadline after a healthy response", async () => {
		vi.useFakeTimers();
		let finish!: (response: Response) => void;
		const fetcher = vi.fn(
			(_url: string, _init?: RequestInit) =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetcher);
		const writing = requestJson("/api/projects/1/finalize", { method: "POST" });
		await vi.advanceTimersByTimeAsync(35000);
		expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
		finish(Response.json({ task: "queued" }));
		await expect(writing).resolves.toEqual({ task: "queued" });
		fetcher.mockResolvedValueOnce(Response.json({ projects: [] }));
		await expect(requestJson("/api/projects")).resolves.toEqual({ projects: [] });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts successful empty HEAD and 204 responses", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 200 }))
				.mockResolvedValueOnce(new Response(null, { status: 204 })),
		);
		await expect(requestJson("/api/projects", { method: "HEAD" })).resolves.toBeUndefined();
		await expect(requestJson("/api/projects", { method: "DELETE" })).resolves.toBeUndefined();
	});

	it("validates editable snapshots and only treats a valid snapshot as a revision conflict", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(projectFixture()))
			.mockResolvedValueOnce(Response.json({ id: "project", revision: 2 }))
			.mockResolvedValueOnce(Response.json({ message: "conflict", current: projectFixture() }, { status: 409 }))
			.mockResolvedValueOnce(Response.json({ message: "conflict", current: { id: "project" } }, { status: 409 }));
		vi.stubGlobal("fetch", fetcher);
		await expect(requestJson("/api/projects/project", undefined, readProjectSnapshot)).resolves.toMatchObject({
			...projectFixture(),
			problemType: "standard",
			judgingMode: "default",
			checkerMode: "text",
			interactionInputMode: "provided",
			communication: { judgeSource: "", judgeStandard: "cpp17", secondRound: "interactive" },
		});
		await expect(requestJson("/api/projects/project", undefined, readProjectSnapshot)).rejects.toThrow(
			"题目格式无效",
		);
		await expect(requestJson("/api/projects/project")).rejects.toBeInstanceOf(RevisionConflict);
		const rejected = requestJson("/api/projects/project");
		await expect(rejected).rejects.toBeInstanceOf(ApiError);
		await expect(rejected).rejects.not.toBeInstanceOf(RevisionConflict);
	});

	it("cancels task polling promptly when the editing session is replaced", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn().mockResolvedValue(Response.json({ id: "task", state: "running" }));
		vi.stubGlobal("fetch", fetcher);
		const controller = new AbortController();
		const waiting = waitForTask("", "task", undefined, controller.signal);
		const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await rejected;
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
