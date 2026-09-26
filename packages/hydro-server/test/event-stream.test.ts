import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { streamEvents } from "../src/event-stream.ts";

describe("durable event replay", () => {
	it("stops polling when the subscriber disconnects", async () => {
		let reads = 0;
		let disconnected!: () => void;
		const closed = new Promise<void>((resolve) => {
			disconnected = resolve;
		});
		const server = createServer((_request, response) => {
			response.once("close", disconnected);
			streamEvents(response, {
				after: 0,
				pollMs: 10,
				read: (after) => {
					reads++;
					return after === 0 ? [{ sequence: 1, type: "start" }] : [];
				},
				isTerminal: () => false,
				data: () => ({ ready: true }),
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const controller = new AbortController();
			const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, {
				signal: controller.signal,
			});
			await response.body?.getReader().read();
			controller.abort();
			await closed;
			const finalReads = reads;
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(reads).toBe(finalReads);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("drains every page through the terminal event and resumes from an event ID", async () => {
		const events = Array.from({ length: 1201 }, (_, index) => ({
			sequence: index + 1,
			type: index === 1200 ? "done" : "delta",
			data: { text: "内容" },
		}));
		const server = createServer((request, response) =>
			streamEvents(response, {
				after: Number(request.headers["last-event-id"] ?? 0),
				read: (after) => events.filter((event) => event.sequence > after).slice(0, 500),
				isTerminal: () => true,
				data: (event) => event.data,
			}),
		);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const body = await fetch(url).then((response) => response.text());
			expect(body.match(/^id: /gm)).toHaveLength(1201);
			expect(body).toContain("id: 1201\nevent: done");
			const resumed = await fetch(url, { headers: { "last-event-id": "500" } }).then((response) => response.text());
			expect(resumed.match(/^id: /gm)).toHaveLength(701);
			expect(resumed.startsWith("id: 501\n")).toBe(true);
			expect(resumed).toContain("event: done");
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
