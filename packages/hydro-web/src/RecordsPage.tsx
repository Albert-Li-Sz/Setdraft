import { useState } from "react";
import { authFetch } from "./auth-client.ts";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
import { apiUrl, isContestReadyRelease, type ManualRelease, type ProjectSnapshot } from "./platform.ts";

interface Props {
	apiOrigin: string;
	projects: ProjectSnapshot[];
	releases: ManualRelease[];
	loading: boolean;
	message: UiMessage;
	tone: "passed" | "failed";
	onRefresh(): Promise<void>;
	onOpen(id: string): Promise<void>;
	onDelete(id: string): Promise<void>;
	onDeleteRelease(id: string): Promise<void>;
}

export function RecordsPage(props: Props) {
	const { t, locale } = useLocale();
	const [pendingDelete, setPendingDelete] = useState<ProjectSnapshot>();
	const [pendingReleaseDelete, setPendingReleaseDelete] = useState<ManualRelease>();
	const [exporting, setExporting] = useState("");
	const [exportMessage, setExportMessage] = useState<UiMessage>("");
	async function exportOne(release: ManualRelease, format: "domjudge" | "fps" | "qduoj"): Promise<void> {
		setExporting(`${release.id}:${format}`);
		try {
			const response = await authFetch(apiUrl(props.apiOrigin, `/releases/${release.id}/exports/${format}`), {
				method: "POST",
			});
			const result = (await response.json()) as { message?: string; download?: string };
			if (!response.ok || !result.download) throw new Error(result.message ?? "导出失败。");
			setExportMessage(uiMessage("“{0}”的 {1} 包已生成，正在下载。", release.title, format.toUpperCase()));
			window.location.href = apiUrl(props.apiOrigin, result.download.replace(/^\/api/u, ""));
		} catch (error) {
			setExportMessage(
				uiMessage(
					"“{0}”导出 {1} 失败：{2}",
					release.title,
					format.toUpperCase(),
					error instanceof Error ? error.message : uiMessage("导出失败。"),
				),
			);
		} finally {
			setExporting("");
		}
	}
	return (
		<main className="page" id="records">
			<section className="page-heading">
				<div>
					<h1>{t("制题记录")}</h1>
					<p>{t("草稿可重新打开；已通过验证的历史包保持可下载。")}</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() => void props.onRefresh()}
					disabled={props.loading}
				>
					{props.loading ? t("刷新中…") : t("刷新记录")}
				</button>
			</section>
			{(props.loading || props.message) && (
				<output className={`notice ${props.loading ? "pending" : props.tone}`} aria-live="polite">
					<span className="notice-dot" />
					{props.loading ? t("正在读取制题记录…") : t(props.message)}
				</output>
			)}
			{exportMessage && (
				<output className="notice pending" aria-live="polite">
					<span className="notice-dot" />
					{t(exportMessage)}
				</output>
			)}
			<section className="card manual-record-card">
				<div className="manual-section-heading">
					<div>
						<h2>{t("草稿")}</h2>
						<p>{t("本地项目：{0}", props.projects.length)}</p>
					</div>
				</div>
				<div className="history-table-wrap">
					<table className="history-table">
						<thead>
							<tr>
								<th>{t("题目")}</th>
								<th>{t("版本")}</th>
								<th>{t("测试点")}</th>
								<th>{t("最后修改")}</th>
								<th>{t("操作")}</th>
							</tr>
						</thead>
						<tbody>
							{props.projects.map((item) => (
								<tr key={item.id}>
									<td>
										<strong>{item.title || t("未命名题目")}</strong>
										<code>{item.slug || item.id}</code>
									</td>
									<td>{item.revision}</td>
									<td>{item.cases.length}</td>
									<td>{new Date(item.updatedAt).toLocaleString(locale)}</td>
									<td>
										<div className="history-actions">
											<button type="button" onClick={() => void props.onOpen(item.id)}>
												{t("继续编辑")}
											</button>
											<button type="button" className="danger" onClick={() => setPendingDelete(item)}>
												{t("删除")}
											</button>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{props.projects.length === 0 && <p className="manual-muted history-empty">{t("暂无草稿。")}</p>}
				</div>
			</section>
			<section className="card manual-record-card">
				<div className="manual-section-heading">
					<div>
						<h2>{t("已验证发布包")}</h2>
						<p>{t("每条记录与对应草稿版本、文件哈希和验证报告绑定。")}</p>
					</div>
				</div>
				<div className="history-table-wrap">
					<table className="history-table">
						<thead>
							<tr>
								<th>{t("题目")}</th>
								<th>{t("草稿版本")}</th>
								<th>{t("测试点")}</th>
								<th>{t("赛制 / Checker")}</th>
								<th>{t("发布时间")}</th>
								<th>{t("历史 Hydro 实测")}</th>
								<th>{t("下载")}</th>
								<th>{t("操作")}</th>
							</tr>
						</thead>
						<tbody>
							{props.releases.map((item) => (
								<tr key={item.id}>
									<td>
										<strong>{item.title}</strong>
										<code>
											{item.slug} · {item.id.slice(0, 8)}
										</code>
									</td>
									<td>{item.revision}</td>
									<td>{item.report.caseCount}</td>
									<td>
										{item.scoringMode?.toUpperCase() ?? t("旧版")} ·{" "}
										{item.report.checkerUsed
											? item.checkerMode === "text"
												? t("文本")
												: item.checkerMode === "custom"
													? t("自定义")
													: t("旧版 Checker")
											: t("未验证 Checker")}
									</td>
									<td>{new Date(item.createdAt).toLocaleString(locale)}</td>
									<td>
										{item.liveVerification
											? `${item.liveVerification.success ? "通过" : "未通过"} · ${item.liveVerification.reference.verdict}`
											: t("无历史记录")}
									</td>
									<td>
										<div className="history-actions">
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/hydro`)}
												download={`${item.slug}.hydro.zip`}
											>
												{t("Hydro 包")}
											</a>
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/source`)}
												download={`${item.slug}.authoring.zip`}
											>
												{t("制题工程")}
											</a>
											{isContestReadyRelease(item) && item.scoringMode === "acm" && (
												<>
													<button
														type="button"
														disabled={!!exporting}
														onClick={() => void exportOne(item, "domjudge")}
													>
														{exporting === `${item.id}:domjudge` ? t("导出中…") : "DOMjudge"}
													</button>
													{item.checkerMode === "text" && (
														<>
															<button
																type="button"
																disabled={!!exporting}
																onClick={() => void exportOne(item, "fps")}
															>
																FPS
															</button>
															<button
																type="button"
																disabled={!!exporting}
																onClick={() => void exportOne(item, "qduoj")}
															>
																QDUOJ
															</button>
														</>
													)}
												</>
											)}
											{!isContestReadyRelease(item) && <span>{t("旧版需重新验证后导出新格式")}</span>}
											{isContestReadyRelease(item) && item.scoringMode === "oi" && (
												<span>{t("竞赛仅 Hydro")}</span>
											)}
											{isContestReadyRelease(item) &&
												item.scoringMode === "acm" &&
												item.checkerMode === "custom" && (
													<span>{t("FPS / QDUOJ 不支持自定义 Checker")}</span>
												)}
											<a
												href={apiUrl(props.apiOrigin, `/releases/${item.id}/report`)}
												target="_blank"
												rel="noreferrer"
											>
												{t("报告")}
											</a>
										</div>
									</td>
									<td>
										<button className="danger" type="button" onClick={() => setPendingReleaseDelete(item)}>
											{t("删除包")}
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
					{props.releases.length === 0 && (
						<p className="manual-muted history-empty">{t("暂无通过完整验证的发布包。")}</p>
					)}
				</div>
			</section>
			{pendingDelete && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="delete-project-title"
					>
						<div className="confirmation-heading">
							<span>{t("删除确认")}</span>
							<h2 id="delete-project-title">{t("删除“{0}”？", pendingDelete.title || t("未命名题目"))}</h2>
						</div>
						<p>{t("这会删除草稿、测试数据与该项目的所有发布包，无法撤销；被竞赛草稿引用时须先移出。")}</p>
						<code>{pendingDelete.id}</code>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setPendingDelete(undefined)}>
								{t("取消")}
							</button>
							<button
								className="button primary"
								type="button"
								onClick={() => {
									const id = pendingDelete.id;
									setPendingDelete(undefined);
									void props.onDelete(id);
								}}
							>
								{t("确认删除")}
							</button>
						</div>
					</div>
				</div>
			)}
			{pendingReleaseDelete && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="delete-release-title"
					>
						<div className="confirmation-heading">
							<span>{t("删除确认")}</span>
							<h2 id="delete-release-title">{t("删除“{0}”的这个发布包？", pendingReleaseDelete.title)}</h2>
						</div>
						<p>{t("历史下载地址将失效。被竞赛草稿引用的包不可删除。")}</p>
						<code>{pendingReleaseDelete.id}</code>
						<div className="confirmation-actions">
							<button
								className="button secondary"
								type="button"
								onClick={() => setPendingReleaseDelete(undefined)}
							>
								{t("取消")}
							</button>
							<button
								className="button primary"
								type="button"
								onClick={() => {
									const id = pendingReleaseDelete.id;
									setPendingReleaseDelete(undefined);
									void props.onDeleteRelease(id);
								}}
							>
								{t("确认删除")}
							</button>
						</div>
					</div>
				</div>
			)}
		</main>
	);
}
