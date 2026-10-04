import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestJson } from "../src/api-client.ts";
import type { BackgroundTask } from "../src/platform.ts";
import { TasksPage } from "../src/TasksPage.tsx";

const hooks = vi.hoisted(() => ({
	effects: [] as Array<() => (() => void) | undefined>,
	setters: [] as Array<ReturnType<typeof vi.fn>>,
	initial: [] as unknown[],
	index: 0,
	refs: [] as Array<{ current: unknown }>,
	refIndex: 0,
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: (effect: () => (() => void) | undefined) => hooks.effects.push(effect),
	useRef: (initial: unknown) => {
		const index = hooks.refIndex++;
		hooks.refs[index] ??= { current: initial };
		return hooks.refs[index];
	},
	useState: (initial: unknown) => {
		const index = hooks.index++;
		hooks.setters[index] ??= vi.fn();
		return [hooks.initial[index] ?? initial, hooks.setters[index]];
	},
}));
vi.mock("../src/api-client.ts", async (original) => ({
	...(await original<typeof import("../src/api-client.ts")>()),
	requestJson: vi.fn(),
}));
vi.mock("../src/i18n.tsx", () => ({ useLocale: () => ({ t: (text: string) => text, locale: "zh-CN" }) }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}
const task = (state: BackgroundTask["state"]): BackgroundTask => ({
	id: "task-1",
	kind: "generate",
	resource: "project:1",
	state,
	fingerprint: "test",
	createdAt: "2026-10-02T00:00:00Z",
	updatedAt: "2026-10-02T00:00:00Z",
});
let cleanup: (() => void) | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.mocked(requestJson).mockReset();
	hooks.effects = [];
	hooks.setters = [];
	hooks.initial = [];
	hooks.index = 0;
	hooks.refs = [];
	hooks.refIndex = 0;
});
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
	vi.useRealTimers();
});
async function flush() {
	await Promise.resolve();
	await Promise.resolve();
}

it("keeps slow healthy polls serial and updates from every completed response", async () => {
	vi.mocked(requestJson).mockImplementation(
		() => new Promise((resolve) => setTimeout(() => resolve({ tasks: [task("running")] }), 2500)),
	);
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await vi.advanceTimersByTimeAsync(10_000);
	expect(requestJson).toHaveBeenCalledTimes(3);
	expect(hooks.setters[0]).toHaveBeenCalledTimes(2);
	expect(hooks.setters[0]).toHaveBeenLastCalledWith([task("running")]);
});

it("reduces polling frequency when the task list has no active work", async () => {
	vi.mocked(requestJson).mockResolvedValue({ tasks: [task("succeeded")] });
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await vi.advanceTimersByTimeAsync(14999);
	expect(requestJson).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(requestJson).toHaveBeenCalledTimes(2);
});

it("backs off a polling failure and clears its message after recovery", async () => {
	vi.mocked(requestJson)
		.mockRejectedValueOnce(new Error("temporary failure"))
		.mockResolvedValueOnce({ tasks: [task("succeeded")] });
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await flush();
	expect(hooks.setters[3]).toHaveBeenLastCalledWith("temporary failure");
	await vi.advanceTimersByTimeAsync(3999);
	expect(requestJson).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(hooks.setters[3]).toHaveBeenLastCalledWith("");
});

function findAction(node: ReactNode, label = "取消任务"): (() => void) | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findAction(child, label);
			if (found) return found;
		}
		return;
	}
	if (!isValidElement(node)) return;
	const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
	if (element.props.children === label) return element.props.onClick;
	return findAction(element.props.children, label);
}

it("keeps a successful cancellation from being overwritten by a pre-action poll", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>();
	hooks.initial = [[task("running")], "task-1"];
	vi.mocked(requestJson)
		.mockReturnValueOnce(older.promise)
		.mockResolvedValueOnce(task("cancelled"))
		.mockResolvedValueOnce({ tasks: [task("cancelled")] });
	const page = TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	const cancel = findAction(page);
	expect(cancel).toBeDefined();
	cancel?.();
	await flush();
	older.resolve({ tasks: [task("running")] });
	await flush();
	expect(hooks.setters[0]).toHaveBeenLastCalledWith([task("cancelled")]);
	expect(requestJson).toHaveBeenCalledTimes(3);
});

