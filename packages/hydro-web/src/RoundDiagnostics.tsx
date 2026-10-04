import type { RoundResult } from "@setdraft/contracts";
import { useEffect, useId, useState } from "react";
import { apiUrl } from "./api-client.ts";
import { authFetch } from "./auth-client.ts";
import { useLocale } from "./i18n.tsx";

export function RoundDiagnostics({
	rounds,
	apiOrigin,
	route,
	runId,
	ready,
}: {
	rounds: RoundResult[];
	apiOrigin: string;
	route: string;
	runId?: string;
	ready: boolean;
}) {
	const { t } = useLocale();
	const prefix = useId();
	const [selected, setSelected] = useState<1 | 2>(1);
	const [log, setLog] = useState("");
	const round = rounds.find((item) => item.round === selected);
	const path = round?.logPath;
	useEffect(() => {
		setLog("");
		if (!path || !runId || !ready) return;
		const controller = new AbortController();
		void authFetch(apiUrl(apiOrigin, `${route}/${runId}/artifact?name=${encodeURIComponent(path)}`), {
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok) throw new Error(t("轮次日志读取失败。"));
				return response.text();
			})
			.then((text) => {
				if (!controller.signal.aborted) {
					try {
						setLog(JSON.stringify(JSON.parse(text.slice(0, 256 * 1024)), null, 2).slice(0, 8000));
					} catch {
						setLog(text.slice(0, 8000));
					}
				}
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted) setLog(error instanceof Error ? error.message : t("轮次日志读取失败。"));
			});
		return () => controller.abort();
	}, [apiOrigin, route, path, runId, ready, t]);
	return (
		<section className="round-diagnostics">
			<p>{t("本地耗时与内存为两轮最大值；外部平台可能只展示最后一轮资源。")}</p>
			<div className="statement-tabs" role="tablist" aria-label={t("轮次诊断")}>
				{rounds.map((item, index) => (
					<button
						key={item.round}
						type="button"
						role="tab"
						id={`${prefix}-tab-${item.round}`}
						aria-controls={`${prefix}-panel`}
						aria-selected={selected === item.round}
						tabIndex={selected === item.round ? 0 : -1}
						onClick={() => setSelected(item.round)}
						onKeyDown={(event) => {
							if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
								event.preventDefault();
								const next =
									event.key === "Home"
										? rounds[0].round
										: event.key === "End"
											? rounds[rounds.length - 1].round
											: rounds[(index + 1) % rounds.length].round;
								setSelected(next);
								document.getElementById(`${prefix}-tab-${next}`)?.focus();
							}
						}}
					>
						{t("第 {0} 轮", item.round)} · {item.state === "skipped" ? t("未运行") : item.verdict}
					</button>
				))}
			</div>
			<div role="tabpanel" id={`${prefix}-panel`} aria-labelledby={`${prefix}-tab-${selected}`}>
				<p>{t(round?.message ?? "")}</p>
				<p>
					{round?.state === "complete" &&
						`${round.durationMs ?? 0} ms · ${((round.memoryBytes ?? 0) / 1048576).toFixed(2)} MiB`}
				</p>
				{round?.state === "complete" && (
					<>
						<h3>{t("通信记录与裁判日志")}</h3>
						<pre>{log || t("完整日志在运行结束后可用。")}</pre>
					</>
				)}
				{ready &&
					round?.artifacts?.map((name) => (
						<a
							className="button secondary button-link"
							key={name}
							download
							href={apiUrl(apiOrigin, `${route}/${runId}/artifact?name=${encodeURIComponent(name)}`)}
						>
							{t(name.endsWith(".handoff") ? "下载交接数据" : "下载轮次文件")}
						</a>
					))}
			</div>
		</section>
	);
}
