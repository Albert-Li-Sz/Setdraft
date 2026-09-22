import { useEffect, useState } from "react";
import { type AiConfiguration, apiUrl, readAiConfiguration } from "./platform.ts";

type ConfigurationStatus = "loading" | "ready" | "saving" | "error";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const MIN_CONTEXT_WINDOW = 1_024;
const MAX_CONTEXT_WINDOW = 4_000_000;
const MAX_MAX_TOKENS = 1_000_000;

interface AiApiSettingsProps {
	apiOrigin: string;
	onConfigurationChanged: () => void;
}

function responseMessage(value: unknown): string {
	if (typeof value !== "object" || value === null) return "AI 配置请求失败。";
	const message = (value as Record<string, unknown>).message;
	return typeof message === "string" ? message : "AI 配置请求失败。";
}

function initialProvider(configuration: AiConfiguration): string {
	if (configuration.provider && configuration.providers.some((provider) => provider.id === configuration.provider)) {
		return configuration.provider;
	}
	return (
		configuration.providers.find((provider) => provider.id === "openai-completions")?.id ??
		configuration.providers[0]?.id ??
		""
	);
}

function parseTokenLength(value: string, label: string, minimum: number, maximum: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(
			`${label}须为 ${minimum.toLocaleString("zh-CN")}–${maximum.toLocaleString("zh-CN")} 之间的整数。`,
		);
	}
	return parsed;
}

