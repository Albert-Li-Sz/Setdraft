import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AiConfigurationStore } from "../src/ai-configuration.ts";
import { ChatService } from "../src/chat.ts";
import { ChatRequestQueue } from "../src/chat-requests.ts";
import { IdentityStore } from "../src/identity.ts";
import { SearchFailure, WebSearch } from "../src/web-search.ts";
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
		expect(new Headers(init?.headers).get("x-forwarded-for")).toBe("127.0.0.1");
		expect(new Headers(init?.headers).get("x-real-ip")).toBe("127.0.0.1");
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
	expect(await search.search(a, id, "request", "public query")).toEqual({ ...first, cached: true });
	expect(await search.search(a, id, "next-request", "public query")).toEqual({ ...first, cached: true });
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
it("identifies unavailable SearXNG engines instead of hiding their failure behind a generic error", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () =>
		Response.json({
			results: [],
			unresponsive_engines: [
				["duckduckgo", "timeout"],
				["brave", "timeout"],
			],
		}),
	);
	const database = new WorkspaceDatabase(root);
	await expect(search.search(database, randomUUID(), randomUUID(), "public query")).rejects.toMatchObject({
		statusCode: 502,
		message: expect.stringContaining("上游搜索引擎"),
	});
});
it("uses surviving engines without exposing upstream failure details", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () =>
		Response.json({
			results: [{ title: "Available source", url: "https://example.com/docs", content: "Real result" }],
			unresponsive_engines: [["duckduckgo", "fake-secret timeout"]],
		}),
	);
	const database = new WorkspaceDatabase(root);
	const snapshot = await search.search(database, randomUUID(), randomUUID(), "query");
	expect(snapshot.results).toHaveLength(1);
	expect(snapshot.diagnostics).toMatchObject({
		status: "partial",
		candidateCount: 1,
		acceptedCount: 1,
		engines: [{ name: "duckduckgo", category: "timeout" }],
	});
	expect(JSON.stringify(snapshot)).not.toContain("fake-secret");
});
it("accepts arXiv paper abstracts in the default search when general web engines fail", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async (input) => {
		const url = new URL(String(input));
		expect(url.searchParams.get("categories")).toBe("general");
		expect(url.searchParams.get("q")).toBe("graph shortest path");
		return Response.json({
			results: [
				{
					template: "paper.html",
					engine: "arxiv",
					title: "A <b>shortest path</b> algorithm",
					url: "https://arxiv.org/abs/2501.00001",
					content: "An algorithm for finding shortest paths in graphs.",
					pdf_url: "https://arxiv.org/pdf/2501.00001",
				},
			],
			unresponsive_engines: [
				["bing", "timeout"],
				["360search", "HTTP error"],
			],
		});
	});
	const snapshot = await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "graph shortest path");
	expect(snapshot.results).toEqual([
		{
			id: 1,
			title: "A shortest path algorithm",
			url: "https://arxiv.org/abs/2501.00001",
			snippet: "An algorithm for finding shortest paths in graphs.",
		},
	]);
	expect(snapshot.diagnostics).toMatchObject({ status: "partial", candidateCount: 1, acceptedCount: 1 });
});
it("retains an arXiv paper when scientific results are ranked behind general web pages", async () => {
	const identity = new IdentityStore(root);
	const pages = Array.from({ length: 5 }, (_, index) => ({
		title: `Web page ${index + 1}`,
		url: `https://example.com/${index + 1}`,
		content: "General web reference",
		engine: "bing",
	}));
	const search = new WebSearch(identity, async () =>
		Response.json({
			results: [
				...pages,
				{ engine: "arxiv", title: "Invalid paper", url: "javascript:blocked", content: "Invalid source" },
				{
					engine: "arxiv",
					title: "Shortest paths in graphs",
					url: "http://arxiv.org/abs/2501.00001",
					content: "A paper abstract",
				},
			],
		}),
	);
	const snapshot = await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "graph shortest path");
	expect(snapshot.results).toEqual([
		...pages.slice(0, 4).map(({ title, url, content }, index) => ({ id: index + 1, title, url, snippet: content })),
		{ id: 5, title: "Shortest paths in graphs", url: "http://arxiv.org/abs/2501.00001", snippet: "A paper abstract" },
	]);
	expect(snapshot.diagnostics).toMatchObject({ status: "healthy", candidateCount: 7, acceptedCount: 5 });
});
it("refreshes pre-arXiv query caches after upgrade while reusing new query caches", async () => {
	const identity = new IdentityStore(root),
		database = new WorkspaceDatabase(root),
		user = randomUUID();
	const query = "graph shortest path";
	const oldKey = createHash("sha256").update(`searxng:::${query}`).digest("hex");
	await database.put("search-cache", oldKey, {
		expiresAt: Date.now() + 900000,
		snapshot: {
			query,
			provider: "searxng",
			searchedAt: new Date().toISOString(),
			results: [{ id: 1, title: "Old cached page", url: "https://example.com/old", snippet: "Old reference" }],
		},
	});
	let calls = 0;
	const search = new WebSearch(identity, async () => {
		calls += 1;
		return Response.json({
			results: [{ title: "Paper", url: "https://arxiv.org/abs/2501.00001", content: "Paper abstract" }],
		});
	});
	const fresh = await search.search(database, user, randomUUID(), query);
	expect(fresh.results[0].url).toBe("https://arxiv.org/abs/2501.00001");
	expect(fresh.cached).not.toBe(true);
	expect(await search.search(database, user, randomUUID(), query)).toEqual({ ...fresh, cached: true });
	expect(calls).toBe(1);
});
it.each([
	["HTTP connection error", "network"],
	["HTTP error", "http"],
	["HTTP 403", "http"],
])("classifies the SearXNG engine failure %s as %s", async (reason, category) => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () =>
		Response.json({ results: [], unresponsive_engines: [["bing", reason]] }),
	);
	await expect(
		search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "public query"),
	).rejects.toMatchObject({
		diagnostics: { status: "engines-unavailable", engines: [{ name: "bing", category }] },
	});
});
it("distinguishes filtered-empty and malformed responses from a valid no-match result", async () => {
	const identity = new IdentityStore(root);
	const database = new WorkspaceDatabase(root);
	for (const [raw, status] of [
		[{ results: [{ title: "blocked", content: "secret query", url: "javascript:secret" }] }, "filtered-empty"],
		[{ error: "fake-secret" }, "invalid-response"],
		[{ results: [] }, "no-match"],
	] as const) {
		const search = new WebSearch(identity, async () => Response.json(raw));
		try {
			await search.search(database, randomUUID(), randomUUID(), "private search");
			throw new Error("Expected failure");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchFailure);
			expect(error).toMatchObject({ diagnostics: { status } });
			expect(JSON.stringify(error)).not.toMatch(/fake-secret|private search|secret query|javascript/u);
		}
	}
});
it("probes enabled engines independently, redacts reports and uses the existing quota", async () => {
	const identity = new IdentityStore(root);
	const calls: URL[] = [];
	const search = new WebSearch(identity, async (input) => {
		const url = new URL(String(input));
		calls.push(url);
		if (url.pathname === "/config")
			return Response.json({
				engines: [
					{ name: "bing", categories: ["general"], enabled: true },
					{ name: "duckduckgo", categories: ["general"], enabled: true },
					{ name: "arxiv", categories: ["general", "science", "scientific publications"], enabled: true },
					{ name: "disabled", categories: ["general"], enabled: false },
				],
			});
		if (url.searchParams.get("engines") === "duckduckgo")
			return Response.json({ results: [], unresponsive_engines: [["duckduckgo", "fake-secret timeout"]] });
		if (url.searchParams.get("engines") === "arxiv") {
			expect(url.searchParams.get("q")).toBe("graph shortest path");
			return Response.json({
				results: [{ title: "Paper", url: "https://arxiv.org/abs/2501.00001", content: "Paper abstract" }],
			});
		}
		return result();
	});
	await search.configure({ enabled: true, provider: "searxng", dailyLimit: 4 });
	const database = new WorkspaceDatabase(root),
		user = randomUUID();
	const report = await search.diagnose(database, user, "zh");
	expect(report.aggregate).toMatchObject({ status: "healthy", candidateCount: 3, acceptedCount: 1 });
	expect(report.engines.map(({ name, diagnostics }) => [name, diagnostics.status])).toEqual([
		["bing", "healthy"],
		["duckduckgo", "engines-unavailable"],
		["arxiv", "healthy"],
	]);
	for (const url of calls.filter((url) => url.searchParams.has("engines")))
		expect(url.searchParams.has("categories")).toBe(false);
	expect(JSON.stringify(report)).not.toMatch(
		/fake-secret|Python|example.com|External reference|graph shortest path|arxiv.org|Paper abstract/u,
	);
	expect((await search.status()).health).toEqual(report.aggregate);
	await expect(search.diagnose(database, user, "en")).rejects.toMatchObject({ statusCode: 429 });
	expect(
		await database.sql.one("SELECT 1 FROM documents WHERE kind='search-cache' AND id LIKE 'request:%'"),
	).toBeUndefined();
});
it.each([403, 429])("explains provider HTTP %s without returning its response body", async (status) => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () => new Response("fake-secret provider body", { status }));
	const database = new WorkspaceDatabase(root);
	await expect(search.search(database, randomUUID(), randomUUID(), "query")).rejects.toMatchObject({
		statusCode: 502,
		message: expect.stringContaining("搜索服务拒绝请求"),
	});
});
it("distinguishes a valid empty search from engine outages", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () => Response.json({ results: [], unresponsive_engines: [] }));
	const database = new WorkspaceDatabase(root);
	await expect(search.search(database, randomUUID(), randomUUID(), "query")).rejects.toThrow("未找到可用的搜索结果");
});
it("does not send internal service headers to Tavily", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async (_input, init) => {
		expect(new Headers(init?.headers).has("x-forwarded-for")).toBe(false);
		expect(new Headers(init?.headers).has("x-real-ip")).toBe(false);
		return result();
	});
	await search.configure({ enabled: true, provider: "tavily", apiKey: "fake-key", dailyLimit: 10 });
	await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "query");
});
it("bypasses cached results for a fresh connectivity check", async () => {
	const identity = new IdentityStore(root);
	let calls = 0;
	const search = new WebSearch(identity, async () => {
		calls += 1;
		return calls === 1 ? result() : new Response("offline", { status: 503 });
	});
	const database = new WorkspaceDatabase(root);
	const userId = randomUUID();
	await search.search(database, userId, "initial", "query");
	await search.search(database, userId, "cached", "query");
	await expect(search.search(database, userId, "probe", "query", undefined, { bypassCache: true })).rejects.toThrow(
		"联网搜索暂时不可用",
	);
	expect(calls).toBe(2);
});
it("reports the search deadline without exposing transport errors", async () => {
	const controller = new AbortController();
	const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
	try {
		const identity = new IdentityStore(root);
		const search = new WebSearch(identity, async () => {
			controller.abort();
			throw new Error("fake-secret transport error");
		});
		const database = new WorkspaceDatabase(root);
		await expect(search.search(database, randomUUID(), randomUUID(), "query")).rejects.toMatchObject({
			statusCode: 502,
			message: "联网搜索超时，请管理员检查搜索服务和出站网络；本次回复未使用网络资料。",
		});
	} finally {
		timeout.mockRestore();
	}
});
it("preserves caller cancellation instead of reporting an upstream outage", async () => {
	const controller = new AbortController();
	const reason = new Error("Cancelled by caller");
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () => {
		controller.abort(reason);
		throw new Error("transport stopped");
	});
	const database = new WorkspaceDatabase(root);
	await expect(search.search(database, randomUUID(), randomUUID(), "query", controller.signal)).rejects.toBe(reason);
});
it("persists search events and sources and sends only AI planned query text to the provider", async () => {
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
			if (context.systemPrompt?.includes("关键词规划器")) return '["public query"]';
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
		await queue.submit(conversation.id, requestId, "private conversation", "private project", undefined, [], true);
		await queue.idle();
		expect(query).toBe("public query");
		expect((await queue.get(requestId, conversation.id)).state).toBe("done");
		expect((await queue.events(requestId, conversation.id, 0)).map((event) => event.type)).toEqual([
			"start",
			"search",
			"search",
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
		client: async ({ context }) =>
			context.systemPrompt?.includes("关键词规划器") ? '["question"]' : "offline answer",
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
		searchError: "未取得可用资料，本次回复未使用网络资料。",
	});
	expect(result.messages.at(-1)?.search).toBeUndefined();
});
it("uses the DeepSeek Search API with a bearer key and maps snippets without internal headers", async () => {
	const identity = new IdentityStore(root);
	let captured: { url: URL; init: RequestInit | undefined } | undefined;
	const search = new WebSearch(identity, async (input, init) => {
		captured = { url: new URL(String(input)), init };
		return Response.json({
			results: [
				{
					title: "<b>DeepSeek V4</b>",
					url: "https://example.com/deepseek",
					snippet: "A <i>model</i> release",
					summary: "Longer summary",
					date: "2026-06-01T00:00:00+00:00",
					authority: 3,
				},
				{ title: "Invalid", url: "javascript:alert(1)", snippet: "blocked" },
				{ title: "Duplicate", url: "https://example.com/deepseek", snippet: "duplicate" },
				{ title: "Summary only", url: "https://example.com/summary", snippet: "", summary: "<b>Summary</b> text" },
			],
		});
	});
	await search.configure({ enabled: true, provider: "deepseek", apiKey: "fake-deepseek-key", dailyLimit: 10 });
	const snapshot = await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "DeepSeek V4");
	expect(captured?.url.href).toBe("https://api.deepseek.com/v1/tools/search");
	expect(captured?.init?.method).toBe("POST");
	expect(captured?.init?.redirect).toBe("error");
	const headers = new Headers(captured?.init?.headers);
	expect(headers.get("authorization")).toBe("Bearer fake-deepseek-key");
	expect(headers.get("content-type")).toBe("application/json");
	expect(headers.has("x-forwarded-for")).toBe(false);
	expect(headers.has("x-real-ip")).toBe(false);
	expect(JSON.parse(String(captured?.init?.body))).toEqual({
		count: 10,
		query: "DeepSeek V4",
		need_content: false,
	});
	expect(snapshot.provider).toBe("deepseek");
	expect(snapshot.results).toEqual([
		{ id: 1, title: "DeepSeek V4", url: "https://example.com/deepseek", snippet: "A model release" },
		{ id: 2, title: "Summary only", url: "https://example.com/summary", snippet: "Summary text" },
	]);
	expect(JSON.stringify(await search.status())).not.toContain("fake-deepseek-key");
});
it("truncates DeepSeek queries to the API limit without splitting characters", async () => {
	const identity = new IdentityStore(root);
	let body: Record<string, unknown> | undefined;
	const search = new WebSearch(identity, async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return Response.json({
			results: [{ title: "Truncated", url: "https://example.com/truncated", snippet: "Result" }],
		});
	});
	await search.configure({ enabled: true, provider: "deepseek", apiKey: "fake-key", dailyLimit: 10 });
	const snapshot = await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "😀".repeat(200));
	expect(body?.query).toBe("😀".repeat(128));
	expect(snapshot.query).toBe("😀".repeat(128));
});
it.each([
	[401, "搜索服务 API Key 无效"],
	[402, "搜索服务账户余额不足"],
	[429, "搜索服务拒绝请求"],
])("explains DeepSeek HTTP %s without returning its response body", async (status, message) => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity, async () => new Response("fake-secret provider body", { status }));
	await search.configure({ enabled: true, provider: "deepseek", apiKey: "fake-key", dailyLimit: 10 });
	const failure = await search.search(new WorkspaceDatabase(root), randomUUID(), randomUUID(), "query").then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(failure).toMatchObject({ statusCode: 502, message: expect.stringContaining(message) });
	expect(JSON.stringify(failure)).not.toContain("fake-secret provider body");
});
it("does not reuse another provider's key after switching to DeepSeek", async () => {
	const identity = new IdentityStore(root);
	const search = new WebSearch(identity);
	await search.configure({ enabled: false, provider: "tavily", apiKey: "fake-tavily-key", dailyLimit: 10 });
	await expect(search.configure({ enabled: true, provider: "deepseek", dailyLimit: 10 })).rejects.toThrow(
		"请填写 DeepSeek API Key。",
	);
	const configured = await search.configure({
		enabled: true,
		provider: "deepseek",
		apiKey: "fake-deepseek-key",
		dailyLimit: 10,
	});
	expect(configured).toMatchObject({ provider: "deepseek", apiKeyConfigured: true, available: true });
	expect(JSON.stringify(configured)).not.toContain("fake-deepseek-key");
	expect(await search.configure({ enabled: true, provider: "deepseek", dailyLimit: 10 })).toMatchObject({
		provider: "deepseek",
		apiKeyConfigured: true,
	});
	await expect(search.configure({ enabled: true, provider: "tavily", dailyLimit: 10 })).rejects.toThrow(
		"请填写 Tavily API Key。",
	);
	await expect(
		search.configure({ enabled: true, provider: ["deepseek"], apiKey: "fake-key", dailyLimit: 10 }),
	).rejects.toThrow("搜索配置无效。");
});
it("diagnoses DeepSeek without probing SearXNG engines", async () => {
	const identity = new IdentityStore(root);
	let calls = 0;
	const search = new WebSearch(identity, async () => {
		calls += 1;
		return Response.json({
			results: [{ title: "Python", url: "https://www.python.org/", snippet: "Official documentation" }],
		});
	});
	await search.configure({ enabled: true, provider: "deepseek", apiKey: "fake-key", dailyLimit: 10 });
	const report = await search.diagnose(new WorkspaceDatabase(root), randomUUID(), "zh");
	expect(report.provider).toBe("deepseek");
	expect(report.engines).toEqual([]);
	expect(report.aggregate).toMatchObject({ status: "healthy", candidateCount: 1, acceptedCount: 1 });
	expect(calls).toBe(1);
});
it("keeps DeepSeek and Tavily result caches separate for the same query", async () => {
	const identity = new IdentityStore(root);
	const calls: string[] = [];
	const search = new WebSearch(identity, async (input, init) => {
		const url = new URL(String(input));
		calls.push(url.hostname);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (url.hostname === "api.deepseek.com")
			return Response.json({
				results: [{ title: "DeepSeek source", url: "https://example.com/deepseek", snippet: "DeepSeek result" }],
			});
		expect(body.api_key).toBe("fake-tavily-key");
		return Response.json({
			results: [{ title: "Tavily source", url: "https://example.com/tavily", content: "Tavily result" }],
		});
	});
	const database = new WorkspaceDatabase(root);
	const user = randomUUID();
	await search.configure({ enabled: true, provider: "deepseek", apiKey: "fake-deepseek-key", dailyLimit: 10 });
	const deepseek = await search.search(database, user, randomUUID(), "shared query");
	await search.configure({ enabled: true, provider: "tavily", apiKey: "fake-tavily-key", dailyLimit: 10 });
	const tavily = await search.search(database, user, randomUUID(), "shared query");
	expect(deepseek.provider).toBe("deepseek");
	expect(deepseek.results[0].url).toBe("https://example.com/deepseek");
	expect(tavily.provider).toBe("tavily");
	expect(tavily.results[0].url).toBe("https://example.com/tavily");
	expect(tavily.cached).not.toBe(true);
	expect(calls).toEqual(["api.deepseek.com", "api.tavily.com"]);
});
