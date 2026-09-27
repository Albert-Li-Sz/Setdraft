import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { ChatRequestQueue } from "../src/chat-requests.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-chat-requests-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function configuredChat(client: ConstructorParameters<typeof ChatService>[0]["client"]): Promise<ChatService> {
	const chat = new ChatService({ root, configPath: join(root, "ai-config.json"), client });
	await chat.configure({
		provider: "openai-completions",
		modelId: "faux",
		apiKey: "faux-key",
		contextWindow: 8192,
		maxTokens: 1024,
	});
	return chat;
}

async function waitFor(
	queue: ChatRequestQueue,
	chatId: string,
	requestId: string,
	state: "done" | "failed",
): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if ((await queue.get(requestId, chatId)).state === state) {
			await queue.idle();
			return;
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 10));
	}
	throw new Error(`Chat request did not reach ${state}.`);
}

describe("persisted chat requests", () => {
	it("submits a model request once and replays sequenced events without another call", async () => {
		let calls = 0;
		const chat = await configuredChat(async ({ onDelta }) => {
			calls++;
			onDelta("streamed ");
			return "streamed answer";
		});
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const conversation = await chat.create();
		const requestId = randomUUID();
		await queue.submit(conversation.id, requestId, "hello");
		await queue.submit(conversation.id, requestId, "hello");
		await waitFor(queue, conversation.id, requestId, "done");
		expect(calls).toBe(1);
		const events = await queue.events(requestId, conversation.id, 0);
		expect(events.map((event) => event.type)).toEqual(["start", "delta", "done"]);
		expect((await queue.events(requestId, conversation.id, events[0].sequence)).map((event) => event.type)).toEqual([
			"delta",
			"done",
		]);
		await expect(queue.submit(conversation.id, requestId, "different")).rejects.toThrow("请求 ID 已用于其他消息");
		database.sql.close();
	});

	it("keeps image data intact when the same request is submitted concurrently", async () => {
		let calls = 0;
		let sawImage = false;
		const chat = await configuredChat(async ({ context }) => {
			calls++;
			sawImage =
				Array.isArray(context.messages[0]?.content) &&
				context.messages[0].content.some((item) => item.type === "image");
			return "ok";
		});
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const conversation = await chat.create();
		const requestId = randomUUID();
		const image = {
			name: "pixel.png",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
		};
		await Promise.all([
			queue.submit(conversation.id, requestId, "look", undefined, undefined, [image]),
			queue.submit(conversation.id, requestId, "look", undefined, undefined, [image]),
		]);
		await waitFor(queue, conversation.id, requestId, "done");
		expect(calls).toBe(1);
		expect(sawImage).toBe(true);
		database.sql.close();
	});

	it("resumes queued requests after a restart and records interrupted runs", async () => {
		let calls = 0;
		const chat = await configuredChat(async () => {
			calls++;
			return "recovered";
		});
		const conversation = await chat.create();
		const interruptedConversation = await chat.create();
		const requestId = randomUUID();
		const database = new WorkspaceDatabase(root);
		const initialQueue = new ChatRequestQueue(database, chat);
		await initialQueue.ready;
		expect(await initialQueue.list(conversation.id)).toEqual([]);
		const now = new Date().toISOString();
		await database.sql.execute(
			"INSERT INTO chat_requests (id,chat_id,payload,fingerprint,state,created_at,updated_at,owner_pid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
			[
				requestId,
				conversation.id,
				JSON.stringify({ message: "recover", images: [] }),
				"fingerprint",
				"queued",
				now,
				now,
				0,
			],
		);
		await database.sql.execute(
			"INSERT INTO chat_requests (id,chat_id,payload,fingerprint,state,created_at,updated_at,owner_pid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
			[
				randomUUID(),
				interruptedConversation.id,
				JSON.stringify({ message: "interrupted", images: [] }),
				"fingerprint-2",
				"running",
				now,
				now,
				0,
			],
		);
		database.sql.close();

		const recoveredDatabase = new WorkspaceDatabase(root);
		const recoveredQueue = new ChatRequestQueue(recoveredDatabase, chat);
		await recoveredQueue.ready;
		await waitFor(recoveredQueue, conversation.id, requestId, "done");
		expect(calls).toBe(1);
		expect((await recoveredQueue.events(requestId, conversation.id, 0)).map((event) => event.type)).toEqual([
			"start",
			"done",
		]);
		const failed = (await recoveredQueue.list(interruptedConversation.id))[0];
		expect(failed?.state).toBe("failed");
		expect(failed?.error).toBe("服务中断；请重试。");
		recoveredDatabase.sql.close();
	});

	it("cancels a running request and emits a resumable cancellation error", async () => {
		const chat = await configuredChat(
			async ({ signal }): Promise<string> =>
				await new Promise<string>((_resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const conversation = await chat.create();
		const requestId = randomUUID();
		await queue.submit(conversation.id, requestId, "cancel me");
		for (
			let attempt = 0;
			attempt < 100 && (await queue.get(requestId, conversation.id)).state !== "running";
			attempt++
		)
			await new Promise((resolveWait) => setTimeout(resolveWait, 5));
		expect((await queue.get(requestId, conversation.id)).state).toBe("running");
		await queue.cancel(conversation.id, requestId);
		await waitFor(queue, conversation.id, requestId, "failed");
		expect((await queue.get(requestId, conversation.id)).error).toBe("已取消");
		expect((await queue.events(requestId, conversation.id, 0)).at(-1)).toMatchObject({
			type: "error",
			data: { message: "已取消" },
		});
		database.sql.close();
	});

	it("retries a failed request using the same user turn and clears stale stream events", async () => {
		let calls = 0;
		const chat = await configuredChat(async ({ onDelta }) => {
			calls++;
			if (calls === 1) {
				onDelta("partial");
				throw new Error("temporary failure");
			}
			onDelta("complete");
			return "complete";
		});
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const conversation = await chat.create();
		const requestId = randomUUID();
		await queue.submit(conversation.id, requestId, "hello");
		await waitFor(queue, conversation.id, requestId, "failed");
		expect((await queue.events(requestId, conversation.id, 0)).map((event) => event.type)).toEqual([
			"start",
			"delta",
			"error",
		]);
		await queue.retry(conversation.id, requestId);
		await waitFor(queue, conversation.id, requestId, "done");
		expect(calls).toBe(2);
		expect((await queue.events(requestId, conversation.id, 0)).map((event) => event.type)).toEqual([
			"start",
			"delta",
			"done",
		]);
		const saved = await chat.get(conversation.id);
		expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		database.sql.close();
	});

	it("allows only one concurrent retry for a failed request", async () => {
		let calls = 0;
		const chat = await configuredChat(async () => {
			calls++;
			if (calls === 1) throw new Error("temporary failure");
			return "complete";
		});
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const conversation = await chat.create();
		const requestId = randomUUID();
		await queue.submit(conversation.id, requestId, "hello");
		await waitFor(queue, conversation.id, requestId, "failed");
		const retries = await Promise.allSettled([
			queue.retry(conversation.id, requestId),
			queue.retry(conversation.id, requestId),
		]);
		expect(retries.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(retries.filter((item) => item.status === "rejected")).toHaveLength(1);
		await waitFor(queue, conversation.id, requestId, "done");
		expect(calls).toBe(2);
		database.sql.close();
	});

	it("does not reuse a request ID from another conversation", async () => {
		const chat = await configuredChat(async () => "ok");
		const database = new WorkspaceDatabase(root);
		const queue = new ChatRequestQueue(database, chat);
		await queue.ready;
		const first = await chat.create();
		const second = await chat.create();
		const requestId = randomUUID();
		await queue.submit(first.id, requestId, "same");
		await expect(queue.submit(second.id, requestId, "same")).rejects.toThrow("请求 ID 已用于其他消息");
		await queue.idle();
		database.sql.close();
	});
});
