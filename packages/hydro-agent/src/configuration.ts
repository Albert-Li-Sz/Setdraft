import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type CreateHydroAgentExecutorOptions,
	createHydroAgentExecutor,
	type HydroAgentExecutionInput,
	type HydroAgentExecutionOutcome,
	type HydroAgentExecutor,
	type HydroAgentReadiness,
} from "./executor.ts";

export interface HydroAiModelOption {
	id: string;
	name: string;
}

export interface HydroAiProviderOption {
	id: string;
	name: string;
	models: HydroAiModelOption[];
}

export interface HydroAiConfigurationInput {
	provider: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
}

export interface HydroAiConfigurationSnapshot {
	configured: boolean;
	provider?: string;
	modelId?: string;
	baseUrl?: string;
	contextWindow?: number;
	maxTokens?: number;
	apiKeyConfigured: boolean;
	providers: HydroAiProviderOption[];
	error?: string;
}

export interface HydroAiConfigurationController {
	getSnapshot(): HydroAiConfigurationSnapshot;
	configure(input: HydroAiConfigurationInput): Promise<HydroAiConfigurationSnapshot>;
	clear(): Promise<HydroAiConfigurationSnapshot>;
}

export interface HydroAiConfigurationOptions
	extends Omit<CreateHydroAgentExecutorOptions, "modelRuntime" | "provider" | "modelId"> {
	configPath: string;
	enableAmbientCredentials?: boolean;
	provider?: string;
	modelId?: string;
	modelRuntimeFactory?: () => Promise<ModelRuntime>;
}

interface StoredHydroAiConfiguration {
	provider: string;
	modelId: string;
	apiKey?: string;
	baseUrl?: string;
	contextWindow: number;
	maxTokens: number;
}

interface ActivatedConfiguration {
	configuration: StoredHydroAiConfiguration;
	executor: HydroAgentExecutor;
}

export class HydroAiConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HydroAiConfigurationError";
	}
}

function optionalTrimmedString(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
	const trimmed = optionalTrimmedString(value);
	if (trimmed === undefined) return undefined;
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new HydroAiConfigurationError("Base URL 必须是完整的 http:// 或 https:// 地址。");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new HydroAiConfigurationError("Base URL 只支持 http:// 或 https://。");
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new HydroAiConfigurationError("Base URL 不能包含用户名或密码。");
	}
	if (url.search.length > 0 || url.hash.length > 0) {
		throw new HydroAiConfigurationError("Base URL 不能包含查询参数或锚点。");
	}
	return url.toString().replace(/\/$/u, "");
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MIN_CONTEXT_WINDOW = 1_024;
const MAX_CONTEXT_WINDOW = 4_000_000;
const MIN_MAX_TOKENS = 1;
const MAX_MAX_TOKENS = 1_000_000;

function normalizeTokenLimits(
	contextWindow: number | undefined,
	maxTokens: number | undefined,
): { contextWindow: number; maxTokens: number } {
	const resolvedContextWindow = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const resolvedMaxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
	if (
		!Number.isSafeInteger(resolvedContextWindow) ||
		resolvedContextWindow < MIN_CONTEXT_WINDOW ||
		resolvedContextWindow > MAX_CONTEXT_WINDOW
	) {
		throw new HydroAiConfigurationError(`上下文长度须为 ${MIN_CONTEXT_WINDOW}–${MAX_CONTEXT_WINDOW} 之间的整数。`);
	}
	if (
		!Number.isSafeInteger(resolvedMaxTokens) ||
		resolvedMaxTokens < MIN_MAX_TOKENS ||
		resolvedMaxTokens > MAX_MAX_TOKENS
	) {
		throw new HydroAiConfigurationError(`最大输出长度须为 ${MIN_MAX_TOKENS}–${MAX_MAX_TOKENS} 之间的整数。`);
	}
	if (resolvedMaxTokens > resolvedContextWindow) {
		throw new HydroAiConfigurationError("最大输出长度不能超过上下文长度。");
	}
	return { contextWindow: resolvedContextWindow, maxTokens: resolvedMaxTokens };
}

