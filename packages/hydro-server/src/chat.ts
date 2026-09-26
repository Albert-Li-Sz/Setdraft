import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Api, Context, ImageContent, Message, Model, TextContent, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type {
	ChatConversation,
	ChatImage,
	ChatImageUpload,
	ChatMessage,
	ChatProtocol,
} from "@hydro-problem-make/contracts";
import { WorkspaceDatabase } from "./workspace-db.ts";

export type { ChatConversation, ChatImage, ChatImageUpload, ChatMessage } from "@hydro-problem-make/contracts";

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

export type ChatModelClient = (request: ChatModelRequest) => Promise<string | { text: string; usage?: Usage }>;

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

async function defaultClient(request: ChatModelRequest): Promise<{ text: string; usage?: Usage }> {
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
	return { text: output, usage: final.usage };
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
	private readonly database: WorkspaceDatabase;
	private readonly configPath: string;
	private readonly client: ChatModelClient;
	private catalog: StoredCatalog = { version: 2, profiles: [] };
	private configurationError?: string;
	private readonly busy = new Set<string>();
	private readonly documentVersions = new WeakMap<ChatConversation, number>();

	constructor(options: { root: string; configPath: string; client?: ChatModelClient; database?: WorkspaceDatabase }) {
		this.root = resolve(options.root);
		this.database = options.database ?? new WorkspaceDatabase(this.root);
		if (this.database.root !== this.root) throw new Error("Workspace database root must match the chat root.");
		this.configPath = resolve(options.configPath);
		this.client = options.client ?? defaultClient;
	}

	async loadConfiguration(): Promise<void> {
		try {
			this.catalog = readStoredCatalog(
				this.database.get<StoredCatalog>("ai-config", "default") ??
					(JSON.parse(await readFile(this.configPath, "utf8")) as unknown),
			);
			if (!this.database.migrationError) this.database.put("ai-config", "default", this.catalog);
			this.configurationError = this.database.migrationError;
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

	async testProfile(id: string): Promise<{ connected: boolean; modelId: string; usage?: Usage; reply: string }> {
		const configuration = this.catalog.profiles.find((item) => item.id === id);
		if (!configuration) throw new ChatError("AI 配置不存在。", 404);
		const signal = AbortSignal.timeout(15_000);
		const response = await this.client({
			configuration,
			context: {
				systemPrompt: "Reply with OK.",
				messages: [{ role: "user", content: "OK", timestamp: Date.now() }],
			},
			signal,
			onDelta: () => {},
		});
		return {
			connected: true,
			modelId: configuration.modelId,
			reply: typeof response === "string" ? response : response.text,
			usage: typeof response === "string" ? undefined : response.usage,
		};
	}

	private async saveCatalog(catalog: StoredCatalog): Promise<void> {
		this.assertWritable();
		this.database.put("ai-config", "default", catalog);
		this.catalog = catalog;
		this.configurationError = undefined;
	}

	private assertWritable(): void {
		if (this.database.migrationError) throw new ChatError("旧数据迁移失败，当前只读。", 503);
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
		this.assertWritable();
		this.catalog = { version: 2, profiles: [] };
		this.database.put("ai-config", "default", this.catalog);
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

	private save(chat: ChatConversation): void {
		const version = this.documentVersions.get(chat) ?? -1;
		try {
			this.database.put("chat", chat.id, chat, version);
		} catch (error) {
			if (String(error).includes("VERSION_CONFLICT")) throw new ChatError("对话已变化，请刷新后重试。", 409);
			throw error;
		}
		this.documentVersions.set(chat, version + 1);
	}

	async get(id: string): Promise<ChatConversation> {
		this.chatPath(id);
		const document = this.database.getVersioned<ChatConversation>("chat", id);
		if (!document) throw new ChatError("对话不存在。", 404);
		if (document.version !== undefined) this.documentVersions.set(document.value, document.version);
		return document.value;
	}

	async list(): Promise<Array<Pick<ChatConversation, "id" | "title" | "createdAt" | "updatedAt">>> {
		const chats = this.database.list<ChatConversation>("chat");
		return chats
			.map(({ id, title, createdAt, updatedAt }) => ({ id, title, createdAt, updatedAt }))
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	async create(): Promise<ChatConversation> {
		this.assertWritable();
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
		this.assertWritable();
		if (this.busy.has(id)) throw new ChatError("对话正在生成，请稍后删除。", 409);
		await this.get(id);
		this.database.transaction(() => {
			if (
				this.database.db
					.prepare("SELECT 1 FROM chat_requests WHERE chat_id=? AND state IN ('queued','running')")
					.get(id)
			)
				throw new ChatError("对话正在生成，请稍后删除。", 409);
			const requests = this.database.db.prepare("SELECT id FROM chat_requests WHERE chat_id=?").all(id) as Array<{
				id: string;
			}>;
			for (const request of requests) {
				this.database.removeOwnerFiles("chat-request-image", request.id);
				this.database.db.prepare("DELETE FROM chat_request_events WHERE request_id=?").run(request.id);
			}
			this.database.db.prepare("DELETE FROM chat_requests WHERE chat_id=?").run(id);
			this.database.delete("chat", id);
			this.database.removeOwnerFiles("chat-image", id);
		});
		await rm(join(this.root, "chats", id), { recursive: true, force: true });
		await this.database.pruneBlobs();
	}

	async image(chatId: string, imageId: string): Promise<{ path: string; mimeType: string }> {
		const chat = await this.get(chatId);
		const image = chat.messages.flatMap((item) => item.images ?? []).find((item) => item.id === imageId);
		if (!image) throw new ChatError("图片不存在。", 404);
		return {
			path: this.database.filePath("chat-image", chatId, imageId) ?? this.imagePath(chatId, imageId),
			mimeType: image.mimeType,
		};
	}

	async send(
		id: string,
		message: string,
		contextSnapshot: string | undefined,
		events: ChatSendEvents,
		signal?: AbortSignal,
		profileId?: string,
		images: ChatImageUpload[] = [],
		requestId?: string,
	): Promise<ChatConversation> {
		this.assertWritable();
		if (this.catalog.profiles.length === 0) throw new ChatError("请先在设置中配置 AI API。", 503);
		if (this.busy.has(id)) throw new ChatError("上一条消息仍在生成。", 409);
		if ((!message.trim() && images.length === 0) || message.length > 40_000) {
			throw new ChatError("请填写消息或添加图片；文字最多 40000 个字符。");
		}
		if (contextSnapshot && contextSnapshot.length > 80_000) throw new ChatError("附带的题目上下文过长。");
		if (requestId && !/^[a-f0-9-]{36}$/u.test(requestId)) throw new ChatError("请求 ID 无效。", 422);
		const decodedImages = decodeImages(images);
		this.busy.add(id);
		try {
			const chat = await this.get(id);
			const selectedProfileId = profileId ?? chat.profileId ?? this.catalog.defaultProfileId;
			const configuration = this.catalog.profiles.find((item) => item.id === selectedProfileId);
			if (!configuration) throw new ChatError("当前对话使用的 AI 配置不存在，请重新选择。", 422);
			if (requestId && chat.messages.some((item) => item.role === "assistant" && item.requestId === requestId))
				return chat;
			const previousUser = requestId
				? chat.messages.find((item) => item.role === "user" && item.requestId === requestId)
				: undefined;
			const maxInputCharacters = Math.max(1000, (configuration.contextWindow - configuration.maxTokens) * 3);
			if (
				message.trim().length + (contextSnapshot?.length ?? 0) + images.length * imageContextCharacters >
				maxInputCharacters
			) {
				throw new ChatError("本次文字、图片和题目快照超过模型输入预算，请缩短内容或调大上下文长度。", 422);
			}
			const now = new Date().toISOString();
			const user: ChatMessage = {
				id: requestId ?? randomUUID(),
				requestId,
				role: "user",
				content: message.trim(),
				images: decodedImages.length ? decodedImages.map((item) => item.image) : undefined,
				createdAt: now,
				contextSnapshot: contextSnapshot?.trim() || undefined,
			};
			if (!previousUser) chat.messages.push(user);
			if (chat.messages.length === 1)
				chat.title = (message.trim() || `图片：${decodedImages[0]?.image.name}`).slice(0, 60);
			chat.profileId = configuration.id;
			chat.updatedAt = now;
			await this.database.commitFiles(
				(previousUser ? [] : decodedImages).map((item) => ({
					ownerKind: "chat-image",
					ownerId: id,
					name: item.image.id,
					source: { bytes: item.bytes },
				})),
				() => {
					signal?.throwIfAborted();
					this.save(chat);
				},
			);
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
												data: (
													await readFile(
														this.database.filePath("chat-image", id, image.id) ??
															this.imagePath(id, image.id),
													)
												).toString("base64"),
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
			const reply = await this.client({ configuration, context, signal, onDelta: events.onDelta });
			const answer = typeof reply === "string" ? reply : reply.text;
			if (signal?.aborted) throw new ChatError("对话已取消。", 499);
			chat.messages.push({
				id: randomUUID(),
				role: "assistant",
				content: answer,
				createdAt: new Date().toISOString(),
				profileId: configuration.id,
				modelId: configuration.modelId,
				api: configuration.provider,
				requestId,
				usage: typeof reply === "string" ? undefined : reply.usage,
			});
			chat.updatedAt = new Date().toISOString();
			await this.save(chat);
			return chat;
		} finally {
			this.busy.delete(id);
		}
	}
}
