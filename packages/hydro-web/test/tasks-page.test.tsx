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
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: (effect: () => (() => void) | undefined) => hooks.effects.push(effect),
	useRef: (initial: unknown) => ({ current: initial }),
	useState: (initial: unknown) => {
		const index = hooks.index++;
		const setter = vi.fn();
		hooks.setters.push(setter);
		return [hooks.initial[index] ?? initial, setter];
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
	hooks.effects = [];
	hooks.setters = [];
	hooks.initial = [];
	hooks.index = 0;
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

it("rejects an older running response after a newer terminal poll", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>(),
		newer = deferred<{ tasks: BackgroundTask[] }>();
	vi.mocked(requestJson).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await vi.advanceTimersByTimeAsync(2000);
	newer.resolve({ tasks: [task("succeeded")] });
	await flush();
	older.resolve({ tasks: [task("running")] });
	await flush();
	expect(hooks.setters[0]).toHaveBeenLastCalledWith([task("succeeded")]);
});

it("clears a stale polling error on recovery and ignores errors from older responses", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>(),
		newer = deferred<{ tasks: BackgroundTask[] }>();
	vi.mocked(requestJson)
		.mockRejectedValueOnce(new Error("temporary failure"))
		.mockReturnValueOnce(older.promise)
		.mockReturnValueOnce(newer.promise);
	TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	await flush();
	expect(hooks.setters[3]).toHaveBeenLastCalledWith("temporary failure");
	await vi.advanceTimersByTimeAsync(4000);
	newer.resolve({ tasks: [task("succeeded")] });
	await flush();
	older.reject(new Error("old failure"));
	await flush();
	expect(hooks.setters[3]).toHaveBeenLastCalledWith("");
});

function findCancel(node: ReactNode): (() => void) | undefined {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findCancel(child);
			if (found) return found;
		}
		return;
	}
	if (!isValidElement(node)) return;
	const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
	if (element.props.children === "取消任务") return element.props.onClick;
	return findCancel(element.props.children);
}

it("keeps a successful cancellation from being overwritten by a pre-action poll", async () => {
	const older = deferred<{ tasks: BackgroundTask[] }>();
	hooks.initial = [[task("running")], "task-1"];
	vi.mocked(requestJson).mockReturnValueOnce(older.promise).mockResolvedValueOnce(task("cancelled"));
	const page = TasksPage({ apiOrigin: "", paused: false });
	cleanup = hooks.effects[0]();
	const cancel = findCancel(page);
	expect(cancel).toBeDefined();
	cancel?.();
	await flush();
	older.resolve({ tasks: [task("running")] });
	await flush();
	expect(hooks.setters[0].mock.calls.at(-1)?.[0]).toBeTypeOf("function");
});
