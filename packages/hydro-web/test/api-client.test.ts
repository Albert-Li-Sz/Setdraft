import { readProjectSnapshot } from "@setdraft/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, RevisionConflict, requestJson, waitForTask } from "../src/api-client.ts";
import { projectFixture } from "./project-fixture.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("shared API client", () => {
	it("validates editable snapshots and only treats a valid snapshot as a revision conflict", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(Response.json(projectFixture()))
			.mockResolvedValueOnce(Response.json({ id: "project", revision: 2 }))
			.mockResolvedValueOnce(Response.json({ message: "conflict", current: projectFixture() }, { status: 409 }))
			.mockResolvedValueOnce(Response.json({ message: "conflict", current: { id: "project" } }, { status: 409 }));
		vi.stubGlobal("fetch", fetcher);
		await expect(requestJson("/api/projects/project", undefined, readProjectSnapshot)).resolves.toEqual(
			projectFixture(),
		);
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
