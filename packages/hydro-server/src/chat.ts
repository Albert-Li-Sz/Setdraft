import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Api, Context, ImageContent, Message, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";

type ChatProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface ChatImage {
	id: string;
	name: string;
	mimeType: string;
	bytes: number;
}

export interface ChatImageUpload {
	name: string;
	mimeType: string;
	data: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	images?: ChatImage[];
	createdAt: string;
	contextSnapshot?: string;
	profileId?: string;
	modelId?: string;
	api?: ChatProtocol;
}

export interface ChatConversation {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	profileId?: string;
	messages: ChatMessage[];
}

interface StoredConfiguration {
	id: string;
	name: string;
	provider: ChatProtocol;
	modelId: string;
	apiKey: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
}

interface StoredCatalog {
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

export interface ChatModelRequest {
	configuration: StoredConfiguration;
	context: Context;
	signal?: AbortSignal;
	onDelta(delta: string): void;
}

export interface ChatSendEvents {
	onStart(chat: ChatConversation): void;
	onDelta(delta: string): void;
}

export type ChatModelClient = (request: ChatModelRequest) => Promise<string>;

const protocols = [
	{ id: "openai-completions", name: "OpenAI Chat Completions", baseUrl: "https://api.openai.com/v1" },
	{ id: "openai-responses", name: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
	{ id: "anthropic-messages", name: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
] as const;

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const maxImagesPerMessage = 4;
const maxImageBytes = 5 * 1024 * 1024;
const maxMessageImageBytes = 12 * 1024 * 1024;
const imageContextCharacters = 6000;
const imageMimeTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function decodeImages(images: ChatImageUpload[]): Array<{ image: ChatImage; bytes: Buffer }> {
	if (images.length > maxImagesPerMessage) throw new ChatError("每条消息最多添加 4 张图片。", 413);
	let total = 0;
	return images.map((item) => {
		if (!imageMimeTypes.includes(item.mimeType)) throw new ChatError("图片只支持 PNG、JPEG、WebP 或 GIF。", 422);
		if (!item.name.trim() || item.name.length > 120) throw new ChatError("图片文件名须为 1–120 个字符。", 422);
		if (!item.data || item.data.length > Math.ceil(maxImageBytes / 3) * 4 + 4) {
			throw new ChatError("单张图片不能超过 5 MiB。", 413);
		}
		const bytes = Buffer.from(item.data, "base64");
		if (bytes.length === 0 || bytes.toString("base64") !== item.data) throw new ChatError("图片编码无效。", 422);
		if (bytes.length > maxImageBytes) throw new ChatError("单张图片不能超过 5 MiB。", 413);
		const valid =
			(item.mimeType === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
			(item.mimeType === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
			(item.mimeType === "image/webp" &&
				bytes.toString("ascii", 0, 4) === "RIFF" &&
				bytes.toString("ascii", 8, 12) === "WEBP") ||
			(item.mimeType === "image/gif" && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)));
		if (!valid) throw new ChatError("图片内容与所选格式不符。", 422);
		total += bytes.length;
		if (total > maxMessageImageBytes) throw new ChatError("每条消息的图片合计不能超过 12 MiB。", 413);
		return {
			image: { id: randomUUID(), name: item.name.trim(), mimeType: item.mimeType, bytes: bytes.length },
			bytes,
		};
	});
}

export class ChatError extends Error {
	readonly statusCode: number;
	constructor(message: string, statusCode = 400) {
		super(message);
		this.name = "ChatError";
		this.statusCode = statusCode;
	}
}

async function defaultClient(request: ChatModelRequest): Promise<string> {
	const configuration = request.configuration;
	const protocol = protocols.find((item) => item.id === configuration.provider);
	if (!protocol) throw new ChatError("AI 协议无效。", 422);
	const model: Model<Api> = {
		id: configuration.modelId,
		name: configuration.modelId,
		provider: "hydro-chat",
		api: configuration.provider,
		baseUrl: configuration.baseUrl ?? protocol.baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: configuration.contextWindow,
		maxTokens: configuration.maxTokens,
		...(configuration.provider === "openai-completions"
			? {
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsStrictMode: false,
						maxTokensField: "max_tokens" as const,
					},
				}
			: configuration.provider === "openai-responses"
				? { compat: { supportsMaxOutputTokens: true, supportsStrictMode: false } }
				: {}),
	};
	const stream = streamSimple(model, request.context, {
		apiKey: configuration.apiKey,
		maxTokens: configuration.maxTokens,
		signal: request.signal,
	});
	let output = "";
	for await (const event of stream) {
		if (event.type === "text_delta") {
			output += event.delta;
			request.onDelta(event.delta);
		}
		if (event.type === "error") throw new ChatError(event.error.errorMessage ?? "AI 请求失败。", 502);
	}
	const final = await stream.result();
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		throw new ChatError(final.errorMessage ?? "AI 请求失败。", 502);
	}
	if (!output)
		output = final.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("");
	return output;
}

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

export class ChatService {
	private readonly root: string;
	private readonly configPath: string;
	private readonly client: ChatModelClient;
	private catalog: StoredCatalog = { version: 2, profiles: [] };
	private configurationError?: string;
	private readonly busy = new Set<string>();

