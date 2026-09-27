import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiConfigurationStore } from "../src/ai-configuration.ts";
import { ChatService } from "../src/chat.ts";
import { ChatRequestQueue } from "../src/chat-requests.ts";
import { IdentityStore } from "../src/identity.ts";
import { WebSearch } from "../src/web-search.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-search-"));
	vi.stubEnv("SETDRAFT_SEARCH_URL", "http://search:8080");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
const result = () =>
	Response.json({
		results: [
			{ title: "<b>Official docs</b>", url: "https://example.com/docs", content: "External reference" },
			{ title: "Invalid", url: "javascript:alert(1)", content: "invalid" },
			{ title: "Duplicate", url: "https://example.com/docs", content: "duplicate" },
		],
	});
it("normalizes sources, scopes caches and quotas, and reuses completed searches on retry", async () => {
	const identity = new IdentityStore(root);
	let calls = 0;
	const request: typeof fetch = async (input, init) => {
		calls++;
		expect(String(input)).toContain("http://search:8080/search?");
		expect(init?.redirect).toBe("error");
		return result();
	};
	const search = new WebSearch(identity, request);
	await search.configure({ enabled: true, provider: "searxng", dailyLimit: 1 });
	const id = randomUUID(),
		a = new WorkspaceDatabase(join(root, "a"), id),
		b = new WorkspaceDatabase(join(root, "b"), randomUUID());
	const first = await search.search(a, id, "request", "public query");
	expect(first.results).toEqual([
		{ id: 1, title: "Official docs", url: "https://example.com/docs", snippet: "External reference" },
	]);
	expect(await search.search(a, id, "request", "public query")).toEqual(first);
	expect(await search.search(a, id, "next-request", "public query")).toEqual(first);
	expect(calls).toBe(1);
	await expect(search.search(a, id, "other", "another query")).rejects.toMatchObject({ statusCode: 429 });
	await search.search(b, b.sql.accountId!, "request", "public query");
	expect(calls).toBe(2);
});
it("redacts provider keys and never returns upstream errors or follows redirects", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () => {
		throw new Error("fake-secret upstream details");
	});
	await search.configure({ enabled: true, provider: "tavily", apiKey: "fake-secret", dailyLimit: 10 });
	expect(JSON.stringify(await search.status())).not.toContain("fake-secret");
	const db = new WorkspaceDatabase(root);
	await expect(search.search(db, randomUUID(), randomUUID(), "query")).rejects.toThrow("联网搜索暂时不可用");
});
it("persists search events and sources and sends only explicit query text to the provider", async () => {
	const identity = new IdentityStore(root);
	let query = "";
	const service = new WebSearch(identity, async (input) => {
		query = new URL(String(input)).searchParams.get("q") ?? "";
		return result();
	});
	const db = new WorkspaceDatabase(root, randomUUID());
	const configuration = new AiConfigurationStore({ read: () => undefined, write: () => {} }, join(root, "unused"));
	await configuration.configure({
		provider: "openai-completions",
		modelId: "mock",
		apiKey: "fake",
		contextWindow: 16000,
		maxTokens: 1000,
	});
	const chat = new ChatService({
		root,
		database: db,
		configPath: join(root, "unused"),
		configuration,
		search: { service, userId: db.sql.accountId! },
		client: async ({ context, onDelta }) => {
			expect(context.systemPrompt).toContain("不可信");
			expect(context.systemPrompt).not.toContain("External reference");
			expect(JSON.stringify(context.messages.at(-1))).toContain("External reference");
			onDelta("Reference [1]");
			return "Reference [1]";
		},
	});
	const queue = new ChatRequestQueue(db, chat);
	await queue.ready;
	try {
		const conversation = await chat.create();
		const requestId = randomUUID();
		await queue.submit(
			conversation.id,
			requestId,
			"private conversation",
			"private project",
			undefined,
			[],
			true,
			"public query",
		);
		await queue.idle();
		expect(query).toBe("public query");
		expect((await queue.get(requestId, conversation.id)).state).toBe("done");
		expect((await queue.events(requestId, conversation.id, 0)).map((event) => event.type)).toEqual([
			"start",
			"search",
			"search",
			"delta",
			"done",
		]);
		expect((await chat.get(conversation.id)).messages.at(-1)?.search?.results).toHaveLength(1);
		await chat.delete(conversation.id);
		expect(await db.get("search-cache", `request:${requestId}`)).toBeUndefined();
	} finally {
		await queue.close();
	}
});
it("continues the model reply with a visible search failure and no invented sources", async () => {
	const identity = new IdentityStore(root);
	const service = new WebSearch(identity, async () => new Response("unavailable", { status: 503 }));
	const db = new WorkspaceDatabase(root);
	const chat = new ChatService({
		root,
		database: db,
		configPath: join(root, "unused"),
		search: { service, userId: randomUUID() },
		client: async () => "offline answer",
	});
	await chat.configure({ provider: "openai-completions", modelId: "mock", apiKey: "fake" });
	const conversation = await chat.create();
	const result = await chat.send(
		conversation.id,
		"question",
		undefined,
		{ onStart: () => {}, onDelta: () => {} },
		undefined,
		undefined,
		[],
		randomUUID(),
		true,
	);
	expect(result.messages.at(-1)).toMatchObject({
		content: "offline answer",
		searchError: "联网搜索暂时不可用，本次回复未使用网络资料。",
	});
	expect(result.messages.at(-1)?.search).toBeUndefined();
});
