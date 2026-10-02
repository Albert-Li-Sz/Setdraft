import { createHash, randomUUID } from "node:crypto";
import type {
	SearchDiagnosticReport,
	SearchDiagnostics,
	SearchHealth,
	SearchResult,
	SearchSnapshot,
} from "@setdraft/contracts";
import { ChatError } from "./chat-error.ts";
import type { IdentityStore } from "./identity.ts";
import { NOOP_OBSERVABILITY, type Observability, secondsSince } from "./observability.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

interface Configuration {
	enabled: boolean;
	provider: "searxng" | "tavily";
	apiKey?: string;
	dailyLimit: number;
}
export type SearchConfiguration = Omit<Configuration, "apiKey"> & {
	apiKeyConfigured: boolean;
	available: boolean;
	health?: SearchDiagnostics;
};
interface SearchOptions {
	bypassCache?: boolean;
	engine?: string;
	language?: "zh" | "en";
}
export class SearchFailure extends ChatError {
	readonly diagnostics: SearchDiagnostics;
	constructor(message: string, diagnostics: SearchDiagnostics, statusCode = 502) {
		super(message, statusCode);
		this.diagnostics = diagnostics;
	}
}
async function boundedJson(response: Response): Promise<unknown> {
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
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const engineName = (value: unknown): string | undefined =>
	typeof value === "string" && /^[a-zA-Z0-9 _.-]{1,64}$/u.test(value) ? value : undefined;
function engineFailures(raw: Record<string, unknown>): SearchDiagnostics["engines"] {
	if (!Array.isArray(raw.unresponsive_engines)) return [];
	return raw.unresponsive_engines.slice(0, 32).flatMap((entry: unknown) => {
		if (!Array.isArray(entry)) return [];
		const name = engineName(entry[0]);
		if (!name) return [];
		const reason = typeof entry[1] === "string" ? entry[1].toLowerCase() : "";
		const category = reason.includes("timeout")
			? "timeout"
			: reason.includes("captcha") || reason.includes("验证")
				? "captcha"
				: /http|403|429|500|502|503/u.test(reason)
					? "http"
					: /network|connection|connect/u.test(reason)
						? "network"
						: "other";
		return [{ name, category }];
	});
}
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
	private readonly observability: Observability;
	private lastDiagnostics?: SearchDiagnostics;
	constructor(
		identity: IdentityStore,
		request: typeof fetch = fetch,
		observability: Observability = NOOP_OBSERVABILITY,
	) {
		this.identity = identity;
		this.request = request;
		this.observability = observability;
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
			health: this.lastDiagnostics,
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
		this.lastDiagnostics = undefined;
		return this.status();
	}
	/** Fixed public probes; report contains no query, result text, URL, key or upstream error. */
	async diagnose(
		database: WorkspaceDatabase,
		userId: string,
		language: "zh" | "en",
		signal?: AbortSignal,
	): Promise<SearchDiagnosticReport> {
		const config = await this.configuration();
		const query = language === "zh" ? "Python 官方文档" : "Python official documentation";
		const probe = async (engine?: string): Promise<SearchDiagnostics> => {
			const id = randomUUID();
			try {
				const result = await this.search(database, userId, id, query, signal, {
					bypassCache: true,
					engine,
					language,
				});
				return result.diagnostics!;
			} catch (error) {
				if (error instanceof SearchFailure) return error.diagnostics;
				throw error;
			} finally {
				await database.delete("search-cache", `request:${id}`);
			}
		};
		const aggregate = await probe();
		const engines: SearchDiagnosticReport["engines"] = [];
		if (
			config.provider === "searxng" &&
			!["configuration", "network", "timeout", "http", "invalid-response"].includes(aggregate.status)
		) {
			const endpoint = new URL("config", `${process.env.SETDRAFT_SEARCH_URL?.replace(/\/$/u, "")}/`);
			const deadline = AbortSignal.timeout(5000);
			try {
				const response = await this.request(endpoint, {
					signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
					redirect: "error",
					headers: { accept: "application/json", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" },
				});
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error("Config unavailable");
				}
				const raw = await boundedJson(response);
				const entries =
					raw && typeof raw === "object" && "engines" in raw && Array.isArray(raw.engines) ? raw.engines : [];
				const names = [
					...new Set(
						entries.flatMap((entry: unknown) => {
							if (!entry || typeof entry !== "object") return [];
							const value = entry as Record<string, unknown>;
							const name = engineName(value.name);
							return name &&
								value.enabled !== false &&
								value.disabled !== true &&
								Array.isArray(value.categories) &&
								value.categories.includes("general")
								? [name]
								: [];
						}),
					),
				].slice(0, 8);
				for (let i = 0; i < names.length; i += 4) {
					engines.push(
						...(await Promise.all(
							names.slice(i, i + 4).map(async (name) => ({ name, diagnostics: await probe(name) })),
						)),
					);
				}
			} catch (error) {
				signal?.throwIfAborted();
				if (error instanceof ChatError) throw error;
				// Aggregate remains useful when the provider does not expose its engine catalog.
			}
		}
		this.lastDiagnostics = aggregate;
		return { provider: config.provider, language, aggregate, engines };
	}
	async search(
		database: WorkspaceDatabase,
		userId: string,
		requestId: string,
		query: string,
		signal?: AbortSignal,
		options: SearchOptions = {},
	): Promise<SearchSnapshot> {
		return this.observability.startSpan({ name: "search.request" }, async (span) => {
			const start = performance.now();
			let result = "error";
			try {
				const snapshot = await this.searchImpl(database, userId, requestId, query, signal, options);
				result = "ok";
				return snapshot;
			} finally {
				if (signal?.aborted) result = "cancelled";
				span.setAttributes({ "operation.result": result });
				this.observability.metric("setdraft.search.duration", secondsSince(start), { "operation.result": result });
			}
		});
	}
	private async searchImpl(
		database: WorkspaceDatabase,
		userId: string,
		requestId: string,
		query: string,
		signal?: AbortSignal,
		options: SearchOptions = {},
	): Promise<SearchSnapshot> {
		const started = performance.now();
		signal?.throwIfAborted();
		const diagnostics = (
			status: SearchHealth,
			candidateCount = 0,
			acceptedCount = 0,
			engines: SearchDiagnostics["engines"] = [],
			httpStatus?: number,
		): SearchDiagnostics => {
			const value = {
				status,
				checkedAt: new Date().toISOString(),
				durationMs: Math.round(performance.now() - started),
				candidateCount,
				acceptedCount,
				engines,
				httpStatus,
			};
			this.lastDiagnostics = value;
			return value;
		};
		const configuration = await this.configuration();
		const prior = await database.get<SearchSnapshot>("search-cache", `request:${requestId}`);
		if (prior && !options.bypassCache) return { ...prior, cached: true };
		if (!configuration.enabled) throw new SearchFailure("管理员已关闭联网搜索。", diagnostics("configuration"), 503);
		if (configuration.provider === "searxng" ? !process.env.SETDRAFT_SEARCH_URL : !configuration.apiKey)
			throw new SearchFailure("联网搜索尚未配置；本次回复未使用网络资料。", diagnostics("configuration"), 503);
		const normalized = plain(query, 500);
		if (!normalized) throw new ChatError("请输入搜索关键词。", 422);
		const key = createHash("sha256")
			.update(`${configuration.provider}:${options.engine ?? ""}:${options.language ?? ""}:${normalized}`)
			.digest("hex");
		const cached = await database.get<Cache>("search-cache", key);
		if (cached && cached.expiresAt > Date.now() && !options.bypassCache) {
			await database.put("search-cache", `request:${requestId}`, cached.snapshot);
			return { ...cached.snapshot, cached: true };
		}
		const day = new Date().toISOString().slice(0, 10);
		signal?.throwIfAborted();
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
		let received = false;
		try {
			const url =
				configuration.provider === "searxng"
					? new URL("search", `${process.env.SETDRAFT_SEARCH_URL?.replace(/\/$/u, "")}/`)
					: new URL("https://api.tavily.com/search");
			if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
				throw new SearchFailure("搜索地址配置无效；本次回复未使用网络资料。", diagnostics("configuration"), 503);
			const init: RequestInit = { signal: cancellation, redirect: "error", headers: { accept: "application/json" } };
			if (configuration.provider === "searxng") {
				init.headers = { accept: "application/json", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };
				url.searchParams.set("q", normalized);
				url.searchParams.set("format", "json");
				if (!options.engine) url.searchParams.set("categories", "general");
				if (options.engine) url.searchParams.set("engines", options.engine);
				if (options.language) url.searchParams.set("language", options.language === "zh" ? "zh-CN" : "en");
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
			received = true;
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				if (response.status === 403 || response.status === 429)
					throw new SearchFailure(
						"搜索服务拒绝请求，请管理员检查接口权限或限流配置；本次回复未使用网络资料。",
						diagnostics("http", 0, 0, [], response.status),
					);
				throw new SearchFailure(
					"联网搜索暂时不可用，本次回复未使用网络资料。",
					diagnostics("http", 0, 0, [], response.status),
				);
			}
			const raw = await boundedJson(response);
			if (!raw || typeof raw !== "object" || !("results" in raw) || !Array.isArray(raw.results))
				throw new SearchFailure("搜索服务返回格式无效；本次回复未使用网络资料。", diagnostics("invalid-response"));
			const candidates = raw.results;
			const failures = engineFailures(raw as Record<string, unknown>);
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
			if (!results.length) {
				if (candidates.length)
					throw new SearchFailure(
						"搜索返回的候选资料均未通过来源过滤；本次回复未使用网络资料。",
						diagnostics("filtered-empty", candidates.length, 0, failures),
					);
				if (failures.length)
					throw new SearchFailure(
						"上游搜索引擎暂时无可用结果，可能超时或触发验证；请管理员检查搜索出站网络、代理和引擎配置。本次回复未使用网络资料。",
						diagnostics("engines-unavailable", 0, 0, failures),
					);
				throw new SearchFailure(
					"未找到可用的搜索结果，请尝试更换关键词；本次回复未使用网络资料。",
					diagnostics("no-match"),
				);
			}
			const snapshot: SearchSnapshot = {
				query: normalized,
				provider: configuration.provider,
				searchedAt: new Date().toISOString(),
				results,
				diagnostics: diagnostics(
					failures.length ? "partial" : "healthy",
					candidates.length,
					results.length,
					failures,
				),
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
			if (timeout.aborted)
				throw new SearchFailure(
					"联网搜索超时，请管理员检查搜索服务和出站网络；本次回复未使用网络资料。",
					diagnostics("timeout"),
				);
			throw new SearchFailure(
				"联网搜索暂时不可用，本次回复未使用网络资料。",
				diagnostics(received ? "invalid-response" : "network"),
			);
		}
	}
}