	constructor(options: { root: string; configPath: string; client?: ChatModelClient }) {
		this.root = resolve(options.root);
		this.configPath = resolve(options.configPath);
		this.client = options.client ?? defaultClient;
	}

	async loadConfiguration(): Promise<void> {
		try {
			this.catalog = readStoredCatalog(JSON.parse(await readFile(this.configPath, "utf8")) as unknown);
			this.configurationError = undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			this.catalog = { version: 2, profiles: [] };
			this.configurationError = error instanceof Error ? error.message : "AI 配置读取失败。";
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
		await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
		const temporary = `${this.configPath}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, this.configPath);
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
		if (profiles.length === 0) return this.clearConfiguration();
		await this.saveCatalog({
			version: 2,
			profiles,
			defaultProfileId: this.catalog.defaultProfileId === id ? profiles[0].id : this.catalog.defaultProfileId,
		});
		return this.getConfiguration();
	}

	async clearConfiguration(): Promise<ChatConfigurationSnapshot> {
		await unlink(this.configPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
		this.catalog = { version: 2, profiles: [] };
		this.configurationError = undefined;
		return this.getConfiguration();
	}

	private chatPath(id: string): string {
		if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("对话不存在。", 404);
		return join(this.root, "chats", `${id}.json`);
	}

	private imagePath(chatId: string, imageId: string): string {
		if (!/^[a-f0-9-]{36}$/u.test(imageId)) throw new ChatError("图片不存在。", 404);
		return join(this.root, "chats", chatId, imageId);
	}

	private async save(chat: ChatConversation): Promise<void> {
		const path = this.chatPath(chat.id);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(chat, null, 2)}\n`);
		await rename(temporary, path);
	}

	async get(id: string): Promise<ChatConversation> {
		try {
			return JSON.parse(await readFile(this.chatPath(id), "utf8")) as ChatConversation;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ChatError("对话不存在。", 404);
			throw error;
		}
	}

