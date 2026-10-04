import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DraftRecoveryWriter } from "../src/draft-recovery-writer.ts";
import { projectFixture } from "./project-fixture.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps the first edit immediately and saves the latest rapid edit within 250 ms", async () => {
	const store = { write: vi.fn(), saved: vi.fn() };
	const writer = new DraftRecoveryWriter(store, vi.fn());
	const base = projectFixture();
	writer.update(base, { ...base, title: "first" }, false);
	expect(store.write).toHaveBeenCalledTimes(1);
	for (let index = 0; index < 24; index++) {
		await vi.advanceTimersByTimeAsync(10);
		writer.update(base, { ...base, title: `edit ${index}` }, false);
	}
	expect(store.write).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(10);
	expect(store.write).toHaveBeenCalledTimes(2);
	expect(store.write).toHaveBeenLastCalledWith(base, { ...base, title: "edit 23" });
});

it("flushes the pending source edit before leaving the page and clears its timer", async () => {
	const store = { write: vi.fn(), saved: vi.fn() };
	const writer = new DraftRecoveryWriter(store, vi.fn());
	const base = projectFixture();
	writer.update(base, { ...base, title: "first" }, false);
	writer.update(base, { ...base, reference: { language: "python3", code: "print(42)" } }, false);
	writer.flush();
	expect(store.write).toHaveBeenLastCalledWith(
		base,
		expect.objectContaining({ reference: { language: "python3", code: "print(42)" } }),
	);
	await vi.advanceTimersByTimeAsync(1000);
	expect(store.write).toHaveBeenCalledTimes(2);
	expect(vi.getTimerCount()).toBe(0);
});

it("does not resurrect a recovery copy after saving and preserves the next first edit immediately", async () => {
	const store = { write: vi.fn(), saved: vi.fn() };
	const writer = new DraftRecoveryWriter(store, vi.fn());
	const base = projectFixture();
	writer.update(base, { ...base, title: "first" }, false);
	writer.update(base, { ...base, title: "second" }, false);
	writer.update(base, { ...base, revision: 2, title: "second" }, true);
	await vi.advanceTimersByTimeAsync(1000);
	expect(store.write).toHaveBeenCalledTimes(1);
	expect(store.saved).toHaveBeenCalledWith(base.id);
	writer.update(base, { ...base, title: "third" }, false);
	expect(store.write).toHaveBeenLastCalledWith(base, expect.objectContaining({ title: "third" }));
});

it("flushes the previous project before switching and reports storage failures", async () => {
	const store = { write: vi.fn(), saved: vi.fn() },
		onResult = vi.fn();
	const writer = new DraftRecoveryWriter(store, onResult);
	const base = projectFixture();
	writer.update(base, { ...base, title: "first" }, false);
	writer.update(base, { ...base, title: "pending" }, false);
	writer.update(projectFixture({ id: "other" }), projectFixture({ id: "other", title: "other" }), false);
	expect(store.write.mock.calls[1]).toEqual([base, expect.objectContaining({ title: "pending" })]);
	expect(store.write).toHaveBeenLastCalledWith(
		expect.objectContaining({ id: "other" }),
		expect.objectContaining({ title: "other" }),
	);
	writer.update(projectFixture({ id: "other" }), projectFixture({ id: "other", title: "other pending" }), false);
	const cause = new DOMException("Storage full", "QuotaExceededError");
	store.write.mockImplementation(() => {
		throw cause;
	});
	writer.flush();
	expect(onResult).toHaveBeenLastCalledWith(cause);
	await vi.advanceTimersByTimeAsync(1000);
	expect(vi.getTimerCount()).toBe(0);
});
