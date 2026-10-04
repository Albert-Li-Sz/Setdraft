import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type PageRefresh, startPageRefresh } from "../src/page-refresh.ts";

class Page extends EventTarget {
	hidden = false;
}
let page: Page;
let browser: EventTarget;
let network: { onLine: boolean };
let polling: PageRefresh | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	page = new Page();
	browser = new EventTarget();
	network = { onLine: true };
	vi.stubGlobal("document", page);
	vi.stubGlobal("window", browser);
	vi.stubGlobal("navigator", network);
});
afterEach(() => {
	polling?.stop();
	polling = undefined;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

it("serializes slow reads and coalesces manual refreshes behind the current request", async () => {
	let finish!: () => void;
	const read = vi.fn(
		() =>
			new Promise<undefined>((resolve) => {
				finish = () => resolve(undefined);
			}),
	);
	polling = startPageRefresh(read, 1000);
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(1);
	polling.refresh();
	polling.refresh();
	polling.refresh();
	finish();
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(2);
	finish();
	await vi.advanceTimersByTimeAsync(999);
	expect(read).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(3);
});

it("pauses hidden and offline pages and resumes immediately when available", async () => {
	const read = vi.fn(async () => undefined);
	polling = startPageRefresh(read, 1000);
	await vi.advanceTimersByTimeAsync(0);
	page.hidden = true;
	page.dispatchEvent(new Event("visibilitychange"));
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(1);
	page.hidden = false;
	page.dispatchEvent(new Event("visibilitychange"));
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(2);
	network.onLine = false;
	browser.dispatchEvent(new Event("offline"));
	browser.dispatchEvent(new Event("focus"));
	polling.refresh();
	await vi.advanceTimersByTimeAsync(10000);
	expect(read).toHaveBeenCalledTimes(2);
	network.onLine = true;
	browser.dispatchEvent(new Event("online"));
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(3);
});

it("backs off consecutive failures and returns to the normal interval after recovery", async () => {
	const read = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue(undefined);
	polling = startPageRefresh(read, 2000);
	await vi.advanceTimersByTimeAsync(3999);
	expect(read).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(7999);
	expect(read).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(read).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(2000);
	expect(read).toHaveBeenCalledTimes(4);
});

it("stops terminal polling but still allows focus and explicit refresh", async () => {
	const read = vi.fn(async () => false as const);
	polling = startPageRefresh(read, 1000);
	await vi.advanceTimersByTimeAsync(30000);
	expect(read).toHaveBeenCalledTimes(1);
	browser.dispatchEvent(new Event("focus"));
	await vi.advanceTimersByTimeAsync(0);
	polling.refresh();
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(3);
});

it("aborts an in-flight read on disposal and never schedules or wakes again", async () => {
	let finish!: () => void;
	const read = vi.fn(
		(_signal: AbortSignal) =>
			new Promise<undefined>((resolve) => {
				finish = () => resolve(undefined);
			}),
	);
	polling = startPageRefresh(read, 1000);
	polling.refresh();
	polling.stop();
	expect(read.mock.calls[0][0].aborted).toBe(true);
	finish();
	browser.dispatchEvent(new Event("focus"));
	page.dispatchEvent(new Event("visibilitychange"));
	polling.refresh();
	await vi.advanceTimersByTimeAsync(30000);
	expect(read).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("does not duplicate a queued manual refresh when an in-flight read finishes while hidden", async () => {
	let finish!: () => void;
	const read = vi.fn(
		() =>
			new Promise<undefined>((resolve) => {
				finish = () => resolve(undefined);
			}),
	);
	polling = startPageRefresh(read, 1000);
	polling.refresh();
	page.hidden = true;
	page.dispatchEvent(new Event("visibilitychange"));
	finish();
	await vi.advanceTimersByTimeAsync(0);
	page.hidden = false;
	page.dispatchEvent(new Event("visibilitychange"));
	finish();
	await vi.advanceTimersByTimeAsync(0);
	expect(read).toHaveBeenCalledTimes(2);
});