	async list(): Promise<Array<Pick<ChatConversation, "id" | "title" | "createdAt" | "updatedAt">>> {
		let names: string[];
		try {
			names = await readdir(join(this.root, "chats"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const chats = await Promise.all(
			names.filter((name) => /^[a-f0-9-]{36}\.json$/u.test(name)).map((name) => this.get(name.slice(0, -5))),
		);
		return chats
			.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async create(): Promise<ChatConversation> {
		const now = new Date().toISOString();
		const chat: ChatConversation = {
			id: randomUUID(),
			title: "新对话",
			createdAt: now,
			updatedAt: now,
			messages: [],
		};
		await this.save(chat);
		return chat;
	}

	async delete(id: string): Promise<void> {
		if (this.busy.has(id)) throw new ChatError("对话正在生成，请稍后删除。", 409);
		await this.get(id);
		await rm(this.chatPath(id));
		await rm(join(this.root, "chats", id), { recursive: true, force: true });
	}

	async image(chatId: string, imageId: string): Promise<{ path: string; mimeType: string }> {
		const chat = await this.get(chatId);
		const image = chat.messages.flatMap((item) => item.images ?? []).find((item) => item.id === imageId);
		if (!image) throw new ChatError("图片不存在。", 404);
		return { path: this.imagePath(chatId, imageId), mimeType: image.mimeType };
	}

	async send(
		id: string,
		message: string,
		contextSnapshot: string | undefined,
		events: ChatSendEvents,
		signal?: AbortSignal,
		profileId?: string,
		images: ChatImageUpload[] = [],
	): Promise<ChatConversation> {
		if (this.catalog.profiles.length === 0) throw new ChatError("请先在设置中配置 AI API。", 503);
		if (this.busy.has(id)) throw new ChatError("上一条消息仍在生成。", 409);
		if ((!message.trim() && images.length === 0) || message.length > 40_000) {
			throw new ChatError("请填写消息或添加图片；文字最多 40000 个字符。");
		}
		if (contextSnapshot && contextSnapshot.length > 80_000) throw new ChatError("附带的题目上下文过长。");
		const decodedImages = decodeImages(images);
		this.busy.add(id);
		try {
			const chat = await this.get(id);
			const selectedProfileId = profileId ?? chat.profileId ?? this.catalog.defaultProfileId;
			const configuration = this.catalog.profiles.find((item) => item.id === selectedProfileId);
			if (!configuration) throw new ChatError("当前对话使用的 AI 配置不存在，请重新选择。", 422);
			const maxInputCharacters = Math.max(1000, (configuration.contextWindow - configuration.maxTokens) * 3);
			if (
				message.trim().length + (contextSnapshot?.length ?? 0) + images.length * imageContextCharacters >
				maxInputCharacters
			) {
				throw new ChatError("本次文字、图片和题目快照超过模型输入预算，请缩短内容或调大上下文长度。", 422);
			}
			const now = new Date().toISOString();
			const user: ChatMessage = {
				id: randomUUID(),
				role: "user",
				content: message.trim(),
				images: decodedImages.length ? decodedImages.map((item) => item.image) : undefined,
				createdAt: now,
				contextSnapshot: contextSnapshot?.trim() || undefined,
			};
			chat.messages.push(user);
			if (chat.messages.length === 1)
				chat.title = (message.trim() || `图片：${decodedImages[0]?.image.name}`).slice(0, 60);
			chat.profileId = configuration.id;
			chat.updatedAt = now;
			const createdPaths: string[] = [];
			try {
				if (decodedImages.length) await mkdir(join(this.root, "chats", id), { recursive: true });
				for (const item of decodedImages) {
					const path = this.imagePath(id, item.image.id);
					await writeFile(path, item.bytes, { flag: "wx" });
					createdPaths.push(path);
				}
				await this.save(chat);
			} catch (error) {
				await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
				throw error;
			}
			events.onStart({ ...chat, messages: [...chat.messages] });
			const selected: ChatMessage[] = [];
			let characters = 0;
			for (const item of [...chat.messages].reverse()) {
				const size =
					item.content.length +
					(item.contextSnapshot?.length ?? 0) +
					(item.images?.length ?? 0) * imageContextCharacters;
				if (selected.length > 0 && characters + size > maxInputCharacters) break;
				selected.unshift(item);
				characters += size;
			}
			while (selected[0]?.role === "assistant") selected.shift();
			const messages: Message[] = await Promise.all(
				selected.map(async (item): Promise<Message> => {
					if (item.role === "user") {
						const text = item.contextSnapshot
							? `${item.content}\n\n[当前题目只读快照]\n${item.contextSnapshot}`
							: item.content;
						const content: string | (TextContent | ImageContent)[] = item.images?.length
							? [
									...(text ? [{ type: "text" as const, text }] : []),
									...(await Promise.all(
										item.images.map(
											async (image): Promise<ImageContent> => ({
												type: "image",
												mimeType: image.mimeType,
												data: (await readFile(this.imagePath(id, image.id))).toString("base64"),
											}),
										),
									)),
								]
							: text;
						return { role: "user", content, timestamp: Date.parse(item.createdAt) };
					}
					return {
						role: "assistant",
						content: [{ type: "text", text: item.content }],
						api: item.api ?? configuration.provider,
						provider: "hydro-chat",
						model: item.modelId ?? configuration.modelId,
						usage: emptyUsage,
						stopReason: "stop",
						timestamp: Date.parse(item.createdAt),
					};
				}),
			);
			const context: Context = {
				systemPrompt: "你是 Hydro 制题助手。回答用户问题；你没有工具权限，不能修改题目草稿、运行代码或声称已验证。",
				messages,
			};
			const answer = await this.client({ configuration, context, signal, onDelta: events.onDelta });
			if (signal?.aborted) throw new ChatError("对话已取消。", 499);
			chat.messages.push({
				id: randomUUID(),
				role: "assistant",
				content: answer,
				createdAt: new Date().toISOString(),
				profileId: configuration.id,
				modelId: configuration.modelId,
				api: configuration.provider,
			});
			chat.updatedAt = new Date().toISOString();
			await this.save(chat);
			return chat;
		} finally {
			this.busy.delete(id);
		}
	}
}
