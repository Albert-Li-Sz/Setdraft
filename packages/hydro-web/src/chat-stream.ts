import type { ChatStreamEvent } from "@setdraft/contracts";
import type { ChatConversation } from "./platform.ts";

export type { ChatStreamEvent } from "@setdraft/contracts";

function decodeEvent(name: string, data: string): ChatStreamEvent | undefined {
	if (!(["start", "delta", "done", "error", "search"] as string[]).includes(name)) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(data) as unknown;
	} catch {
		throw new Error("服务端返回的流式事件不是有效 JSON。");
	}
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
		throw new Error("服务端返回的流式事件格式无效。");
	}
	const record = payload as Record<string, unknown>;
	if (
		name === "search" &&
		["searching", "complete", "failed"].includes(String(record.phase)) &&
		typeof record.query === "string"
	)
		return {
			type: "search",
			phase: record.phase as "searching" | "complete" | "failed",
			query: record.query,
			message: typeof record.message === "string" ? record.message : undefined,
		};
	if (name === "delta" && typeof record.delta === "string") return { type: "delta", delta: record.delta };
	if (name === "error" && typeof record.message === "string") return { type: "error", message: record.message };
	if (name === "start" || name === "done") {
		const chat = record.chat;
		if (typeof chat === "object" && chat !== null && !Array.isArray(chat)) {
			const value = chat as Record<string, unknown>;
			if (typeof value.id === "string" && Array.isArray(value.messages)) {
				return { type: name, chat: chat as ChatConversation };
			}
		}
	}
	throw new Error("服务端返回的流式事件格式无效。");
}

export async function readChatStream(
	body: ReadableStream<Uint8Array>,
	onEvent: (event: ChatStreamEvent, sequence?: number) => void,
): Promise<void> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let eventName = "message";
	let eventId: number | undefined;
	let data: string[] = [];
	const dispatch = (): void => {
		if (data.length > 0) {
			const event = decodeEvent(eventName, data.join("\n"));
			if (event) onEvent(event, eventId);
		}
		eventName = "message";
		eventId = undefined;
		data = [];
	};
	const line = (value: string): void => {
		if (!value) {
			dispatch();
			return;
		}
		if (value.startsWith(":")) return;
		const separator = value.indexOf(":");
		const field = separator < 0 ? value : value.slice(0, separator);
		const raw = separator < 0 ? "" : value.slice(separator + 1);
		const content = raw.startsWith(" ") ? raw.slice(1) : raw;
		if (field === "event") eventName = content;
		if (field === "id" && Number.isSafeInteger(Number(content))) eventId = Number(content);
		if (field === "data") data.push(content);
	};
	const consume = (finished: boolean): void => {
		for (;;) {
			const boundary = pending.search(/[\r\n]/u);
			if (boundary < 0) break;
			const character = pending[boundary];
			if (character === "\r" && boundary === pending.length - 1 && !finished) break;
			const length = character === "\r" && pending[boundary + 1] === "\n" ? 2 : 1;
			line(pending.slice(0, boundary));
			pending = pending.slice(boundary + length);
		}
		if (finished) {
			if (pending) line(pending);
			pending = "";
			dispatch();
		}
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			consume(false);
		}
		pending += decoder.decode();
		consume(true);
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}
