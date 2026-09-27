import { useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { authFetch } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
import {
	apiUrl,
	type BackgroundTask,
	type ContestDraft,
	type ContestRelease,
	isContestReadyRelease,
	type ManualRelease,
	responseError,
	waitForTask,
} from "./platform.ts";

const defaultBalloons = [
	{ name: "Red", rgb: "#EF4444" },
	{ name: "Orange", rgb: "#F59E0B" },
	{ name: "Green", rgb: "#22C55E" },
	{ name: "Cyan", rgb: "#06B6D4" },
	{ name: "Indigo", rgb: "#6366F1" },
	{ name: "Purple", rgb: "#A855F7" },
];

function BalloonEditor(props: {
	name: string;
	rgb: string;
	disabled: boolean;
	title: string;
	onSave(name: string, rgb: string): void;
}) {
	const { t } = useLocale();
	const [name, setName] = useState(props.name);
	const [rgb, setRgb] = useState(props.rgb);
	useEffect(() => {
		setName(props.name);
		setRgb(props.rgb);
	}, [props.name, props.rgb]);
	return (
		<div className="contest-balloon-fields">
			<label className="field">
				<span>{t("颜色名称")}</span>
				<input
					aria-label={t("{0} 气球颜色名称", props.title)}
					value={name}
					maxLength={40}
					disabled={props.disabled}
					onChange={(event) => setName(event.target.value)}
				/>
			</label>
			<label className="field">
				<span>RGB</span>
				<input
					type="color"
					aria-label={t("{0} 气球 RGB", props.title)}
					value={rgb}
					disabled={props.disabled}
					onChange={(event) => setRgb(event.target.value)}
				/>
			</label>
			<button
				type="button"
				disabled={props.disabled || (name === props.name && rgb.toUpperCase() === props.rgb.toUpperCase())}
				onClick={() => props.onSave(name.trim(), rgb)}
			>
				{t("保存颜色")}
			</button>
		</div>
	);
}

function ContestDetails({
	contest,
	disabled,
	onSave,
}: {
	contest: ContestDraft;
	disabled: boolean;
	onSave(value: ContestDraft): void;
}) {
	const { t } = useLocale();
	const [title, setTitle] = useState(contest.title);
	const [slug, setSlug] = useState(contest.slug);
	useEffect(() => {
		setTitle(contest.title);
		setSlug(contest.slug);
	}, [contest.title, contest.slug]);
	return (
		<form
			className="contest-details-form"
			onSubmit={(event) => {
				event.preventDefault();
				onSave({ ...contest, title: title.trim(), slug: slug.trim() });
			}}
		>
			<label className="field">
				<span>{t("竞赛名称")}</span>
				<input
					required
					maxLength={160}
					disabled={disabled}
					value={title}
					onChange={(event) => setTitle(event.target.value)}
				/>
			</label>
			<label className="field">
				<span>{t("竞赛标识")}</span>
				<input
					required
					maxLength={80}
					disabled={disabled}
					value={slug}
					onChange={(event) => setSlug(event.target.value)}
				/>
			</label>
			<button
				className="button secondary"
				type="submit"
				disabled={disabled || !title.trim() || !slug.trim() || (title === contest.title && slug === contest.slug)}
			>
				{t("保存竞赛")}
			</button>
		</form>
	);
}

function labelAt(index: number): string {
	let number = index + 1;
	let label = "";
	while (number > 0) {
		number -= 1;
		label = String.fromCharCode(65 + (number % 26)) + label;
		number = Math.floor(number / 26);
	}
	return label;
}

interface Props {
	apiOrigin: string;
}

export function ContestsPage({ apiOrigin }: Props) {
	const { t, locale } = useLocale();
	const [contests, setContests] = useState<ContestDraft[]>([]);
	const [draft, setDraft] = useState<ContestDraft>();
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [bundles, setBundles] = useState<ContestRelease[]>([]);
	const [title, setTitle] = useState("");
	const [slug, setSlug] = useState("");
	const [candidateId, setCandidateId] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<UiMessage>("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState<string>();
	const [exportFormat, setExportFormat] = useState<"hydro" | "domjudge">();
	const [bundleName, setBundleName] = useState("");

	useEffect(() => {
		let cancelled = false;
		void Promise.all([
			requestJson<{ contests: ContestDraft[] }>(apiUrl(apiOrigin, "/contests")),
			requestJson<{ releases: ManualRelease[] }>(apiUrl(apiOrigin, "/releases")),
			requestJson<{ releases: ContestRelease[] }>(apiUrl(apiOrigin, "/contest-releases")),
		])
			.then(([contestResult, problemResult, bundleResult]) => {
				if (cancelled) return;
				setContests(contestResult.contests);
				setReleases(problemResult.releases);
				setBundles(bundleResult.releases);
				setDraft(
					(current) => contestResult.contests.find((item) => item.id === current?.id) ?? contestResult.contests[0],
				);
			})
			.catch((error: unknown) => {
				if (!cancelled) setMessage(error instanceof Error ? error.message : "竞赛记录读取失败。");
			});
		return () => {
			cancelled = true;
		};
	}, [apiOrigin]);

	async function create(): Promise<void> {
		setBusy(true);
		try {
			const created = await requestJson<ContestDraft>(apiUrl(apiOrigin, "/contests"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ title, slug }),
			});
			setContests((items) => [created, ...items]);
			setDraft(created);
			setTitle("");
			setSlug("");
			setCreateOpen(false);
			setMessage("竞赛已创建，选择已验证的题目版本加入。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "新建竞赛失败。");
		} finally {
			setBusy(false);
		}
	}

	async function update(next: ContestDraft): Promise<void> {
		setBusy(true);
		try {
			const saved = await requestJson<ContestDraft>(apiUrl(apiOrigin, `/contests/${next.id}`), {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: next.revision,
					title: next.title,
					slug: next.slug,
					releaseIds: next.releaseIds,
					colors: next.colors,
					colorNames: next.colorNames,
				}),
			});
			setDraft(saved);
			setContests((items) => items.map((item) => (item.id === saved.id ? saved : item)));
			setMessage("竞赛已保存。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "保存竞赛失败。");
		} finally {
			setBusy(false);
		}
	}

	async function exportBundle(format: "hydro" | "domjudge"): Promise<void> {
		if (!draft || !bundleName.trim()) return;
		setExportFormat(undefined);
		setBusy(true);
		setMessage("正在整理已验证的题包…");
		try {
			const accepted = await requestJson<{ task: BackgroundTask }>(
				apiUrl(apiOrigin, `/contests/${draft.id}/export`),
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ format, name: bundleName.trim() }),
				},
			);
			const result = await waitForTask<ContestRelease>(apiOrigin, accepted.task.id);
			setBundles((items) => [result, ...items]);
			setHistoryOpen(result.contestId);
			setMessage(uiMessage("{0} 竞赛包已生成，可在下方下载。", format === "hydro" ? "Hydro" : "DOMjudge"));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "竞赛导出失败。");
		} finally {
			setBusy(false);
		}
	}

	async function remove(): Promise<void> {
		if (!draft) return;
		setBusy(true);
		try {
			const response = await authFetch(apiUrl(apiOrigin, `/contests/${draft.id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			const remaining = contests.filter((item) => item.id !== draft.id);
			setContests(remaining);
			setDraft(remaining[0]);
			setDeleteOpen(false);
			setMessage("竞赛已删除。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "删除竞赛失败。");
		} finally {
			setBusy(false);
		}
	}

	const selected =
		draft?.releaseIds
			.map((id) => releases.find((item) => item.id === id))
			.filter((item): item is ManualRelease => !!item) ?? [];
	const allAcm = selected.every((item) => item.scoringMode === "acm");
	const allReady = selected.length === (draft?.releaseIds.length ?? 0) && selected.every(isContestReadyRelease);
	const selectedProjectIds = new Set(selected.map((item) => item.projectId));
	const candidates = releases.filter((item) => isContestReadyRelease(item) && !selectedProjectIds.has(item.projectId));
	const oldReleaseCount = releases.filter((item) => !isContestReadyRelease(item)).length;
	const history = bundles.filter((item) => item.contestId === historyOpen);
	const archived = [
		...new Map(
			bundles
				.filter((item) => !contests.some((contest) => contest.id === item.contestId))
				.map((item) => [item.contestId, item]),
		).values(),
	];

	return (
		<main className="page" id="contests">
			<section className="page-heading">
				<div>
					<h1>{t("竞赛列表")}</h1>
					<p>{t("Hydro 包可包含 ACM 和 OI 题；DOMjudge 包仅接受 ACM 题。竞赛赛程在目标平台设置。")}</p>
				</div>
				<div className="heading-actions">
					<button
						className="button primary"
						type="button"
						onClick={() => {
							setTitle("");
							setSlug("");
							setCreateOpen(true);
						}}
					>
						{t("新建竞赛")}
					</button>
				</div>
			</section>
			{message && (
				<output className="notice pending" aria-live="polite">
					<span className="notice-dot" />
					{t(message)}
				</output>
			)}
			<div className="contest-layout">
				<aside className="card contest-sidebar">
					<h2>{t("竞赛列表")}</h2>
					<div className="contest-list">
						{contests.map((item) => (
							<button
								key={item.id}
								className={item.id === draft?.id ? "active" : ""}
								disabled={busy}
								type="button"
								onClick={() => {
									setDraft(item);
									setCandidateId("");
								}}
							>
								<strong>{item.title}</strong>
								<small>{t("题目数量：{0}", item.releaseIds.length)}</small>
							</button>
						))}
						{archived.map((item) => (
							<button type="button" key={item.contestId} onClick={() => setHistoryOpen(item.contestId)}>
								<strong>{item.title}</strong>
								<small>{t("已删除竞赛 · 查看历史包")}</small>
							</button>
						))}
						{contests.length === 0 && <p className="manual-muted">{t("暂无竞赛。")}</p>}
					</div>
				</aside>
				<section className="card contest-main">
					{draft ? (
						<>
							<div className="manual-section-heading">
								<div>
									<h2>{draft.title}</h2>
									<p>
										{draft.slug} · {t("题目数量：{0}", selected.length)}
									</p>
								</div>
								<button className="button secondary" type="button" onClick={() => setHistoryOpen(draft.id)}>
									{t("历史竞赛包")} · {bundles.filter((item) => item.contestId === draft.id).length}
								</button>
								<button
									disabled={busy}
									className="text-button danger"
									type="button"
									onClick={() => setDeleteOpen(true)}
								>
									{t("删除竞赛")}
								</button>
							</div>
							<ContestDetails
								key={draft.id}
								contest={draft}
								disabled={busy}
								onSave={(next) => void update(next)}
							/>
							<div className="contest-add-row">
								<select
									aria-label={t("选择已验证题目")}
									value={candidateId}
									onChange={(event) => setCandidateId(event.target.value)}
								>
									<option value="">{t("选择已发布题目…")}</option>
									{candidates.map((item) => (
										<option key={item.id} value={item.id}>
											{item.title} · {item.scoringMode?.toUpperCase()} · {item.name || `v${item.revision}`}
										</option>
									))}
								</select>
								<button
									className="button secondary"
									type="button"
									disabled={busy || !candidateId}
									onClick={() => {
										if (!draft || !candidateId) return;
										void update({ ...draft, releaseIds: [...draft.releaseIds, candidateId] });
										setCandidateId("");
									}}
								>
									{t("加入题目")}
								</button>
							</div>
							{oldReleaseCount > 0 && (
								<p className="manual-muted">
									{oldReleaseCount}
									{t("个旧发布版本需重新通过完整 Checker 验证后才能加入竞赛。")}
								</p>
							)}
							{selected.length === 0 ? (
								<p className="manual-muted">{t("尚未加入题目。请先在制题工作台完整验证并发布。")}</p>
							) : (
								<div className="history-table-wrap">
									<table className="history-table">
										<thead>
											<tr>
												<th>{t("题序")}</th>
												<th>{t("题目版本")}</th>
												<th>{t("赛制")}</th>
												<th>{t("气球颜色")}</th>
												<th>{t("操作")}</th>
											</tr>
										</thead>
										<tbody>
											{selected.map((item, index) => (
												<tr key={item.id}>
													<td>
														<strong>{labelAt(index)}</strong>
													</td>
													<td>
														<strong>{item.title}</strong>
														<code>
															{item.slug} · {item.name || `v${item.revision}`}
														</code>
													</td>
													<td>{item.scoringMode?.toUpperCase() ?? t("旧版")}</td>
													<td>
														{item.scoringMode === "acm" ? (
															<BalloonEditor
																key={`${draft.id}:${item.id}`}
																title={item.title}
																name={
																	draft.colorNames[item.id] ??
																	defaultBalloons[index % defaultBalloons.length].name
																}
																rgb={
																	draft.colors[item.id] ??
																	defaultBalloons[index % defaultBalloons.length].rgb
																}
																disabled={busy}
																onSave={(name, rgb) =>
																	void update({
																		...draft,
																		colors: { ...draft.colors, [item.id]: rgb },
																		colorNames: { ...draft.colorNames, [item.id]: name },
																	})
																}
															/>
														) : (
															t("Hydro 专用")
														)}
													</td>
													<td>
														<div className="history-actions">
															<button
																type="button"
																disabled={busy || index === 0}
																onClick={() => {
																	const next = [...draft.releaseIds];
																	[next[index - 1], next[index]] = [next[index], next[index - 1]];
																	void update({ ...draft, releaseIds: next });
																}}
															>
																{t("上移")}
															</button>
															<button
																type="button"
																disabled={busy || index === selected.length - 1}
																onClick={() => {
																	const next = [...draft.releaseIds];
																	[next[index + 1], next[index]] = [next[index], next[index + 1]];
																	void update({ ...draft, releaseIds: next });
																}}
															>
																{t("下移")}
															</button>
															<button
																className="danger"
																type="button"
																disabled={busy}
																onClick={() => {
																	const colors = Object.fromEntries(
																		Object.entries(draft.colors).filter(([id]) => id !== item.id),
																	);
																	const colorNames = Object.fromEntries(
																		Object.entries(draft.colorNames).filter(([id]) => id !== item.id),
																	);
																	void update({
																		...draft,
																		releaseIds: draft.releaseIds.filter((id) => id !== item.id),
																		colors,
																		colorNames,
																	});
																}}
															>
																{t("移出")}
															</button>
														</div>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
							<div className="manual-release-actions">
								<button
									className="button primary"
									type="button"
									disabled={busy || selected.length === 0 || !allReady}
									onClick={() => {
										setBundleName("");
										setExportFormat("hydro");
									}}
								>
									{t("导出 Hydro 多题包")}
								</button>
								<button
									className="button secondary"
									type="button"
									disabled={busy || selected.length === 0 || !allReady || !allAcm}
									onClick={() => {
										setBundleName("");
										setExportFormat("domjudge");
									}}
								>
									{t("导出 DOMjudge 竞赛包")}
								</button>
							</div>
							{!allAcm && <p className="manual-muted">{t("当前包含 OI 题目，只能导出 Hydro 竞赛包。")}</p>}
							{!allReady && (
								<p className="manual-muted">{t("当前包含旧版或已删除的发布记录，请移出并重新发布题目。")}</p>
							)}
						</>
					) : (
						<EmptyState
							icon="layers"
							title={t("暂无竞赛。")}
							description={t("创建竞赛后，按题序加入已验证的题目。")}
						/>
					)}
				</section>
			</div>
			<Dialog open={!!exportFormat} onClose={() => setExportFormat(undefined)} labelledBy="contest-export-title">
				<form
					className="account-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (exportFormat) void exportBundle(exportFormat);
					}}
				>
					<h2 id="contest-export-title">{t("生成竞赛包")}</h2>
					<p>
						{draft?.title} · {exportFormat === "hydro" ? "Hydro" : "DOMjudge"}
					</p>
					<label>
						{t("竞赛包日志名称")}
						<input
							required
							maxLength={80}
							value={bundleName}
							onChange={(event) => setBundleName(event.target.value)}
							placeholder={t("例如：正式赛 / 修正测试数据")}
						/>
					</label>
					<div className="confirmation-actions">
						<button className="button secondary" type="button" onClick={() => setExportFormat(undefined)}>
							{t("取消")}
						</button>
						<button className="button primary" type="submit" disabled={busy || !bundleName.trim()}>
							{t("生成竞赛包")}
						</button>
					</div>
				</form>
			</Dialog>
			<Dialog
				open={createOpen}
				onClose={() => setCreateOpen(false)}
				labelledBy="contest-create-title"
				className="contest-create-dialog"
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void create();
					}}
				>
					<div className="confirmation-heading">
						<span>{t("竞赛")}</span>
						<h2 id="contest-create-title">{t("新建竞赛")}</h2>
					</div>
					<label className="field">
						<span>{t("竞赛名称")}</span>
						<input
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder={t("例如 校内练习赛")}
							required
						/>
					</label>
					<label className="field">
						<span>{t("目录标识")}</span>
						<input
							value={slug}
							onChange={(event) => setSlug(event.target.value)}
							placeholder={t("例如 practice-2026")}
							required
						/>
					</label>
					<p>{t("目录标识只使用字母、数字、点、下划线和连字符。")}</p>
					<div className="confirmation-actions">
						<button className="button secondary" type="button" onClick={() => setCreateOpen(false)}>
							{t("取消")}
						</button>
						<button className="button primary" type="submit" disabled={busy}>
							{busy ? t("创建中…") : t("创建竞赛")}
						</button>
					</div>
				</form>
			</Dialog>
			<Dialog
				open={!!historyOpen}
				onClose={() => setHistoryOpen(undefined)}
				labelledBy="contest-history-title"
				className="contest-history-dialog"
			>
				<div className="confirmation-heading">
					<span>{t("竞赛打包")}</span>
					<h2 id="contest-history-title">{t("历史竞赛包")}</h2>
				</div>
				<p>{t("与题目发布版本绑定；删除竞赛后仍可下载。")}</p>
				{history.length === 0 ? (
					<p className="manual-muted">{t("尚无历史竞赛包。")}</p>
				) : (
					<div className="contest-history-list">
						{history.map((item) => (
							<div className="contest-bundle" key={item.id}>
								<span>
									<strong>{item.name || item.title}</strong> · {item.format === "hydro" ? "Hydro" : "DOMjudge"}{" "}
									· {t("题目数量：{0}", item.problems.length)} ·
									{new Date(item.createdAt).toLocaleString(locale)}
								</span>
								<a
									className="button secondary button-link"
									href={apiUrl(apiOrigin, `/contest-releases/${item.id}/download`)}
									download={`${item.slug}.${item.format}.contest.zip`}
								>
									{t("下载")}
								</a>
							</div>
						))}
					</div>
				)}
				<div className="confirmation-actions">
					<button className="button secondary" type="button" onClick={() => setHistoryOpen(undefined)}>
						{t("关闭")}
					</button>
				</div>
			</Dialog>
			<Dialog
				open={deleteOpen && !!draft}
				onClose={() => setDeleteOpen(false)}
				labelledBy="contest-delete-title"
				role="alertdialog"
			>
				<div className="confirmation-heading">
					<span>{t("删除确认")}</span>
					<h2 id="contest-delete-title">{t("删除“{0}”？", draft?.title ?? "")}</h2>
				</div>
				<p>{t("将删除竞赛。历史上已导出的竞赛包仍可下载。")}</p>
				<div className="confirmation-actions">
					<button className="button secondary" type="button" onClick={() => setDeleteOpen(false)}>
						{t("取消")}
					</button>
					<button className="button primary" type="button" disabled={busy} onClick={() => void remove()}>
						{t("确认删除")}
					</button>
				</div>
			</Dialog>
		</main>
	);
}
