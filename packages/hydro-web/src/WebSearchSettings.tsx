import { useContext, useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { useLocale } from "./i18n.tsx";
import { apiUrl } from "./platform.ts";
import { WorkspacePausedContext } from "./workspace-paused.ts";

interface Configuration {
	enabled: boolean;
	provider: "searxng" | "tavily";
	dailyLimit: number;
	available: boolean;
	apiKeyConfigured: boolean;
}
export function WebSearchSettings({ apiOrigin }: { apiOrigin: string }) {
	const { t } = useLocale();
	const paused = useContext(WorkspacePausedContext);
	const [config, setConfig] = useState<Configuration>();
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		if (paused) return;
		const controller = new AbortController();
		setMessage("");
		void requestJson<Configuration>(apiUrl(apiOrigin, "/ai/search"), { signal: controller.signal })
			.then((loaded) => setConfig((current) => current ?? loaded))
			.catch((error) => {
				if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "搜索配置读取失败。");
			});
		return () => controller.abort();
	}, [apiOrigin, paused]);
	async function save() {
		if (!config) return;
		setBusy(true);
		setMessage("");
		try {
			setConfig(
				await requestJson<Configuration>(apiUrl(apiOrigin, "/ai/search"), {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...config, apiKey }),
				}),
			);
			setApiKey("");
			setMessage("搜索配置已保存。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "搜索配置保存失败。");
		} finally {
			setBusy(false);
		}
	}
	async function test() {
		setBusy(true);
		setMessage("");
		try {
			await requestJson(apiUrl(apiOrigin, "/ai/search"), { method: "POST" });
			setMessage("搜索连接正常。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "搜索连接失败。");
		} finally {
			setBusy(false);
		}
	}
	return (
		<section className="card settings-card search-settings-card">
			<h2>{t("联网搜索")}</h2>
			<p className="settings-help">
				{t("默认使用随部署启动的 SearXNG，也可选择 Tavily。只发送搜索关键词，不发送题目、附件和历史对话。")}
			</p>
			{config && (
				<form
					className="search-settings-form"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label className="search-settings-toggle">
						<input
							type="checkbox"
							checked={config.enabled}
							onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
						/>
						{t("启用联网搜索")}
					</label>
					<label className="field settings-field">
						<span>{t("搜索服务")}</span>
						<select
							value={config.provider}
							onChange={(event) =>
								setConfig({ ...config, provider: event.target.value as Configuration["provider"] })
							}
						>
							<option value="searxng">SearXNG</option>
							<option value="tavily">Tavily</option>
						</select>
					</label>
					{config.provider === "tavily" && (
						<label className="field settings-field">
							<span>API Key</span>
							<input
								type="password"
								autoComplete="new-password"
								value={apiKey}
								placeholder={config.apiKeyConfigured ? t("已配置，留空保留") : "tvly-…"}
								onChange={(event) => setApiKey(event.target.value)}
							/>
						</label>
					)}
					<label className="field settings-field">
						<span>{t("每人每日搜索次数")}</span>
						<input
							type="number"
							required
							min="1"
							max="10000"
							value={config.dailyLimit}
							onChange={(event) => setConfig({ ...config, dailyLimit: Number(event.target.value) })}
						/>
					</label>
					<div className="settings-actions">
						<button className="button primary" type="submit" disabled={busy}>
							{t("保存")}
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={busy || !config.available}
							onClick={() => void test()}
						>
							{t("测试连接")}
						</button>
					</div>
				</form>
			)}
			{message && (
				<output className="notice pending" aria-live="polite">
					{t(message)}
				</output>
			)}
		</section>
	);
}
