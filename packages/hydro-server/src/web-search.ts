import { createHash } from "node:crypto";
import type { SearchResult, SearchSnapshot } from "@setdraft/contracts";
import { ChatError } from "./chat-error.ts";
import type { IdentityStore } from "./identity.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

interface Configuration {
	enabled: boolean;
	provider: "searxng" | "tavily";
	apiKey?: string;
	dailyLimit: number;
}
export type SearchConfiguration = Omit<Configuration, "apiKey"> & { apiKeyConfigured: boolean; available: boolean };
interface Cache {
	expiresAt: number;
	snapshot: SearchSnapshot;
}
const plain = (value: unknown, limit: number) =>
	typeof value === "string"
		? value
				.replace(/<[^>]*>/gu, "")
				.replace(/[\u0000-\u001f]/gu, " ")
				.trim()
				.slice(0, limit)
		: "";

/** Only a short, user-visible query reaches the provider; never history, attachments or project snapshots. */
export class WebSearch {
	private readonly identity: IdentityStore;
	private readonly request: typeof fetch;
	constructor(identity: IdentityStore, request: typeof fetch = fetch) {
		this.identity = identity;
		this.request = request;
	}
	private async configuration(): Promise<Configuration> {
		return (
			((await this.identity.getSetting("web-search")) as Configuration | undefined) ?? {
				enabled: true,
				provider: "searxng",
				dailyLimit: 100,
			}
		);
	}
	async status(): Promise<SearchConfiguration> {
		const { apiKey, ...value } = await this.configuration();
		return {
			...value,
			apiKeyConfigured: Boolean(apiKey),
			available:
				value.enabled &&
				(value.provider === "searxng" ? Boolean(process.env.SETDRAFT_SEARCH_URL) : Boolean(apiKey)),
		};
	}
	async configure(input: Record<string, unknown>): Promise<SearchConfiguration> {
		const previous = await this.configuration();
		if (
			typeof input.enabled !== "boolean" ||
			!["searxng", "tavily"].includes(String(input.provider)) ||
			!Number.isSafeInteger(input.dailyLimit) ||
			Number(input.dailyLimit) < 1 ||
			Number(input.dailyLimit) > 10000
		)
			throw new ChatError("搜索配置无效。", 422);
		const apiKey =
			input.clearApiKey === true
				? undefined
				: typeof input.apiKey === "string" && input.apiKey.trim()
					? input.apiKey.trim()
					: previous.apiKey;
		if (apiKey && apiKey.length > 1024) throw new ChatError("搜索密钥过长。", 422);
		if (input.provider === "tavily" && input.enabled && !apiKey) throw new ChatError("请填写 Tavily API Key。", 422);
		await this.identity.setSetting("web-search", {
			enabled: input.enabled,
			provider: input.provider,
			apiKey,
			dailyLimit: input.dailyLimit,
		});
		return this.status();
	}
	async search(
		database: WorkspaceDatabase,
		userId: string,
		requestId: string,
		query: string,
		signal?: AbortSignal,
	): Promise<SearchSnapshot> {
		const configuration = await this.configuration();
		const prior = await database.get<SearchSnapshot>("search-cache", `request:${requestId}`);
		if (prior) return prior;
		if (!configuration.enabled) throw new ChatError("管理员已关闭联网搜索。", 503);
		const normalized = plain(query, 500);
		if (!normalized) throw new ChatError("请输入搜索关键词。", 422);
		const key = createHash("sha256").update(`${configuration.provider}:${normalized}`).digest("hex");
		const cached = await database.get<Cache>("search-cache", key);
		if (cached && cached.expiresAt > Date.now()) {
			await database.put("search-cache", `request:${requestId}`, cached.snapshot);
			return cached.snapshot;
		}
		const day = new Date().toISOString().slice(0, 10);
		await this.identity.sql.transaction(async () => {
			await this.identity.sql.execute("DELETE FROM search_usage WHERE day<$1", [day]);
			const usage = await this.identity.sql.one<{ count: number }>(
				"INSERT INTO search_usage(user_id,day,count) VALUES($1,$2,1) ON CONFLICT(user_id,day) DO UPDATE SET count=search_usage.count+1 WHERE search_usage.count<$3 RETURNING count",
				[userId, day, configuration.dailyLimit],
			);
			if (!usage) throw new ChatError("今日联网搜索次数已用完。", 429);
		});
		const timeout = AbortSignal.timeout(12000);
		const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
		let response: Response;
		try {
			const url =
				configuration.provider === "searxng"
					? new URL("search", `${process.env.SETDRAFT_SEARCH_URL?.replace(/\/$/u, "")}/`)
					: new URL("https://api.tavily.com/search");
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new Error("Invalid search endpoint");
			const init: RequestInit = { signal: cancellation, redirect: "error", headers: { accept: "application/json" } };
			if (configuration.provider === "searxng") {
				url.searchParams.set("q", normalized);
				url.searchParams.set("format", "json");
				url.searchParams.set("categories", "general");
			} else {
				init.method = "POST";
				init.headers = { "content-type": "application/json", accept: "application/json" };
				init.body = JSON.stringify({
					api_key: configuration.apiKey,
					query: normalized,
					search_depth: "basic",
					max_results: 5,
					include_answer: false,
					include_raw_content: false,
				});
			}
			response = await this.request(url, init);
			if (!response.ok) throw new Error("Search provider unavailable");
			// Bound provider responses before parsing, including chunked bodies.
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Empty response");
			let length = 0;
			const chunks: Uint8Array[] = [];
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					length += value.byteLength;
					if (length > 1_000_000) throw new Error("Search response too large");
					chunks.push(value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const candidates =
				raw && typeof raw === "object" && "results" in raw && Array.isArray(raw.results) ? raw.results : [];
			const results: SearchResult[] = [];
			const seen = new Set<string>();
			for (const candidate of candidates) {
				if (!candidate || typeof candidate !== "object") continue;
				const item = candidate as Record<string, unknown>;
				if (typeof item.url !== "string") continue;
				let link: URL;
				try {
					link = new URL(item.url);
				} catch {
					continue;
				}
				if (!["https:", "http:"].includes(link.protocol) || link.username || link.password || seen.has(link.href))
					continue;
				const title = plain(item.title, 200),
					snippet = plain(item.content ?? item.snippet, 1200);
				if (!title || !snippet) continue;
				seen.add(link.href);
				results.push({ id: results.length + 1, title, url: link.href, snippet });
				if (results.length === 5) break;
			}
			if (!results.length) throw new Error("No results");
			const snapshot: SearchSnapshot = {
				query: normalized,
				provider: configuration.provider,
				searchedAt: new Date().toISOString(),
				results,
			};
			await database.transaction(async () => {
				await database.sql.execute(
					"DELETE FROM documents WHERE kind='search-cache' AND id NOT LIKE 'request:%' AND (body->>'expiresAt')::double precision<$1",
					[Date.now()],
				);
				await database.put("search-cache", key, { expiresAt: Date.now() + 900000, snapshot });
				await database.put("search-cache", `request:${requestId}`, snapshot);
			});
			return snapshot;
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (error instanceof ChatError) throw error;
			throw new ChatError("联网搜索暂时不可用，本次回复未使用网络资料。", 502);
		}
	}
}
