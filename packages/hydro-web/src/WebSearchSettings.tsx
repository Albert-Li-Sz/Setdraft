import type { SearchDiagnosticReport, SearchDiagnostics, SearchHealth } from "@setdraft/contracts";
import { useContext, useEffect, useRef, useState } from "react";
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
	health?: SearchDiagnostics;
}
const healthLabels: Record<SearchHealth, string> = {
	healthy: "搜索健康",
	partial: "部分引擎不可用",
	"no-match": "没有匹配结果",
	"engines-unavailable": "上游引擎不可用",
	"filtered-empty": "候选资料过滤后为空",
	configuration: "配置未就绪",
	timeout: "搜索超时",
	network: "出站连接失败",
	http: "上游 HTTP 错误",
	"invalid-response": "上游响应格式错误",
};
export function WebSearchSettings({ apiOrigin }: { apiOrigin: string }) {
	const { t } = useLocale();
	const paused = useContext(WorkspacePausedContext);
	const [config, setConfig] = useState<Configuration>();
	const [apiKey, setApiKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [report, setReport] = useState<SearchDiagnosticReport>();
	const action = useRef<AbortController | undefined>(undefined);
	useEffect(() => {
		if (paused) {
			action.current?.abort();
			setBusy(false);
			return;
		}
		const controller = new AbortController();
		setMessage("");
		void requestJson<Configuration>(apiUrl(apiOrigin, "/ai/search"), { signal: controller.signal })
			.then((loaded) => setConfig((current) => current ?? loaded))
			.catch((error) => {
				if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "搜索配置读取失败。");
			});
		return () => {
			controller.abort();
			action.current?.abort();
		};
	}, [apiOrigin, paused]);
	async function save() {
		if (!config) return;
		setBusy(true);
		setMessage("");
		const controller = new AbortController();
		action.current = controller;
		try {
			setConfig(
				await requestJson<Configuration>(apiUrl(apiOrigin, "/ai/search"), {
					method: "PUT",
					headers: { "content-type": "application/json" },
					signal: controller.signal,
					body: JSON.stringify({ ...config, apiKey }),
				}),
			);
			if (controller.signal.aborted) return;
			setApiKey("");
			setReport(undefined);
			setMessage("搜索配置已保存。");
		} catch (error) {
			if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "搜索配置保存失败。");
		} finally {
			if (action.current === controller) setBusy(false);
		}
	}
	async function test(language: "zh" | "en") {
		setBusy(true);
		setMessage("");
		const controller = new AbortController();
		action.current = controller;
		try {
			const value = await requestJson<SearchDiagnosticReport>(apiUrl(apiOrigin, "/ai/search/diagnostics"), {
				method: "POST",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ language }),
			});
			if (controller.signal.aborted) return;
			setReport(value);
			setMessage(healthLabels[value.aggregate.status]);
		} catch (error) {
			if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "搜索连接失败。");
		} finally {
			if (action.current === controller) setBusy(false);
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
					<p className="settings-help">
						{t(config.available ? "配置已就绪，搜索健康需主动诊断。" : "配置未就绪")}
						{config.health && ` · ${t(healthLabels[config.health.status])}`}
					</p>
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
							onClick={() => void test("zh")}
						>
							{t("中文诊断")}
						</button>
						<button
							className="button secondary"
							type="button"
							disabled={busy || !config.available}
							onClick={() => void test("en")}
						>
							{t("英文诊断")}
						</button>
					</div>
				</form>
			)}
			{report && (
				<div className="search-diagnostics">
					<p>
						{t(
							"耗时 {0} ms · 候选 {1} · 接受 {2}",
							report.aggregate.durationMs,
							report.aggregate.candidateCount,
							report.aggregate.acceptedCount,
						)}
					</p>
					<table>
						<thead>
							<tr>
								<th>{t("引擎")}</th>
								<th>{t("状态")}</th>
								<th>ms</th>
								<th>{t("候选 / 接受")}</th>
							</tr>
						</thead>
						<tbody>
							{report.engines.map(({ name, diagnostics }) => (
								<tr key={name}>
									<td>{name}</td>
									<td>
										{t(healthLabels[diagnostics.status])}
										{diagnostics.engines.map((engine) => ` · ${engine.category}`).join("")}
									</td>
									<td>{diagnostics.durationMs}</td>
									<td>
										{diagnostics.candidateCount} / {diagnostics.acceptedCount}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<button
						className="button secondary"
						type="button"
						onClick={() => {
							const url = URL.createObjectURL(
								new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
							);
							const link = document.createElement("a");
							link.href = url;
							link.download = "setdraft-search-diagnostics.json";
							link.click();
							URL.revokeObjectURL(url);
						}}
					>
						{t("下载脱敏诊断")}
					</button>
				</div>
			)}
			{message && (
				<output className="notice pending" aria-live="polite">
					{t(message)}
				</output>
			)}
		</section>
	);
}