export function AiApiSettings(props: AiApiSettingsProps) {
	const [configuration, setConfiguration] = useState<AiConfiguration>();
	const [status, setStatus] = useState<ConfigurationStatus>("loading");
	const [providerId, setProviderId] = useState("");
	const [modelId, setModelId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [contextWindow, setContextWindow] = useState(String(DEFAULT_CONTEXT_WINDOW));
	const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
	const [message, setMessage] = useState("正在读取 Pi Agent 配置……");

	useEffect(() => {
		const controller = new AbortController();
		setStatus("loading");
		setMessage("正在读取 Pi Agent 配置……");
		void (async () => {
			try {
				const response = await fetch(apiUrl(props.apiOrigin, "/ai/config"), { signal: controller.signal });
				const body = (await response.json()) as unknown;
				if (!response.ok) throw new Error(responseMessage(body));
				const parsed = readAiConfiguration(body);
				if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
				const nextProvider = initialProvider(parsed);
				setConfiguration(parsed);
				setProviderId(nextProvider);
				setModelId(parsed.modelId ?? "");
				setBaseUrl(parsed.baseUrl ?? "");
				setContextWindow(String(parsed.contextWindow ?? DEFAULT_CONTEXT_WINDOW));
				setMaxTokens(String(parsed.maxTokens ?? DEFAULT_MAX_TOKENS));
				setStatus("ready");
				setMessage(
					parsed.error ??
						(parsed.configured
							? `Pi Agent 已使用 ${parsed.provider}/${parsed.modelId}。`
							: "选择 API 协议，手动填写模型名称、Base URL 和 API Key。"),
				);
			} catch (error) {
				if (controller.signal.aborted) return;
				setStatus("error");
				setMessage(error instanceof Error ? error.message : "AI 配置读取失败。");
			}
		})();
		return () => controller.abort();
	}, [props.apiOrigin]);

	const hasStoredConfiguration =
		configuration?.configured === true ||
		configuration?.apiKeyConfigured === true ||
		configuration?.error !== undefined;

	async function save(): Promise<void> {
		if (!providerId || !modelId.trim()) {
			setStatus("error");
			setMessage("请选择 API 协议并填写模型名称。");
			return;
		}
		let parsedContextWindow: number;
		let parsedMaxTokens: number;
		try {
			parsedContextWindow = parseTokenLength(contextWindow, "上下文长度", MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
			parsedMaxTokens = parseTokenLength(maxTokens, "最大输出长度", 1, MAX_MAX_TOKENS);
			if (parsedMaxTokens > parsedContextWindow) throw new Error("最大输出长度不能超过上下文长度。");
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "模型长度配置无效。");
			return;
		}
		setStatus("saving");
		setMessage("正在保存并启用 Pi Agent 配置……");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, "/ai/config"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider: providerId,
					modelId,
					apiKey,
					baseUrl,
					contextWindow: parsedContextWindow,
					maxTokens: parsedMaxTokens,
				}),
			});
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(responseMessage(body));
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			setApiKey("");
			setBaseUrl(parsed.baseUrl ?? "");
			setContextWindow(String(parsed.contextWindow ?? DEFAULT_CONTEXT_WINDOW));
			setMaxTokens(String(parsed.maxTokens ?? DEFAULT_MAX_TOKENS));
			setStatus("ready");
			setMessage(`已保存并启用 ${parsed.provider}/${parsed.modelId}，现在可以运行 Pi Agent。`);
			props.onConfigurationChanged();
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "AI 配置保存失败。");
		}
	}

	async function clear(): Promise<void> {
		setStatus("saving");
		setMessage("正在删除本地 AI 配置……");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, "/ai/config"), { method: "DELETE" });
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(responseMessage(body));
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			const nextProvider = initialProvider(parsed);
			setConfiguration(parsed);
			setProviderId(nextProvider);
			setModelId(parsed.modelId ?? "");
			setApiKey("");
			setBaseUrl("");
			setContextWindow(String(DEFAULT_CONTEXT_WINDOW));
			setMaxTokens(String(DEFAULT_MAX_TOKENS));
			setStatus("ready");
			setMessage("本地 AI 配置已删除，Pi Agent 已停用。");
			props.onConfigurationChanged();
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "AI 配置删除失败。");
		}
	}

	return (
		<section className="card settings-card ai-settings-card">
			<div className="settings-card-heading">
				<div>
					<h2>Pi Agent · AI API</h2>
					<p>配置网页生成题目时使用的模型；保存后立即生效，无需重启。</p>
				</div>
				<span className={`status-badge ${configuration?.configured === true ? "online" : "offline"}`}>
					{configuration?.configured === true ? "已启用" : "未配置"}
				</span>
			</div>

			<form
				className="ai-settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<div className="ai-form-grid ai-identity-grid">
					<label className="field settings-field">
						<span>API 协议</span>
						<select
							aria-label="AI 协议"
							value={providerId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => {
								const nextProvider = event.target.value;
								setProviderId(nextProvider);
							}}
						>
							{configuration?.providers.map((provider) => (
								<option value={provider.id} key={provider.id}>
									{provider.name}
								</option>
							))}
						</select>
					</label>
					<label className="field settings-field">
						<span>模型名称</span>
						<input
							aria-label="AI 模型"
							value={modelId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setModelId(event.target.value)}
							placeholder="填写服务商提供的完整模型 ID"
							spellCheck={false}
						/>
					</label>
				</div>

				<div className="ai-form-grid ai-budget-grid">
					<label className="field settings-field">
						<span>上下文长度（tokens）</span>
						<input
							type="number"
							aria-label="AI 上下文长度"
							value={contextWindow}
							min={MIN_CONTEXT_WINDOW}
							max={MAX_CONTEXT_WINDOW}
							step={1}
							inputMode="numeric"
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setContextWindow(event.target.value)}
						/>
						<small>输入、工具历史和本次输出共享此窗口。</small>
					</label>
					<label className="field settings-field">
						<span>最大输出长度（tokens）</span>
						<input
							type="number"
							aria-label="AI 最大输出长度"
							value={maxTokens}
							min={1}
							max={MAX_MAX_TOKENS}
							step={1}
							inputMode="numeric"
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setMaxTokens(event.target.value)}
						/>
						<small>作为每次模型响应的输出上限。</small>
					</label>
				</div>

				<div className="ai-form-grid ai-credentials-grid">
					<label className="field settings-field">
						<span>API Key</span>
						<input
							type="password"
							aria-label="AI API Key"
							value={apiKey}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setApiKey(event.target.value)}
							placeholder={configuration?.apiKeyConfigured === true ? "已保存；留空可继续使用" : "粘贴 API Key"}
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
					<label className="field settings-field">
						<span>Base URL（可选）</span>
						<input
							aria-label="AI Base URL"
							value={baseUrl}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setBaseUrl(event.target.value)}
							placeholder={
								providerId === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1"
							}
							spellCheck={false}
						/>
					</label>
				</div>
				<p className="settings-help">
					模型名称直接传给 API，不受内置列表限制。长度配置会同时用于 Pi 的上下文管理和模型请求。Base URL
					留空使用所选协议的官方地址。API Key 保存在运行 API 服务的本机配置文件中；留空再次保存会沿用已有 Key。
				</p>
				<div className="settings-actions">
					<button className="button primary" type="submit" disabled={status === "loading" || status === "saving"}>
						{status === "saving" ? "正在处理……" : "保存并启用"}
					</button>
					<button
						className="button secondary danger-button"
						type="button"
						disabled={status === "loading" || status === "saving" || !hasStoredConfiguration}
						onClick={() => void clear()}
					>
						删除配置
					</button>
				</div>
				<output
					className={`connection-result ${status === "error" ? "offline" : configuration?.configured ? "online" : ""}`}
				>
					<span className="notice-dot" />
					{message}
				</output>
			</form>
		</section>
	);
}
