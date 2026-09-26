import { useCallback, useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
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

function initialProvider(configuration: AiConfiguration): string {
	return (
		configuration.providers.find((provider) => provider.id === "openai-completions")?.id ??
		configuration.providers[0]?.id ??
		""
	);
}

function parseTokenLength(value: string, minimum: number, maximum: number): number | undefined {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : undefined;
}

export function AiApiSettings(props: AiApiSettingsProps) {
	const { t } = useLocale();
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
	const [message, setMessage] = useState<UiMessage>("正在读取 AI 对话配置……");
	const [testing, setTesting] = useState(false);

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
				const body = await requestJson<unknown>(apiUrl(props.apiOrigin, "/ai/config"), {
					signal: controller.signal,
				});
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
							? uiMessage("已保存 {0} 套 AI 配置，可在同一对话中切换。", parsed.profiles.length)
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
		const parsedContextWindow = parseTokenLength(contextWindow, MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
		const parsedMaxTokens = parseTokenLength(maxTokens, 1, MAX_MAX_TOKENS);
		if (parsedContextWindow === undefined || parsedMaxTokens === undefined) {
			setStatus("error");
			const invalidContext = parsedContextWindow === undefined;
			setMessage(
				uiMessage(
					"{0}须为 {1}–{2} 之间的整数。",
					uiMessage(invalidContext ? "上下文长度" : "最大输出长度"),
					(invalidContext ? MIN_CONTEXT_WINDOW : 1).toLocaleString("en"),
					(invalidContext ? MAX_CONTEXT_WINDOW : MAX_MAX_TOKENS).toLocaleString("en"),
				),
			);
			return;
		}
		if (parsedMaxTokens > parsedContextWindow) {
			setStatus("error");
			setMessage("最大输出长度不能超过上下文长度。");
			return;
		}
		setStatus("saving");
		setMessage("正在保存 AI 对话配置……");
		try {
			const body = await requestJson<unknown>(apiUrl(props.apiOrigin, "/ai/config"), {
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
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			const saved = selectedId ? parsed.profiles.find((item) => item.id === selectedId) : parsed.profiles.at(-1);
			selectProfile(parsed, saved);
			setStatus("ready");
			setMessage(uiMessage("已保存“{0}”。对话页可选择该配置。", saved?.name ?? profileName));
			props.onConfigurationChanged();
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "AI 配置保存失败。");
		}
	}

	async function removeProfile(): Promise<void> {
		if (!selectedProfile || !window.confirm(t("删除 AI 配置“{0}”？已有对话和消息会保留。", selectedProfile.name)))
			return;
		setStatus("saving");
		setMessage("正在删除 AI 配置……");
		try {
			const body = await requestJson<unknown>(
				apiUrl(props.apiOrigin, `/ai/config/${encodeURIComponent(selectedProfile.id)}`),
				{
					method: "DELETE",
				},
			);
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			selectProfile(
				parsed,
				parsed.profiles.find((item) => item.id === parsed.defaultProfileId) ?? parsed.profiles[0],
			);
			setStatus("ready");
			setMessage(uiMessage("已删除“{0}”；对话记录仍保留。", selectedProfile.name));
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
			const body = await requestJson<unknown>(apiUrl(props.apiOrigin, "/ai/config/default"), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ profileId: selectedProfile.id }),
			});
			const parsed = readAiConfiguration(body);
			if (parsed === undefined) throw new Error("服务端返回了无法识别的 AI 配置。");
			setConfiguration(parsed);
			setStatus("ready");
			setMessage(uiMessage("“{0}”已设为新对话默认配置。", selectedProfile.name));
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "设置默认配置失败。");
		}
	}

	async function testConnection(): Promise<void> {
		if (!selectedProfile) return;
		setTesting(true);
		setMessage("正在发送一条短消息测试模型连接…");
		try {
			const body = await requestJson<{ reply?: string; usage?: { input: number; output: number } }>(
				apiUrl(props.apiOrigin, `/ai/config/${selectedProfile.id}/test`),
				{ method: "POST" },
			);
			setMessage(
				uiMessage(
					"连接成功 · {0}{1}",
					selectedProfile.modelId,
					body.usage ? uiMessage(" · 输入 {0} / 输出 {1} tokens", body.usage.input, body.usage.output) : "",
				),
			);
			setStatus("ready");
		} catch (error) {
			setStatus("error");
			setMessage(error instanceof Error ? error.message : "模型连接失败。");
		} finally {
			setTesting(false);
		}
	}

	return (
		<section className="card settings-card ai-settings-card">
			<div className="settings-card-heading">
				<div>
					<h2>{t("AI 对话 · API")}</h2>
					<p>{t("配置独立对话使用的模型；保存后立即生效，无需重启。")}</p>
				</div>
				<span className={`status-badge ${configuration?.configured === true ? "online" : "offline"}`}>
					{configuration?.configured === true ? t("已启用") : t("未配置")}
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
						<span>{t("已保存的 API / 模型配置")}</span>
						<select
							aria-label={t("AI 配置列表")}
							value={selectedId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => {
								const profile = configuration?.profiles.find((item) => item.id === event.target.value);
								if (configuration) selectProfile(configuration, profile);
							}}
						>
							<option value="">{t("新建配置")}</option>
							{configuration?.profiles.map((profile) => (
								<option value={profile.id} key={profile.id}>
									{profile.name}
									{profile.id === configuration.defaultProfileId ? t(" · 默认") : ""}
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
						{t("新增配置")}
					</button>
				</div>
				<label className="field settings-field">
					<span>{t("配置名称")}</span>
					<input
						aria-label={t("AI 配置名称")}
						value={profileName}
						disabled={status === "loading" || status === "saving"}
						onChange={(event) => setProfileName(event.target.value)}
						placeholder={t("例如：主力模型、备用 API")}
						maxLength={80}
					/>
				</label>
				<div className="ai-form-grid ai-identity-grid">
					<label className="field settings-field">
						<span>{t("API 协议")}</span>
						<select
							aria-label={t("AI 协议")}
							value={providerId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => {
								const nextProvider = event.target.value;
								setProviderId(nextProvider);
							}}
						>
							{configuration?.providers.map((provider) => (
								<option value={provider.id} key={provider.id}>
									{t(provider.name)}
								</option>
							))}
						</select>
					</label>
					<label className="field settings-field">
						<span>{t("模型名称")}</span>
						<input
							aria-label={t("AI 模型")}
							value={modelId}
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setModelId(event.target.value)}
							placeholder={t("填写服务商提供的完整模型 ID")}
							spellCheck={false}
						/>
					</label>
				</div>

				<div className="ai-form-grid ai-budget-grid">
					<label className="field settings-field">
						<span>{t("上下文长度（tokens）")}</span>
						<input
							type="number"
							aria-label={t("AI 上下文长度")}
							value={contextWindow}
							min={MIN_CONTEXT_WINDOW}
							max={MAX_CONTEXT_WINDOW}
							step={1}
							inputMode="numeric"
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setContextWindow(event.target.value)}
						/>
						<small>{t("对话历史和本次输出共享此窗口。")}</small>
					</label>
					<label className="field settings-field">
						<span>{t("最大输出长度（tokens）")}</span>
						<input
							type="number"
							aria-label={t("AI 最大输出长度")}
							value={maxTokens}
							min={1}
							max={MAX_MAX_TOKENS}
							step={1}
							inputMode="numeric"
							disabled={status === "loading" || status === "saving"}
							onChange={(event) => setMaxTokens(event.target.value)}
						/>
						<small>{t("作为每次模型响应的输出上限。")}</small>
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
							placeholder={
								selectedProfile?.apiKeyConfigured ? t("该配置已保存；留空可继续使用") : t("粘贴 API Key")
							}
							autoComplete="off"
							spellCheck={false}
						/>
					</label>
					<label className="field settings-field">
						<span>{t("Base URL（可选）")}</span>
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
					{t(
						"每套配置可使用不同协议、API、模型和长度限制。对话页可切换配置，历史消息继续作为上下文；超过当前模型窗口时仅裁剪模型请求中的较早消息。Base URL 留空使用协议默认地址。API Key 保存在本机，编辑现有配置时留空可沿用该配置的 Key。",
					)}
				</p>
				<div className="settings-actions">
					<button
						className="button secondary"
						type="button"
						disabled={!selectedProfile || testing || status === "saving"}
						onClick={() => void testConnection()}
					>
						{testing ? t("测试中…") : t("测试模型连接")}
					</button>
					<button className="button primary" type="submit" disabled={status === "loading" || status === "saving"}>
						{status === "saving" ? t("正在处理……") : selectedId ? t("保存配置") : t("添加配置")}
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
						{t("设为默认")}
					</button>
					<button
						className="button secondary danger-button"
						type="button"
						disabled={status === "loading" || status === "saving" || !selectedProfile}
						onClick={() => void removeProfile()}
					>
						{t("删除当前配置")}
					</button>
				</div>
				<output
					className={`connection-result ${status === "error" ? "offline" : configuration?.configured ? "online" : ""}`}
				>
					<span className="notice-dot" />
					{t(message)}
				</output>
			</form>
		</section>
	);
}
