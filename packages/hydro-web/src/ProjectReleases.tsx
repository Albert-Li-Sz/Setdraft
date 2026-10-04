import { problemTypeNames, requiresReverification, resolveProblemType } from "@setdraft/contracts";
import { useCallback, useEffect, useState } from "react";
import { authFetch } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
import {
	apiUrl,
	type BackgroundTask,
	isContestReadyRelease,
	type ManualRelease,
	requestJson,
	waitForTask,
} from "./platform.ts";

export function ProjectReleases({
	apiOrigin,
	projectId,
	busy,
	onRestore,
	onChanged,
}: {
	apiOrigin: string;
	projectId: string;
	busy: boolean;
	onRestore(release: ManualRelease): Promise<void>;
	onChanged(): void;
}) {
	const { t, locale } = useLocale();
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [loading, setLoading] = useState(true);
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState<UiMessage>("");
	const [action, setAction] = useState<{ kind: "rename" | "restore" | "delete"; release: ManualRelease }>();
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const refresh = useCallback(
		async (signal?: AbortSignal) => {
			setLoading(true);
			try {
				const result = await requestJson<{ releases: ManualRelease[] }>(
					apiUrl(apiOrigin, `/projects/${projectId}/releases`),
					{ signal },
				);
				if (!signal?.aborted) setReleases(result.releases);
			} catch (cause) {
				if (!signal?.aborted) setMessage(cause instanceof Error ? cause.message : "发布包读取失败。");
			} finally {
				if (!signal?.aborted) setLoading(false);
			}
		},
		[apiOrigin, projectId],
	);
	useEffect(() => {
		const controller = new AbortController();
		void refresh(controller.signal);
		return () => controller.abort();
	}, [refresh]);
	async function perform(): Promise<void> {
		if (!action || working) return;
		setWorking(true);
		setError("");
		try {
			if (action.kind === "restore") await onRestore(action.release);
			else if (action.kind === "rename")
				await requestJson(apiUrl(apiOrigin, `/releases/${action.release.id}`), {
					method: "PATCH",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ name }),
				});
			else {
				const response = await authFetch(apiUrl(apiOrigin, `/releases/${action.release.id}`), { method: "DELETE" });
				if (!response.ok) {
					const value = (await response.json()) as { message?: string };
					throw new Error(value.message ?? "删除发布包失败。");
				}
			}
			setAction(undefined);
			setMessage(
				action.kind === "restore"
					? "已回退到所选发布包；发布历史已保留。"
					: action.kind === "rename"
						? "发布包已重命名。"
						: "发布包已删除。",
			);
			await refresh();
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "操作失败。");
		} finally {
			setWorking(false);
		}
	}
	async function exportOne(release: ManualRelease, format: "domjudge" | "fps" | "qduoj"): Promise<void> {
		setWorking(true);
		setMessage("正在导出…");
		try {
			const submitted = await requestJson<{ download: string } | { task: BackgroundTask }>(
				apiUrl(apiOrigin, `/releases/${release.id}/exports/${format}`),
				{ method: "POST" },
			);
			const result =
				"task" in submitted ? await waitForTask<{ download: string }>(apiOrigin, submitted.task.id) : submitted;
			window.location.href = apiUrl(apiOrigin, result.download.replace(/^\/api/u, ""));
			setMessage(uiMessage("{0} 包已生成。", format.toUpperCase()));
		} catch (cause) {
			setMessage(cause instanceof Error ? cause.message : "导出失败。");
		} finally {
			setWorking(false);
		}
	}
	return (
		<section className="project-releases">
			<div className="manual-section-heading">
				<div>
					<h2>{t("已验证发布包")}</h2>
					<p>{t("为每次发布命名，随时恢复到当时的完整题目。")}</p>
				</div>
				<button
					className="button secondary"
					type="button"
					disabled={loading || working || busy}
					onClick={() => void refresh()}
				>
					{t("刷新")}
				</button>
			</div>
			{message && <output className="notice pending">{t(message)}</output>}
			{!releases.length && (
				<EmptyState
					icon="layers"
					title={t(loading ? "正在读取发布包…" : "暂无发布包")}
					description={t("完整验证通过后，发布包会保存在这里。")}
				/>
			)}
			<div className="release-list">
				{releases.map((release) => (
					<article className="release-card" key={release.id}>
						<div className="release-card-heading">
							<div>
								<h3>{release.name || `v${release.revision}`}</h3>
								<p>
									{t(problemTypeNames[resolveProblemType(release)])} · {release.scoringMode.toUpperCase()} ·{" "}
									{t("版本 {0} · {1} 个测试点", release.revision, release.report.caseCount)} ·{" "}
									{new Date(release.createdAt).toLocaleString(locale)}
								</p>
							</div>
							<span className="release-verified">
								{t(requiresReverification(release) ? "历史报告 · 须重新验证" : "已验证")}
							</span>
						</div>
						<div className="release-card-actions">
							<div className="history-actions">
								<a href={apiUrl(apiOrigin, `/releases/${release.id}/hydro`)} download>
									{t("Hydro 包")}
									{requiresReverification(release) && ` · ${t("原历史包")}`}
								</a>
								<a href={apiUrl(apiOrigin, `/releases/${release.id}/source`)} download>
									{t("制题工程")}
								</a>
								<a href={apiUrl(apiOrigin, `/releases/${release.id}/report`)} target="_blank" rel="noreferrer">
									{t("报告")}
								</a>
								{isContestReadyRelease(release) && release.scoringMode === "acm" && (
									<>
										<button
											type="button"
											disabled={working || busy}
											onClick={() => void exportOne(release, "domjudge")}
										>
											DOMjudge
										</button>
										{resolveProblemType(release) === "standard" && (
											<>
												<button
													type="button"
													disabled={working || busy}
													onClick={() => void exportOne(release, "fps")}
												>
													FPS
												</button>
												<button
													type="button"
													disabled={working || busy}
													onClick={() => void exportOne(release, "qduoj")}
												>
													QDUOJ
												</button>
											</>
										)}
										{resolveProblemType(release) === "communication" && (
											<>
												<button
													type="button"
													disabled
													title={t("通信题暂不支持 FPS／QDUOJ，请使用 Hydro 或 DOMjudge。")}
												>
													FPS
												</button>
												<button
													type="button"
													disabled
													title={t("通信题暂不支持 FPS／QDUOJ，请使用 Hydro 或 DOMjudge。")}
												>
													QDUOJ
												</button>
											</>
										)}
									</>
								)}
							</div>
							<div className="history-actions">
								{(["rename", "restore", "delete"] as const).map((kind) => (
									<button
										key={kind}
										type="button"
										className={kind === "delete" ? "danger" : undefined}
										disabled={working || busy}
										onClick={() => {
											setAction({ kind, release });
											setName(release.name || `v${release.revision}`);
											setError("");
										}}
									>
										{t(kind === "rename" ? "重命名" : kind === "restore" ? "回退到此版本" : "删除包")}
									</button>
								))}
							</div>
						</div>
						{resolveProblemType(release) === "communication" && (
							<p className="manual-muted">{t("通信题暂不支持 FPS／QDUOJ，请使用 Hydro 或 DOMjudge。")}</p>
						)}
					</article>
				))}
			</div>
			<Dialog
				open={!!action}
				onClose={() => {
					if (!working) setAction(undefined);
				}}
				labelledBy="release-action-title"
			>
				<form
					className="account-form"
					onSubmit={(event) => {
						event.preventDefault();
						void perform();
					}}
				>
					<div className="confirmation-heading">
						<h2 id="release-action-title">
							{t(
								action?.kind === "rename"
									? "重命名发布包"
									: action?.kind === "restore"
										? "回退到此版本"
										: "删除发布包",
							)}
						</h2>
					</div>
					{action?.kind === "rename" ? (
						<label>
							{t("发布包名称")}
							<input
								value={name}
								onChange={(event) => setName(event.target.value)}
								maxLength={80}
								required
								disabled={working}
							/>
						</label>
					) : (
						<>
							<p>
								<strong>{action?.release.name || `v${action?.release.revision}`}</strong>
							</p>
							<p>
								{t(
									action?.kind === "restore"
										? "将替换当前题面、代码、附件和测试数据。尚未发布的修改会被覆盖，已有发布包全部保留。"
										: "历史下载地址将失效。被竞赛引用的发布包不可删除。",
								)}
							</p>
						</>
					)}
					{error && (
						<output className="auth-error" role="alert">
							{t(error)}
						</output>
					)}
					<div className="confirmation-actions">
						<button
							className="button secondary"
							type="button"
							disabled={working}
							onClick={() => setAction(undefined)}
						>
							{t("取消")}
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={working || busy || (action?.kind === "rename" && !name.trim())}
						>
							{t(
								working
									? "处理中…"
									: action?.kind === "rename"
										? "保存"
										: action?.kind === "restore"
											? "确认回退"
											: "确认删除",
							)}
						</button>
					</div>
				</form>
			</Dialog>
		</section>
	);
}