it.each(["取消任务", "重试"])(
	"keeps %s ahead of polls started during the action and suppresses duplicate clicks",
	async (label) => {
		const action = deferred<BackgroundTask>(),
			poll = deferred<{ tasks: BackgroundTask[] }>();
		const updated = label === "重试" ? { ...task("queued"), id: "task-2" } : task("cancelled");
		hooks.initial = [[task(label === "重试" ? "failed" : "running")], "task-1"];
		vi.mocked(requestJson)
			.mockResolvedValueOnce({ tasks: [task("running")] })
			.mockReturnValueOnce(action.promise)
			.mockReturnValueOnce(poll.promise)
			.mockResolvedValueOnce({ tasks: [updated] });
		const page = TasksPage({ apiOrigin: "", paused: false });
		cleanup = hooks.effects[0]();
		await flush();
		const click = findAction(page, label);
		expect(click).toBeDefined();
		click?.();
		click?.();
		await vi.advanceTimersByTimeAsync(2000);
		action.resolve(updated);
		await flush();
		poll.resolve({ tasks: [task("running")] });
		await flush();
		expect(requestJson).toHaveBeenCalledTimes(4);
		const apply = hooks.setters[0].mock.calls
			.map(([value]) => value)
			.find((value) => typeof value === "function") as (tasks: BackgroundTask[]) => BackgroundTask[];
		expect(apply([])).toEqual([updated]);
		expect(hooks.setters[0]).toHaveBeenLastCalledWith([updated]);
	},
);

function renderAgain(apiOrigin: string, paused: boolean) {
	cleanup?.();
	cleanup = undefined;
	hooks.index = 0;
	hooks.refIndex = 0;
	hooks.effects = [];
	TasksPage({ apiOrigin, paused });
	cleanup = hooks.effects[0]();
}

it("discards paused responses and resumes polling in the new view", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>();
	vi.mocked(requestJson)
		.mockReturnValueOnce(older.promise)
		.mockResolvedValueOnce({ tasks: [task("succeeded")] });
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	renderAgain("", true);
	older.resolve({ tasks: [task("running")] });
	await vi.advanceTimersByTimeAsync(5000);
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(hooks.setters[0]).not.toHaveBeenCalled();
	renderAgain("https://new.example", false);
	await flush();
	expect(requestJson).toHaveBeenCalledTimes(2);
	expect(hooks.setters[0]).toHaveBeenLastCalledWith([task("succeeded")]);
});

it("ignores an action response after changing the API view", async () => {
	const action = deferred<BackgroundTask>();
	hooks.initial = [[task("running")], "task-1"];
	vi.mocked(requestJson)
		.mockResolvedValueOnce({ tasks: [] })
		.mockReturnValueOnce(action.promise)
		.mockResolvedValueOnce({ tasks: [task("succeeded")] });
	const page = TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await flush();
	findAction(page)?.();
	renderAgain("https://new.example", false);
	await flush();
	action.resolve(task("cancelled"));
	await flush();
	expect(hooks.setters[0]).toHaveBeenLastCalledWith([task("succeeded")]);
});

it("does not apply polling responses or errors after unmount", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>();
	vi.mocked(requestJson).mockReturnValueOnce(older.promise);
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await vi.advanceTimersByTimeAsync(2000);
	cleanup?.();
	cleanup = undefined;
	older.reject(new Error("late failure"));
	await flush();
	await vi.advanceTimersByTimeAsync(30000);
	expect(requestJson).toHaveBeenCalledTimes(1);
	expect(hooks.setters[0]).not.toHaveBeenCalled();
	expect(hooks.setters[3]).not.toHaveBeenCalled();
});
