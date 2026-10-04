import type { VerificationRun } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestJson } from "../src/api-client.ts";
import { useAuthoringInsights } from "../src/use-authoring-insights.ts";
import { useVerificationHistory } from "../src/use-verification-history.ts";
import { projectFixture } from "./project-fixture.ts";

const hooks = vi.hoisted(() => ({
	effects: [] as Array<() => (() => void) | undefined>,
	setters: [] as Array<ReturnType<typeof vi.fn>>,
	status: "saved",
	hash: "#workspace?project=project&run=run",
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: (effect: () => (() => void) | undefined) => hooks.effects.push(effect),
	useState: (initial: unknown) => {
		const setter = vi.fn();
		hooks.setters.push(setter);
		return [initial, setter];
	},
	useCallback: (callback: unknown) => callback,
	useSyncExternalStore: () => ({ status: hooks.status }),
}));
vi.mock("../src/api-client.ts", async (original) => ({
	...(await original<typeof import("../src/api-client.ts")>()),
	requestJson: vi.fn(),
}));
vi.mock("../src/workspace-navigation.ts", async (original) => ({
	...(await original<typeof import("../src/workspace-navigation.ts")>()),
	useLocationHash: () => hooks.hash,
}));
let cleanups: Array<(() => void) | undefined> = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(requestJson).mockReset();
	hooks.effects = [];
	hooks.setters = [];
	hooks.status = "saved";
});
afterEach(() => {
	for (const cleanup of cleanups) cleanup?.();
	cleanups = [];
	vi.useRealTimers();
});

it.each([
	{ enabled: false, status: "saved" },
	{ enabled: true, status: "dirty" },
])("does not compute authoring reports for closed or unsaved views: %j", async ({ enabled, status }) => {
	hooks.status = status;
	useAuthoringInsights("", projectFixture(), undefined, enabled);
	cleanups = hooks.effects.map((effect) => effect());
	await vi.advanceTimersByTimeAsync(60000);
	expect(requestJson).not.toHaveBeenCalled();
});

it("aborts the report read on close and ignores a late response", async () => {
	let finish!: (body: unknown) => void;
	vi.mocked(requestJson).mockReturnValue(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	useAuthoringInsights("", projectFixture(), undefined, true);
	cleanups = hooks.effects.map((effect) => effect());
	cleanups[0]?.();
	expect(vi.mocked(requestJson).mock.calls[0][1]?.signal?.aborted).toBe(true);
	finish({ quality: { projectId: "project", revision: 1 } });
	await vi.advanceTimersByTimeAsync(60000);
	expect(hooks.setters[0]).not.toHaveBeenCalled();
	expect(requestJson).toHaveBeenCalledTimes(1);
});

function record(state: VerificationRun["state"]): VerificationRun {
	return {
		id: "run",
		projectId: "project",
		revision: 1,
		fingerprint: "test",
		image: "faux",
		createdAt: "",
		state,
		options: { kind: "matrix" },
		solutions: [],
	};
}
it("refreshes idle run lists infrequently and stops polling completed run details", async () => {
	vi.mocked(requestJson).mockImplementation(async (url) =>
		url.includes("?kind=") ? { runs: [record("complete")] } : record("complete"),
	);
	useVerificationHistory("", "project");
	cleanups = hooks.effects.map((effect) => effect());
	await vi.advanceTimersByTimeAsync(14999);
	expect(requestJson).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(requestJson).toHaveBeenCalledTimes(3);
	expect(vi.mocked(requestJson).mock.calls.filter(([url]) => url === "/api/projects/project/runs/run")).toHaveLength(
		1,
	);
});
it("keeps watching incomplete cleanup even when a run already has a final state", async () => {
	vi.mocked(requestJson).mockImplementation(async (url) => {
		if (url.includes("?kind=")) return { runs: [] };
		if (url === "/api/tasks/task") return { state: "cancelled", cleanupPending: true };
		return { ...record("cancelled"), taskId: "task" };
	});
	useVerificationHistory("", "project");
	cleanups = hooks.effects.map((effect) => effect());
	await vi.advanceTimersByTimeAsync(2000);
	expect(vi.mocked(requestJson).mock.calls.filter(([url]) => url === "/api/projects/project/runs/run")).toHaveLength(
		3,
	);
});
