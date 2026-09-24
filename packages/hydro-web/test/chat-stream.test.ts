import { describe, expect, it } from "vitest";
import { type ChatStreamEvent, readChatStream } from "../src/chat-stream.ts";

describe("AI chat event stream", () => {
	it("reads fragmented UTF-8, CRLF, heartbeats, multiline data and the final frame", async () => {
		const source =
			'event: start\r\ndata: {"chat":{"id":"chat","messages":[{"content":"你好"}]}}\r\n\r\n' +
			": ping\r\n\r\n" +
			'event: delta\r\ndata: {"delta":\r\ndata: "你"}\r\n\r\n' +
			'event: done\ndata: {"chat":{"id":"chat","messages":[]}}';
		const bytes = new TextEncoder().encode(source);
		const multibyte = bytes.indexOf(0xe4);
		const cuts = [1, 6, 39, multibyte + 1, multibyte + 2, 80, bytes.length - 1, bytes.length];
		let offset = 0;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const end of cuts) {
					if (end > offset) controller.enqueue(bytes.slice(offset, end));
					offset = end;
				}
				controller.close();
			},
		});
		const events: ChatStreamEvent[] = [];
		await readChatStream(body, (event) => events.push(event));
		expect(events.map((event) => event.type)).toEqual(["start", "delta", "done"]);
		expect(events[0]).toMatchObject({ chat: { messages: [{ content: "你好" }] } });
		expect(events[1]).toEqual({ type: "delta", delta: "你" });
	});

	it("rejects a malformed known event instead of treating it as success", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
				controller.close();
			},
		});
		await expect(readChatStream(body, () => {})).rejects.toThrow("格式无效");
	});
});