function readStoredConfiguration(value: unknown): StoredHydroAiConfiguration {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HydroAiConfigurationError("AI 配置文件必须包含一个 JSON 对象。");
	}
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.modelId !== "string") {
		throw new HydroAiConfigurationError("AI 配置文件缺少 provider 或 modelId。");
	}
	if (record.apiKey !== undefined && typeof record.apiKey !== "string") {
		throw new HydroAiConfigurationError("AI 配置文件中的 apiKey 必须是字符串。");
	}
	if (record.baseUrl !== undefined && typeof record.baseUrl !== "string") {
		throw new HydroAiConfigurationError("AI 配置文件中的 baseUrl 必须是字符串。");
	}
	if (record.contextWindow !== undefined && typeof record.contextWindow !== "number") {
		throw new HydroAiConfigurationError("AI 配置文件中的 contextWindow 必须是整数。");
	}
	if (record.maxTokens !== undefined && typeof record.maxTokens !== "number") {
		throw new HydroAiConfigurationError("AI 配置文件中的 maxTokens 必须是整数。");
	}
	return {
		provider: record.provider,
		modelId: record.modelId,
		apiKey: record.apiKey,
		baseUrl: record.baseUrl,
		...normalizeTokenLimits(record.contextWindow, record.maxTokens),
	};
}

const protocols = [
	{ id: "openai-completions", name: "OpenAI Chat Completions", baseUrl: "https://api.openai.com/v1" },
	{ id: "openai-responses", name: "OpenAI Responses", baseUrl: "https://api.openai.com/v1" },
	{ id: "anthropic-messages", name: "Anthropic Messages", baseUrl: "https://api.anthropic.com" },
] as const;

export class HydroAiConfiguration implements HydroAiConfigurationController, HydroAgentExecutor {
	private readonly configPath: string;
	private readonly modelRuntimeFactory: () => Promise<ModelRuntime>;
	private readonly sessionOptions: Omit<CreateHydroAgentExecutorOptions, "modelRuntime" | "provider" | "modelId">;
	private readonly providers: HydroAiProviderOption[];
	private active?: ActivatedConfiguration;
	private configurationError?: string;

	private constructor(options: HydroAiConfigurationOptions, modelRuntimeFactory: () => Promise<ModelRuntime>) {
		this.configPath = options.configPath;
		this.modelRuntimeFactory = modelRuntimeFactory;
		this.sessionOptions = {
			workspaceRoot: options.workspaceRoot,
			agentDir: options.agentDir,
			skillPath: options.skillPath,
			sandbox: options.sandbox,
		};
		this.providers = protocols.map(({ id, name }) => ({ id, name, models: [] }));
	}

	static async create(options: HydroAiConfigurationOptions): Promise<HydroAiConfiguration> {
		const modelRuntimeFactory =
			options.modelRuntimeFactory ?? (() => ModelRuntime.create({ refreshOnCreate: false }));
		const configuration = new HydroAiConfiguration(options, modelRuntimeFactory);
		await configuration.load(options);
		return configuration;
	}

	get readiness(): HydroAgentReadiness {
		if (this.active === undefined) return { available: false, models: [] };
		return {
			available: this.active.executor.readiness.available,
			models: [`${this.active.configuration.provider}/${this.active.configuration.modelId}`],
		};
	}

	getSnapshot(): HydroAiConfigurationSnapshot {
		return {
			configured: this.readiness.available,
			provider: this.active?.configuration.provider,
			modelId: this.active?.configuration.modelId,
			baseUrl: this.active?.configuration.baseUrl,
			contextWindow: this.active?.configuration.contextWindow,
			maxTokens: this.active?.configuration.maxTokens,
			apiKeyConfigured: this.active?.configuration.apiKey !== undefined,
			providers: this.providers,
			error: this.configurationError,
		};
	}

	async configure(input: HydroAiConfigurationInput): Promise<HydroAiConfigurationSnapshot> {
		const provider = input.provider.trim();
		const modelId = input.modelId.trim();
		const suppliedApiKey = optionalTrimmedString(input.apiKey);
		const retainedApiKey = this.active?.configuration.apiKey;
		const tokenLimits = normalizeTokenLimits(
			input.contextWindow ?? this.active?.configuration.contextWindow,
			input.maxTokens ?? this.active?.configuration.maxTokens,
		);
		const configuration: StoredHydroAiConfiguration = {
			provider,
			modelId,
			apiKey: suppliedApiKey ?? retainedApiKey,
			baseUrl: normalizeBaseUrl(input.baseUrl),
			...tokenLimits,
		};
		const activated = await this.activate(configuration);
		await this.persist(configuration);
		this.active = activated;
		this.configurationError = undefined;
		return this.getSnapshot();
	}

