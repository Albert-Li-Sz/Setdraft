import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ChatProtocol } from "@setdraft/contracts";
import { ChatError } from "./chat-error.ts";

export interface StoredConfiguration {
	id: string;
	name: string;
	provider: ChatProtocol;
	modelId: string;
	apiKey: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
}

export interface StoredCatalog {
	version: 2;
	defaultProfileId?: string;
	profiles: StoredConfiguration[];
}

export type ChatProfileSnapshot = Omit<StoredConfiguration, "apiKey"> & { apiKeyConfigured: boolean };

export interface ChatConfigurationSnapshot {
	configured: boolean;
	defaultProfileId?: string;
	profiles: ChatProfileSnapshot[];
	providers: Array<{ id: string; name: string; models: never[] }>;
	error?: string;
}

export const protocols = [
	{ id: "openai-completions", name: "OpenAI Chat Completions", baseUrl: "https://api.openai.com/v1" },
	{ id: "openai-responses", name: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
	{ id: "anthropic-messages", name: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
] as const;

function readConfiguration(value: unknown, id: string, previous?: StoredConfiguration): StoredConfiguration {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChatError("AI 配置无效。");
	const record = value as Record<string, unknown>;
	if (!protocols.some((item) => item.id === record.provider)) throw new ChatError("请选择支持的 AI 协议。");
	if (typeof record.modelId !== "string" || !record.modelId.trim()) throw new ChatError("请填写模型名称。");
	const name = record.name ?? previous?.name ?? `${record.provider}/${record.modelId}`;
	if (typeof name !== "string" || !name.trim() || name.length > 80) {
		throw new ChatError("配置名称须为 1–80 个字符。");
	}
	const apiKey = typeof record.apiKey === "string" && record.apiKey.trim() ? record.apiKey.trim() : previous?.apiKey;
	if (!apiKey) throw new ChatError("请填写 API Key。");
	let baseUrl: string | undefined;
	if (record.baseUrl !== undefined && record.baseUrl !== "") {
		if (typeof record.baseUrl !== "string") throw new ChatError("Base URL 必须是文本。");
		let url: URL;
		try {
			url = new URL(record.baseUrl);
		} catch {
			throw new ChatError("Base URL 必须是完整地址。");
		}
		if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
			throw new ChatError("Base URL 只支持不含凭据、查询和锚点的 http(s) 地址。");
		}
		baseUrl = url.toString().replace(/\/$/u, "");
	}
	const contextWindow = record.contextWindow ?? 128_000;
	const maxTokens = record.maxTokens ?? 16_384;
	if (!Number.isSafeInteger(contextWindow) || Number(contextWindow) < 1024 || Number(contextWindow) > 4_000_000) {
		throw new ChatError("上下文长度须为 1024–4000000。", 422);
	}
	if (
		!Number.isSafeInteger(maxTokens) ||
		Number(maxTokens) < 1 ||
		Number(maxTokens) > 1_000_000 ||
		Number(maxTokens) > Number(contextWindow)
	) {
		throw new ChatError("最大输出长度须为 1–1000000，且不能超过上下文长度。", 422);
	}
	return {
		id,
		name: name.trim(),
		provider: record.provider as ChatProtocol,
		modelId: record.modelId.trim(),
		apiKey,
		baseUrl,
		contextWindow: Number(contextWindow),
		maxTokens: Number(maxTokens),
	};
}

function readStoredCatalog(value: unknown): StoredCatalog {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChatError("AI 配置文件无效。");
	const record = value as Record<string, unknown>;
	if (record.version !== 2) {
		return {
			version: 2,
			defaultProfileId: "legacy",
			profiles: [readConfiguration({ ...record, name: "现有配置" }, "legacy")],
		};
	}
	if (!Array.isArray(record.profiles) || record.profiles.length > 30) throw new ChatError("AI 配置列表无效。");
	const profiles = record.profiles.map((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChatError("AI 配置项无效。");
		const item = value as Record<string, unknown>;
		if (typeof item.id !== "string" || !/^(?:[a-f0-9-]{36}|legacy)$/u.test(item.id)) {
			throw new ChatError("AI 配置 ID 无效。");
		}
		return readConfiguration(item, item.id);
	});
	if (new Set(profiles.map((item) => item.id)).size !== profiles.length) throw new ChatError("AI 配置 ID 重复。");
	const defaultProfileId = record.defaultProfileId ?? profiles[0]?.id;
	if (defaultProfileId !== undefined && !profiles.some((item) => item.id === defaultProfileId)) {
		throw new ChatError("默认 AI 配置不存在。");
	}
	return { version: 2, defaultProfileId: defaultProfileId as string | undefined, profiles };
}

export class AiConfigurationStore {
	catalog: StoredCatalog = { version: 2, profiles: [] };
	private configurationError?: string;
	private readonly storage: { read(): unknown; write(value: StoredCatalog): Promise<void> | void };
	private readonly configPath: string;
	constructor(storage: { read(): unknown; write(value: StoredCatalog): Promise<void> | void }, configPath: string) {
		this.storage = storage;
		this.configPath = configPath;
	}
	async load(): Promise<void> {
		try {
			const stored = await this.storage.read();
			if (stored !== undefined) this.catalog = readStoredCatalog(stored);
			else {
				try {
					this.catalog = readStoredCatalog(JSON.parse(await readFile(this.configPath, "utf8")));
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				await this.storage.write(this.catalog);
			}
			this.configurationError = undefined;
		} catch {
			this.catalog = { version: 2, profiles: [] };
			this.configurationError = "AI 配置读取失败。";
		}
	}
	getConfiguration(): ChatConfigurationSnapshot {
		return {
			configured: this.catalog.profiles.length > 0,
			defaultProfileId: this.catalog.defaultProfileId,
			profiles: this.catalog.profiles.map(({ apiKey, ...profile }) => ({
				...profile,
				apiKeyConfigured: Boolean(apiKey),
			})),
			providers: protocols.map((item) => ({ id: item.id, name: item.name, models: [] })),
			error: this.configurationError,
		};
	}
	private async saveCatalog(catalog: StoredCatalog): Promise<void> {
		await this.storage.write(catalog);
		this.catalog = catalog;
		this.configurationError = undefined;
	}
	async configure(value: unknown): Promise<ChatConfigurationSnapshot> {
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChatError("AI 配置无效。");
		const candidate = value as Record<string, unknown>;
		if (candidate.id !== undefined && typeof candidate.id !== "string") throw new ChatError("AI 配置 ID 无效。");
		const previous = this.catalog.profiles.find((item) => item.id === candidate.id);
		if (candidate.id && !previous) throw new ChatError("AI 配置不存在。", 404);
		if (!previous && this.catalog.profiles.length >= 30) throw new ChatError("AI 配置最多保存 30 套。", 422);
		const configuration = readConfiguration(candidate, previous?.id ?? randomUUID(), previous);
		if (
			this.catalog.profiles.some(
				(item) => item.id !== configuration.id && item.name.toLowerCase() === configuration.name.toLowerCase(),
			)
		) {
			throw new ChatError("已有同名 AI 配置，请使用不同名称。", 409);
		}
		const profiles = previous
			? this.catalog.profiles.map((item) => (item.id === previous.id ? configuration : item))
			: [...this.catalog.profiles, configuration];
		await this.saveCatalog({
			version: 2,
			profiles,
			defaultProfileId: this.catalog.defaultProfileId ?? configuration.id,
		});
		return this.getConfiguration();
	}

	async setDefaultProfile(id: string): Promise<ChatConfigurationSnapshot> {
		if (!this.catalog.profiles.some((item) => item.id === id)) throw new ChatError("AI 配置不存在。", 404);
		await this.saveCatalog({ ...this.catalog, defaultProfileId: id });
		return this.getConfiguration();
	}

	async removeProfile(id: string): Promise<ChatConfigurationSnapshot> {
		if (!this.catalog.profiles.some((item) => item.id === id)) throw new ChatError("AI 配置不存在。", 404);
		const profiles = this.catalog.profiles.filter((item) => item.id !== id);
		if (profiles.length === 0) return await this.clearConfiguration();
		await this.saveCatalog({
			version: 2,
			profiles,
			defaultProfileId: this.catalog.defaultProfileId === id ? profiles[0].id : this.catalog.defaultProfileId,
		});
		return this.getConfiguration();
	}

	async clearConfiguration(): Promise<ChatConfigurationSnapshot> {
		this.catalog = { version: 2, profiles: [] };
		await this.storage.write(this.catalog);
		this.configurationError = undefined;
		return this.getConfiguration();
	}
}
