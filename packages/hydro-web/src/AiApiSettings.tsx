import { useCallback, useEffect, useState } from "react";
import { type AiConfiguration, type AiProfile, apiUrl, readAiConfiguration } from "./platform.ts";

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
	const [selectedId, setSelectedId] = useState("");
	const [profileName, setProfileName] = useState("");
	const [providerId, setProviderId] = useState("");
	const [modelId, setModelId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [contextWindow, setContextWindow] = useState(String(DEFAULT_CONTEXT_WINDOW));
	const [maxTokens, setMaxTokens] = useState(String(DEFAULT_MAX_TOKENS));
	const [message, setMessage] = useState("正在读取 AI 对话配置……");

	const selectProfile = useCallback((current: AiConfiguration, profile?: AiProfile): void => {
		setSelectedId(profile?.id ?? "");
		setProfileName(profile?.name ?? "");
		setProviderId(profile?.provider ?? initialProvider(current));
		setModelId(profile?.modelId ?? "");
		setApiKey("");
		setBaseUrl(profile?.baseUrl ?? "");
		setContextWindow(String(profile?.contextWindow ?? DEFAULT_CONTEXT_WINDOW));
		setMaxTokens(String(profile?.maxTokens ?? DEFAULT_MAX_TOKENS));
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		setStatus("loading");
		setMessage("正在读取 AI 对话配置……");
		void (async () => {
			try {
				const response = await fetch(apiUrl(props.apiOrigin, "/ai/config"), { signal: controller.signal });
				const body = (await response.json()) as unknown;
				if (!response.ok) throw new Error(responseMessage(body));
				const parsed = readAiConfiguration(body);
				if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
				setConfiguration(parsed);
				selectProfile(
					parsed,
					parsed.profiles.find((item) => item.id === parsed.defaultProfileId) ?? parsed.profiles[0],
				);
				setStatus("ready");
				setMessage(
					parsed.error ??
						(parsed.configured
							? `已保存 ${parsed.profiles.length} 套 AI 配置，可在同一对话中切换。`
							: "新建配置并填写 API 协议、模型名称和 API Key。"),
				);
			} catch (error) {
				if (controller.signal.aborted) return;
				setStatus("error");
				setMessage(error instanceof Error ? error.message : "AI 配置读取失败。");
			}
		})();
		return () => controller.abort();
	}, [props.apiOrigin, selectProfile]);

	const selectedProfile = configuration?.profiles.find((item) => item.id === selectedId);

	async function save(): Promise<void> {
		if (!profileName.trim() || !providerId || !modelId.trim()) {
			setStatus("error");
			setMessage("请填写配置名称、API 协议和模型名称。");
			return;
		}
		if (!selectedId && !apiKey.trim()) {
			setStatus("error");
			setMessage("新增配置时请填写 API Key。");
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
		setMessage("正在保存 AI 对话配置……");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, "/ai/config"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: selectedId || undefined,
					name: profileName,
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
			const saved = selectedId ? parsed.profiles.find((item) => item.id === selectedId) : parsed.profiles.at(-1);
			selectProfile(parsed, saved);
			setStatus("ready");
			setMessage(`已保存“${saved?.name ?? profileName}”。对话页可选择该配置。`);
			props.onConfigurationChanged();
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "AI 配置保存失败。");
		}
	}

	async function removeProfile(): Promise<void> {
		if (!selectedProfile || !window.confirm(`删除 AI 配置“${selectedProfile.name}”？已有对话和消息会保留。`)) return;
		setStatus("saving");
		setMessage("正在删除 AI 配置……");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, `/ai/config/${encodeURIComponent(selectedProfile.id)}`), {
				method: "DELETE",
			});
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(responseMessage(body));
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			selectProfile(
				parsed,
				parsed.profiles.find((item) => item.id === parsed.defaultProfileId) ?? parsed.profiles[0],
			);
			setStatus("ready");
			setMessage(`已删除“${selectedProfile.name}”；对话记录仍保留。`);
			props.onConfigurationChanged();
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "AI 配置删除失败。");
		}
	}

	async function setDefault(): Promise<void> {
		if (!selectedProfile) return;
		setStatus("saving");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, "/ai/config/default"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ profileId: selectedProfile.id }),
			});
			const body = (await response.json()) as unknown;
			if (!response.ok) throw new Error(responseMessage(body));
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			setStatus("ready");
			setMessage(`“${selectedProfile.name}”已设为新对话默认配置。`);
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "设置默认配置失败。");
		}
	}

	return (
		<section className="card settings-card ai-settings-card">
			<div className="settings-card-heading">
				<div>
					<h2>AI 对话 · API</h2>
					<p>配置独立对话使用的模型；保存后立即生效，无需重启。</p>
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
				<div className="ai-profile-toolbar">
					<label className="field settings-field">
						<span>已保存的 API / 模型配置</span>
						<select
							aria-label="AI 配置列表"
							value={selectedId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => {
								const profile = configuration?.profiles.find((item) => item.id === event.target.value);
								if (configuration) selectProfile(configuration, profile);
							}}
						>
							<option value="">新建配置</option>
							{configuration?.profiles.map((profile) => (
								<option value={profile.id} key={profile.id}>
									{profile.name}
									{profile.id === configuration.defaultProfileId ? " · 默认" : ""}
								</option>
							))}
						</select>
					</label>
					<button
						className="button secondary"
						type="button"
						disabled={status === "loading" || status === "saving"}
						onClick={() => configuration && selectProfile(configuration)}
					>
						新增配置
					</button>
				</div>
				<label className="field settings-field">
					<span>配置名称</span>
					<input
						aria-label="AI 配置名称"
						value={profileName}
						disabled={status === "loading" || status === "saving"}
						onChange={(event) => setProfileName(event.target.value)}
						placeholder="例如：主力模型、备用 API"
						maxLength={80}
					/>
				</label>
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
						<small>对话历史和本次输出共享此窗口。</small>
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
							placeholder={selectedProfile?.apiKeyConfigured ? "该配置已保存；留空可继续使用" : "粘贴 API Key"}
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
					每套配置可使用不同协议、API、模型和长度限制。对话页可切换配置，历史消息继续作为上下文；超过当前模型窗口时仅裁剪模型请求中的较早消息。Base
					URL 留空使用协议默认地址。API Key 保存在本机，编辑现有配置时留空可沿用该配置的 Key。
				</p>
				<div className="settings-actions">
					<button className="button primary" type="submit" disabled={status === "loading" || status === "saving"}>
						{status === "saving" ? "正在处理……" : selectedId ? "保存配置" : "添加配置"}
					</button>
					<button
						className="button secondary"
						type="button"
						disabled={
							status === "loading" ||
							status === "saving" ||
							!selectedProfile ||
							selectedId === configuration?.defaultProfileId
						}
						onClick={() => void setDefault()}
					>
						设为默认
					</button>
					<button
						className="button secondary danger-button"
						type="button"
						disabled={status === "loading" || status === "saving" || !selectedProfile}
						onClick={() => void removeProfile()}
					>
						删除当前配置
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
