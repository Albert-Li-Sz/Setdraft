import type { MatrixCell, MatrixDiagnostic, VerificationRun } from "@setdraft/contracts";
import { useEffect, useState } from "react";
import { apiUrl, requestJson } from "./api-client.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import { RoundDiagnostics } from "./RoundDiagnostics.tsx";

export function VerificationDetail({
	apiOrigin,
	route,
	run,
	cell,
	onClose,
}: {
	apiOrigin: string;
	route: string;
	run?: VerificationRun;
	cell?: MatrixCell;
	onClose(): void;
}) {
	const { t } = useLocale();
	const [detail, setDetail] = useState<MatrixDiagnostic>();
	const [error, setError] = useState("");
	const runId = run?.id;
	const diagnosticsReady = run?.diagnostics ?? false;
	useEffect(() => {
		setDetail(undefined);
		setError("");
		if (!cell || !runId) return;
		const controller = new AbortController();
		const query = new URLSearchParams({ solution: cell.solutionId, case: cell.caseId });
		void requestJson<MatrixDiagnostic>(apiUrl(apiOrigin, `${route}/${runId}/cell?${query}`), {
			signal: controller.signal,
		})
			.then((value) => {
				if (!controller.signal.aborted)
					setDetail({ ...value, previewOnly: value.previewOnly || !diagnosticsReady });
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "运行记录读取失败。");
			});
		return () => controller.abort();
	}, [apiOrigin, route, runId, diagnosticsReady, cell]);
	const value = detail?.cell ?? cell;
	const download = (path: string, label: string) => (
		<a
			key={path}
			className="button secondary button-link"
			download
			href={apiUrl(apiOrigin, `${route}/${run?.id}/artifact?name=${encodeURIComponent(path)}`)}
		>
			{label}
		</a>
	);
	const difference = detail?.difference;
	return (
		<Dialog open={!!cell} onClose={onClose} labelledBy="matrix-cell-title" className="verification-detail">
			<div className="verification-heading">
				<h2 id="matrix-cell-title">
					{t("判定详情")} · {value?.verdict}
				</h2>
				<button className="button secondary" type="button" onClick={onClose}>
					{t("关闭")}
				</button>
			</div>
			<p>
				{run?.solutions.find((item) => item.id === value?.solutionId)?.name} · {value?.caseId} ·{" "}
				{t(value?.message ?? "")}
			</p>
			<p>
				{value?.durationMs} ms ·{" "}
				{value?.memoryBytes === undefined ? t("内存记录不可用") : `${(value.memoryBytes / 1048576).toFixed(2)} MiB`}
			</p>
			{value?.rounds && (
				<RoundDiagnostics
					rounds={value.rounds}
					apiOrigin={apiOrigin}
					route={route}
					runId={runId}
					ready={diagnosticsReady}
				/>
			)}
			{error && <p role="alert">{t(error)}</p>}
			{!detail && !error && cell && <output>{t("正在读取详情…")}</output>}
			{difference && (
				<section className="output-difference" aria-label={t("首次文本差异")}>
					<h3>{t("首次文本差异：第 {0} 行，第 {1} 列", difference.line, difference.column)}</h3>
					<div className="verification-previews">
						{(["actual", "expected"] as const).map((kind) => (
							<div key={kind}>
								<strong>{t(kind === "actual" ? "实际输出" : "预期输出")}</strong>
								<pre>
									{difference[kind].before}
									<mark>
										{difference[kind].focus === "\n"
											? "↵"
											: difference[kind].focus === "\t"
												? "⇥"
												: difference[kind].focus === " "
													? "␣"
													: difference[kind].focus || t("文件结束")}
									</mark>
									{difference[kind].after}
								</pre>
							</div>
						))}
					</div>
					<p>{t("文本差异仅用于定位，判定以 Checker / Interactor 为准。")}</p>
				</section>
			)}
			{detail?.previewOnly && <p>{t("当前仅有预览；完整诊断文件在运行结束后可用，旧记录可能未保存。")}</p>}
			<div className="verification-previews">
				<div>
					<h3>{t("实际输出")}</h3>
					<pre>{value?.output || "—"}</pre>
				</div>
				<div>
					<h3>{t("预期输出")}</h3>
					<pre>{value?.expected || "—"}</pre>
				</div>
			</div>
			<h3>{t("编译 / Checker / Interactor 日志")}</h3>
			<pre>{value?.log || "—"}</pre>
			<p>{t("页面显示有长度限制的预览；下载保留沙箱限额内的完整输出与日志。")}</p>
			{run?.diagnostics && (
				<div className="heading-actions">
					{value?.artifacts?.output && download(value.artifacts.output, t("下载实际输出"))}
					{value?.artifacts?.expected && download(value.artifacts.expected, t("下载预期输出"))}
					{value?.artifacts?.logs.map((path, index) => download(path, t("下载日志 {0}", index + 1)))}
				</div>
			)}
		</Dialog>
	);
}
