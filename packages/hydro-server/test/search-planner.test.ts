import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ChatModelClient, ChatService } from "../src/chat.ts";
import { ChatRequestQueue } from "../src/chat-requests.ts";
import { IdentityStore } from "../src/identity.ts";
import { WebSearch } from "../src/web-search.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-plan-search-"));
	vi.stubEnv("SETDRAFT_SEARCH_URL", "http://faux-search:8080");
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});
const usage: Usage = {
	input: 10,
	output: 5,
	totalTokens: 15,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
};
async function fixture(client: ChatModelClient, fetcher: typeof fetch, dailyLimit = 20) {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, fetcher);
	await search.configure({ enabled: true, provider: "searxng", dailyLimit });
	const database = new WorkspaceDatabase(root, randomUUID());
	const chat = new ChatService({
		root,
		configPath: join(root, "faux-config"),
		database,
		client,
		search: { service: search, userId: database.sql.accountId! },
	});
	await chat.configure({
		provider: "openai-completions",
		modelId: "faux",
		apiKey: "faux-only",
		contextWindow: 16000,
		maxTokens: 1000,
	});
	const conversation = await chat.create();
	return { chat, database, id: conversation.id };
}
const events = { onStart() {}, onDelta() {} };
const sources = (url = "https://example.org/doc") =>
	Response.json({ results: [{ title: "Reference", url, content: "Faux reference" }] });
it("plans follow-up queries, deduplicates URLs, persists stages and accounts for both model calls", async () => {
	const queries: string[] = [];
	const contexts: string[] = [];
	const { chat, id } = await fixture(
		async ({ context }) => {
			if (context.systemPrompt?.includes("关键词规划器")) {
				contexts.push(JSON.stringify(context.messages));
				return { text: '["图论 最短路","Dijkstra algorithm"]', usage };
			}
			return { text: "Answer [1]", usage };
		},
		async (url) => {
			queries.push(new URL(String(url)).searchParams.get("q")!);
			return sources(
				queries.length % 2 ? "https://example.org/doc?utm_source=faux" : "https://example.org/doc#part",
			);
		},
	);
	await chat.send(id, "我在实现 Dijkstra", undefined, events, undefined, undefined, [], randomUUID(), false);
	const result = await chat.send(
		id,
		"它如何处理负权？",
		undefined,
		events,
		undefined,
		undefined,
		[],
		randomUUID(),
		true,
	);
	expect(contexts[0]).toContain("Dijkstra");
	expect(contexts[0]).toContain("负权");
	expect(queries).toEqual(["图论 最短路", "Dijkstra algorithm"]);
	const answer = result.messages.at(-1)!;
	expect(answer.search?.results).toHaveLength(1);
	expect(answer.searchPlan).toMatchObject({ state: "ready", source: "ai", queries });
	expect(answer.usage).toMatchObject({ input: 20, output: 10, totalTokens: 30 });
	expect(answer.answerUsage).toEqual(usage);
});
it("rejects supplied keywords and replans a new request while preserving old answers", async () => {
	let plans = 0;
	const queries: string[] = [];
	const { chat, database, id } = await fixture(
		async ({ context }) =>
			context.systemPrompt?.includes("关键词规划器") ? JSON.stringify([`plan-${++plans}`]) : "Answer [1]",
		async (url) => {
			queries.push(new URL(String(url)).searchParams.get("q")!);
			return sources();
		},
	);
	const queue = new ChatRequestQueue(database, chat);
	try {
		for (const query of ["manual", ""]) {
			await expect(
				chat.send(id, "question", undefined, events, undefined, undefined, [], randomUUID(), true, query),
			).rejects.toMatchObject({ statusCode: 422 });
			await expect(
				queue.submit(id, randomUUID(), "question", undefined, undefined, [], true, query),
			).rejects.toMatchObject({ statusCode: 422 });
		}
		expect((await chat.get(id)).messages).toHaveLength(0);
		await chat.send(id, "question", undefined, events, undefined, undefined, [], randomUUID(), true);
		const result = await chat.send(id, "question", undefined, events, undefined, undefined, [], randomUUID(), true);
		expect(queries).toEqual(["plan-1", "plan-2"]);
		expect(result.messages).toHaveLength(4);
		expect(result.messages.at(-1)?.searchPlan?.source).toBe("ai");
	} finally {
		await queue.close();
	}
});
it("retries only incomplete stages without duplicate search quota or planning usage", async () => {
	let plans = 0,
		searches = 0,
		answers = 0;
	const { chat, database, id } = await fixture(
		async ({ context }) => {
			if (context.systemPrompt?.includes("关键词规划器")) {
				plans++;
				return { text: '["query"]', usage };
			}
			if (++answers === 1) throw new Error("faux answer failure");
			return { text: "Answer [1]", usage };
		},
		async () => {
			searches++;
			return sources();
		},
		1,
	);
	const queue = new ChatRequestQueue(database, chat);
	await queue.ready;
	const request = randomUUID();
	try {
		await queue.submit(id, request, "question", undefined, undefined, [], true);
		await queue.idle();
		expect((await queue.get(request, id)).state).toBe("failed");
		await queue.retry(id, request);
		await queue.idle();
		expect((await queue.get(request, id)).state).toBe("done");
		expect([plans, searches, answers]).toEqual([1, 1, 2]);
		expect((await chat.get(id)).messages.at(-1)?.usage?.totalTokens).toBe(30);
	} finally {
		await queue.close();
	}
});
it("retains successful searches when another keyword exceeds the quota", async () => {
	const { chat, id } = await fixture(
		async ({ context }) => (context.systemPrompt?.includes("关键词规划器") ? '["one","two"]' : "Answer [1]"),
		async () => sources(),
		1,
	);
	const result = await chat.send(id, "question", undefined, events, undefined, undefined, [], randomUUID(), true);
	expect(result.messages.at(-1)).toMatchObject({
		searchStatus: "partial",
		searchError: expect.stringContaining("部分搜索"),
		search: { results: [expect.objectContaining({ id: 1 })] },
	});
	expect(result.messages.at(-1)?.searchPlan?.results).toHaveLength(2);
});
it("marks planning failure as offline and never falls back to searching the raw question", async () => {
	let searches = 0;
	const { chat, id } = await fixture(
		async () => "not JSON",
		async () => {
			searches++;
			return sources();
		},
	);
	const result = await chat.send(
		id,
		"private question",
		undefined,
		events,
		undefined,
		undefined,
		[],
		randomUUID(),
		true,
	);
	expect(searches).toBe(0);
	expect(result.messages.at(-1)?.search).toBeUndefined();
	expect(result.messages.at(-1)?.searchPlan?.state).toBe("failed");
	expect(result.messages.at(-1)?.searchError).toContain("未使用网络资料");
});
it.each(["planning", "searching"] as const)(
	"propagates cancellation during %s and never calls the answer stage",
	async (phase) => {
		const controller = new AbortController();
		let answers = 0;
		const { chat, id } = await fixture(
			async ({ context, signal }) => {
				if (context.systemPrompt?.includes("关键词规划器")) {
					if (phase === "planning") {
						controller.abort();
						signal?.throwIfAborted();
					}
					return '["one","two"]';
				}
				answers++;
				return "Unexpected answer";
			},
			async () => {
				controller.abort();
				throw new Error("cancelled transport");
			},
		);
		await expect(
			chat.send(id, "question", undefined, events, controller.signal, undefined, [], randomUUID(), true),
		).rejects.toThrow();
		expect(answers).toBe(0);
	},
);

