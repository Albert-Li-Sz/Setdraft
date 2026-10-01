import { expect, it, vi } from "vitest";
import { TerminalSettlements } from "../src/terminal-settlements.ts";

it("bounds shutdown flush when a terminal database commit hangs", async () => {
	vi.useFakeTimers();
	const settlements = new TerminalSettlements();
	let recover: () => void = () => {};
	const commit = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				recover = resolve;
			}),
	);
	const settling = settlements.settle("finished", commit);
	try {
		const flushed = vi.fn();
		const flushing = settlements.flush(5000).then(flushed);
		await vi.advanceTimersByTimeAsync(5000);
		await flushing;
		expect(flushed).toHaveBeenCalledOnce();
		expect(settlements.has("finished")).toBe(true);
		expect(commit).toHaveBeenCalledOnce();
		recover();
		await settling;
		expect(settlements.has("finished")).toBe(false);
	} finally {
		settlements.stop();
		recover();
		vi.useRealTimers();
	}
});
