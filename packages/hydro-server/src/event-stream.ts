import type { ServerResponse } from "node:http";
import { setImmediate } from "node:timers/promises";

interface SequencedEvent {
	sequence: number;
	type: string;
}

/** Replay through the cursor, draining every page before closing a terminal stream. */
export function streamEvents<T extends SequencedEvent>(
	response: ServerResponse,
	options: {
		after: number;
		read(after: number): T[];
		isTerminal(): boolean;
		data(event: T): unknown;
		pollMs?: number;
	},
): void {
	let after = options.after;
	let timer: NodeJS.Timeout | undefined;
	let closed = false;
	response.writeHead(200, {
		"cache-control": "no-cache, no-transform",
		"content-type": "text/event-stream; charset=utf-8",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	response.once("close", () => {
		closed = true;
		if (timer) clearTimeout(timer);
	});
	const push = async () => {
		try {
			while (!closed) {
				// Read terminal state first, so an event committed concurrently cannot be skipped.
				const terminal = options.isTerminal();
				const events = options.read(after);
				if (events.length === 0) {
					if (terminal) response.end();
					else timer = setTimeout(() => void push(), options.pollMs ?? 250);
					return;
				}
				for (const event of events) {
					if (closed) return;
					after = event.sequence;
					if (
						!response.write(
							`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(options.data(event))}\n\n`,
						)
					) {
						await new Promise<void>((resolve) => {
							const resume = () => {
								response.off("drain", resume);
								response.off("close", resume);
								resolve();
							};
							response.once("drain", resume);
							response.once("close", resume);
						});
					}
				}
				await setImmediate();
			}
		} catch (error) {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	};
	void push();
}
