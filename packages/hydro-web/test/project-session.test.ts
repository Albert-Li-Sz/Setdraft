import type { ProjectSnapshot } from "@setdraft/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RevisionConflict } from "../src/api-client.ts";
import { ProjectSession } from "../src/project-session.ts";
import { projectFixture } from "./project-fixture.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("project editing session", () => {
	it("resaves a patch after a newer GET overtakes its older PUT acknowledgement", async () => {
		const first = deferred<ProjectSnapshot>();
		const save = vi.fn(async (project: ProjectSnapshot) => ({ ...project, revision: project.revision + 1 }));
		save.mockImplementationOnce(() => first.promise);
		const session = new ProjectSession(save);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "local patch" }));
		const flight = session.flush();
		await Promise.resolve();
		session.accept(projectFixture({ revision: 3, title: "server", orphanOutputs: ["2.out"] }));
		first.resolve(projectFixture({ revision: 2, title: "local patch" }));
		await flight;
		expect(save).toHaveBeenCalledTimes(2);
		expect(save.mock.calls[1][0]).toMatchObject({ revision: 3, title: "local patch", orphanOutputs: ["2.out"] });
		expect(session.getSnapshot()).toMatchObject({ status: "saved", project: { revision: 4, title: "local patch" } });
		session.dispose();
	});
	it("preserves newly assigned server cases while saving a concurrent program edit", async () => {
		const save = vi.fn(async (project: ProjectSnapshot) => ({ ...project, revision: project.revision + 1 }));
		const session = new ProjectSession(save);
		session.open(projectFixture({ caseSubtasks: { "manual:1": 1 } }));
		session.edit((project) => ({ ...project, reference: { ...project.reference, code: "new program" } }));
		session.accept(projectFixture({ revision: 2, caseSubtasks: { "manual:1": 1, "manual:2": 2 } }));
		await session.flush();
		expect(save.mock.calls[0][0].caseSubtasks).toEqual({ "manual:1": 1, "manual:2": 2 });
		expect(save.mock.calls[0][0].reference.code).toBe("new program");
		session.dispose();
	});

	it("rebases dictionary edits by key and keeps server changes to untouched program fields", () => {
		const session = new ProjectSession(async (project) => project);
		session.open(projectFixture({ caseSubtasks: { "manual:1": 1, "manual:3": 1 } }));
		session.edit((project) => ({
			...project,
			caseSubtasks: { "manual:1": 2 },
			reference: { ...project.reference, code: "local" },
		}));
		session.accept(
			projectFixture({
				revision: 2,
				caseSubtasks: { "manual:1": 1, "manual:2": 2, "manual:3": 1 },
				reference: { language: "python3", code: "remote" },
			}),
		);
		expect(session.getSnapshot().project?.caseSubtasks).toEqual({ "manual:1": 2, "manual:2": 2 });
		expect(session.getSnapshot().project?.reference).toEqual({ language: "python3", code: "local" });
		session.dispose();
	});
	it("serializes edits made during a save using the returned revision", async () => {
		const first = deferred<ProjectSnapshot>();
		const save = vi.fn(async (project: ProjectSnapshot) => ({ ...project, revision: project.revision + 1 }));
		save.mockImplementationOnce(() => first.promise);
		const session = new ProjectSession(save);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "first edit" }));
		const flight = session.flush();
		await Promise.resolve();
		session.edit((project) => ({ ...project, title: "second edit", oracle: undefined }));
		expect(session.flush()).toBe(flight);
		first.resolve(projectFixture({ title: "first edit", revision: 2 }));
		await flight;
		expect(save).toHaveBeenCalledTimes(2);
		expect(save.mock.calls[1][0]).toMatchObject({ title: "second edit", revision: 2 });
		expect(session.getSnapshot()).toMatchObject({ status: "saved", project: { title: "second edit", revision: 3 } });
		expect(session.getSnapshot().project?.oracle).toBeUndefined();
		session.dispose();
	});

	it("aborts the old scope and ignores its reply even when reopening the same project", async () => {
		const old = deferred<ProjectSnapshot>();
		const session = new ProjectSession(() => old.promise);
		session.open(projectFixture());
		const signal = session.signal;
		session.edit((project) => ({ ...project, title: "unsaved" }));
		const flight = session.flush();
		await Promise.resolve();
		session.open(projectFixture({ title: "reopened", revision: 8 }));
		expect(signal.aborted).toBe(true);
		old.resolve(projectFixture({ title: "old reply", revision: 2 }));
		await flight;
		expect(session.getSnapshot()).toMatchObject({ status: "saved", project: { title: "reopened", revision: 8 } });
		session.dispose();
	});

	it("preserves local edits and blocks further saves after a conflict until explicitly reloaded", async () => {
		vi.useFakeTimers();
		const current = projectFixture({ revision: 4, title: "other window" });
		const save = vi.fn(async () => {
			throw new RevisionConflict({ message: "conflict" }, current);
		});
		const session = new ProjectSession(save);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "local" }));
		await expect(session.flush()).rejects.toBeInstanceOf(RevisionConflict);
		session.dismissConflict();
		session.edit((project) => ({ ...project, title: "still local" }));
		await vi.advanceTimersByTimeAsync(2000);
		await expect(session.flush()).rejects.toThrow("题目版本已变化");
		expect(save).toHaveBeenCalledTimes(1);
		expect(session.getSnapshot()).toMatchObject({
			status: "conflict",
			project: { title: "still local", revision: 1 },
		});
		session.open(current);
		expect(session.getSnapshot()).toMatchObject({ status: "saved", project: current });
		session.dispose();
	});

	it("debounces autosave and cancels pending work on disposal", async () => {
		vi.useFakeTimers();
		const save = vi.fn(async (project: ProjectSnapshot) => ({ ...project, revision: project.revision + 1 }));
		const session = new ProjectSession(save);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "one" }));
		await vi.advanceTimersByTimeAsync(500);
		session.edit((project) => ({ ...project, title: "two" }));
		await vi.advanceTimersByTimeAsync(500);
		expect(save).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(150);
		expect(save).toHaveBeenCalledTimes(1);
		session.edit((project) => ({ ...project, title: "three" }));
		session.dispose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(save).toHaveBeenCalledTimes(1);
	});

	it("keeps local fields while adopting file metadata and ignores a foreign project's response", () => {
		const session = new ProjectSession(async (project) => project);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "local" }));
		session.accept(projectFixture({ revision: 2, orphanOutputs: ["1.out"] }));
		session.accept(projectFixture({ id: "different", revision: 3 }));
		expect(session.getSnapshot()).toMatchObject({
			status: "dirty",
			project: { id: "project", title: "local", revision: 2, orphanOutputs: ["1.out"] },
		});
		session.dispose();
	});

	it("rejects a malformed revision without losing the pending edit", async () => {
		const session = new ProjectSession(async (project) => project);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "local" }));
		await expect(session.flush()).rejects.toThrow("题目版本无效");
		expect(session.getSnapshot()).toMatchObject({ status: "error", project: { title: "local", revision: 1 } });
		session.dispose();
	});
	it("pauses autosave without discarding edits and resumes the same draft after authentication", async () => {
		vi.useFakeTimers();
		const save = vi.fn(async (project: ProjectSnapshot) => ({ ...project, revision: project.revision + 1 }));
		const session = new ProjectSession(save);
		session.open(projectFixture());
		session.edit((project) => ({ ...project, title: "private unsaved draft" }));
		const signal = session.signal;
		session.pause();
		expect(signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(3000);
		expect(save).not.toHaveBeenCalled();
		await expect(session.flush()).rejects.toMatchObject({ name: "AbortError" });
		expect(session.getSnapshot().project?.title).toBe("private unsaved draft");
		session.resume();
		await session.flush();
		expect(save).toHaveBeenCalledTimes(1);
		expect(session.getSnapshot()).toMatchObject({
			status: "saved",
			project: { title: "private unsaved draft", revision: 2 },
		});
		session.dispose();
	});
});