	async clear(): Promise<HydroAiConfigurationSnapshot> {
		try {
			await unlink(this.configPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.active = undefined;
		this.configurationError = undefined;
		return this.getSnapshot();
	}

	async execute(input: HydroAgentExecutionInput): Promise<HydroAgentExecutionOutcome> {
		const executor = this.active?.executor;
		if (executor === undefined) {
			return {
				status: "failed",
				model: "unavailable",
				assistantText: "No configured Pi model is available.",
			};
		}
		return executor.execute(input);
	}

	private async load(options: HydroAiConfigurationOptions): Promise<void> {
		try {
			const stored = readStoredConfiguration(JSON.parse(await readFile(this.configPath, "utf8")) as unknown);
			if (!protocols.some((protocol) => protocol.id === stored.provider)) {
				const runtime = await this.modelRuntimeFactory();
				const legacyModel = runtime.getModels(stored.provider).find((model) => model.id === stored.modelId);
				const protocol = protocols.find((item) => item.id === legacyModel?.api);
				if (!protocol || !legacyModel)
					throw new HydroAiConfigurationError("旧配置无法自动识别协议，请选择 API 协议后保存。");
				stored.provider = protocol.id;
				stored.baseUrl ??= legacyModel.baseUrl;
			}
			this.active = await this.activate(stored);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.configurationError = error instanceof Error ? error.message : "AI 配置文件无法读取。";
				return;
			}
		}
		if (!options.enableAmbientCredentials) return;
		try {
			const runtime = await this.modelRuntimeFactory();
			const available = await runtime.getAvailable();
			const selected =
				options.provider === undefined && options.modelId === undefined
					? available[0]
					: available.find(
							(model) =>
								(options.provider === undefined || model.provider === options.provider) &&
								(options.modelId === undefined || model.id === options.modelId),
						);
			if (selected === undefined) return;
			const protocol = protocols.find((item) => item.id === selected.api);
			if (!protocol)
				throw new HydroAiConfigurationError("当前环境模型未使用支持的三种 API 协议，请在网页中配置模型。");
			this.active = {
				configuration: {
					provider: protocol.id,
					modelId: selected.id,
					baseUrl: selected.baseUrl,
					contextWindow: selected.contextWindow,
					maxTokens: selected.maxTokens,
				},
				executor: await createHydroAgentExecutor({
					...this.sessionOptions,
					modelRuntime: runtime,
					provider: selected.provider,
					modelId: selected.id,
				}),
			};
		} catch (error) {
			this.configurationError = error instanceof Error ? error.message : "Pi 模型配置无法加载。";
		}
	}

	private async activate(configuration: StoredHydroAiConfiguration): Promise<ActivatedConfiguration> {
		const protocol = protocols.find((candidate) => candidate.id === configuration.provider);
		if (!protocol)
			throw new HydroAiConfigurationError(
				"请选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages 协议。",
			);
		if (!configuration.modelId.trim()) throw new HydroAiConfigurationError("请填写模型名称。");
		if (!configuration.apiKey)
			throw new HydroAiConfigurationError("请填写 API Key；本地免认证服务可填写任意占位值。");
		const runtime = await this.modelRuntimeFactory();
		const providerId = `hydro-${protocol.id}`;
		runtime.registerProvider(providerId, {
			name: protocol.name,
			api: protocol.id,
			baseUrl: configuration.baseUrl ?? protocol.baseUrl,
			models: [
				{
					id: configuration.modelId,
					name: configuration.modelId,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: configuration.contextWindow,
					maxTokens: configuration.maxTokens,
					...(protocol.id === "openai-completions"
						? {
								compat: {
									supportsStore: false,
									supportsDeveloperRole: false,
									supportsStrictMode: false,
									maxTokensField: "max_tokens" as const,
								},
							}
						: protocol.id === "openai-responses"
							? {
									compat: {
										supportsMaxOutputTokens: true,
										supportsStrictMode: false,
									},
								}
							: {}),
				},
			],
		});
		await runtime.setRuntimeApiKey(providerId, configuration.apiKey);
		const executor = await createHydroAgentExecutor({
			...this.sessionOptions,
			modelRuntime: runtime,
			provider: providerId,
			modelId: configuration.modelId,
		});
		if (!executor.readiness.available) {
			throw new HydroAiConfigurationError("该 API 配置没有可用凭据，请填写 API Key 后重试。");
		}
		return { configuration, executor };
	}

	private async persist(configuration: StoredHydroAiConfiguration): Promise<void> {
		const directory = dirname(this.configPath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = `${this.configPath}.${process.pid}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, this.configPath);
	}
}