it("limits parallel searches to two, streams each group's outcome and keeps source order stable", async () => {
	const waiting = new Map<string, (response: Response) => void>();
	const snapshots: unknown[] = [];
	const { chat, id } = await fixture(
		async ({ context }) => (context.systemPrompt?.includes("关键词规划器") ? '["one","two","three"]' : "Answer [1]"),
		async (url) => {
			const query = new URL(String(url)).searchParams.get("q")!;
			return new Promise<Response>((resolve) => {
				waiting.set(query, resolve);
			});
		},
	);
	const sending = chat.send(
		id,
		"question",
		undefined,
		{
			...events,
			onSearch: (_phase, _query, _message, results) => {
				snapshots.push(structuredClone(results));
			},
		},
		undefined,
		undefined,
		[],
		randomUUID(),
		true,
	);
	await vi.waitFor(() => expect([...waiting.keys()].sort()).toEqual(["one", "two"]));
	waiting.get("two")!(sources("https://example.org/two"));
	await vi.waitFor(() => expect(waiting.has("three")).toBe(true));
	waiting.get("three")!(Response.json({}, { status: 503 }));
	waiting.get("one")!(sources("https://example.org/one"));
	const answer = (await sending).messages.at(-1)!;
	expect(answer.search?.results.map((item) => item.url)).toEqual([
		"https://example.org/one",
		"https://example.org/two",
	]);
	expect(answer.searchPlan?.results).toEqual([
		expect.objectContaining({ query: "one", state: "complete", count: 1, durationMs: expect.any(Number) }),
		expect.objectContaining({ query: "two", state: "complete", count: 1 }),
		expect.objectContaining({ query: "three", state: "failed", count: 0, message: expect.any(String) }),
	]);
	expect(snapshots.some((snapshot) => JSON.stringify(snapshot)?.includes('"state":"pending"'))).toBe(true);
	expect(
		snapshots.some(
			(snapshot) =>
				JSON.stringify(snapshot)?.includes('"state":"complete"') &&
				JSON.stringify(snapshot)?.includes('"state":"searching"'),
		),
	).toBe(true);
});
