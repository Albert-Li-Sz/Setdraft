import { useEffect, useState } from "react";
import {
	apiUrl,
	type ContestDraft,
	type ContestRelease,
	isContestReadyRelease,
	type ManualRelease,
	responseError,
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
	const [name, setName] = useState(props.name);
	const [rgb, setRgb] = useState(props.rgb);
	useEffect(() => {
		setName(props.name);
		setRgb(props.rgb);
	}, [props.name, props.rgb]);
	return (
		<div className="contest-balloon-fields">
			<label className="field">
				<span>颜色名称</span>
				<input
					aria-label={`${props.title} 气球颜色名称`}
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
					aria-label={`${props.title} 气球 RGB`}
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
				保存颜色
			</button>
		</div>
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

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const value = (await response.json()) as unknown;
	if (!response.ok) throw new Error(responseError(value));
	return value as T;
}

export function ContestsPage({ apiOrigin }: Props) {
	const [contests, setContests] = useState<ContestDraft[]>([]);
	const [draft, setDraft] = useState<ContestDraft>();
	const [releases, setReleases] = useState<ManualRelease[]>([]);
	const [bundles, setBundles] = useState<ContestRelease[]>([]);
	const [title, setTitle] = useState("");
	const [slug, setSlug] = useState("");
	const [candidateId, setCandidateId] = useState("");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);

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
			setMessage("竞赛草稿已创建，选择已验证的题目版本加入。");
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
					title: next.title,
					slug: next.slug,
					releaseIds: next.releaseIds,
					colors: next.colors,
					colorNames: next.colorNames,
				}),
			});
			setDraft(saved);
			setContests((items) => items.map((item) => (item.id === saved.id ? saved : item)));
			setMessage("竞赛题序与颜色已保存。");
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "保存竞赛失败。");
		} finally {
			setBusy(false);
		}
	}

	async function exportBundle(format: "hydro" | "domjudge"): Promise<void> {
		if (!draft) return;
		setBusy(true);
		setMessage("正在整理已验证的题包…");
		try {
			const result = await requestJson<ContestRelease>(apiUrl(apiOrigin, `/contests/${draft.id}/export`), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ format }),
			});
			setBundles((items) => [result, ...items]);
			setMessage(`${format === "hydro" ? "Hydro" : "DOMjudge"} 竞赛包已生成，可在下方下载。`);
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
			const response = await fetch(apiUrl(apiOrigin, `/contests/${draft.id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			const remaining = contests.filter((item) => item.id !== draft.id);
			setContests(remaining);
			setDraft(remaining[0]);
			setDeleteOpen(false);
			setMessage("竞赛草稿已删除。");
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

	return (
		<main className="page" id="contests">
			<div className="breadcrumb">题库 / 竞赛</div>
			<section className="page-heading">
				<div>
					<div className="eyebrow">已验证题目 · 题序 · 气球颜色</div>
					<h1>竞赛打包</h1>
					<p>Hydro 包可包含 ACM 和 OI 题；DOMjudge 包仅接受 ACM 题。竞赛赛程在目标平台设置。</p>
				</div>
				<div className="heading-actions">
					<button className="button secondary" type="button" onClick={() => setHistoryOpen(true)}>
						历史竞赛包
					</button>
					<button
						className="button primary"
						type="button"
						onClick={() => {
							setTitle("");
							setSlug("");
							setCreateOpen(true);
						}}
					>
						新建竞赛
					</button>
				</div>
			</section>
			{message && (
				<output className="notice pending" aria-live="polite">
					<span className="notice-dot" />
					{message}
				</output>
			)}
			<div className="contest-layout">
				<aside className="card contest-sidebar">
					<h2>竞赛草稿</h2>
					<div className="contest-list">
						{contests.map((item) => (
							<button
								key={item.id}
								className={item.id === draft?.id ? "active" : ""}
								type="button"
								onClick={() => {
									setDraft(item);
									setCandidateId("");
								}}
							>
								<strong>{item.title}</strong>
								<small>{item.releaseIds.length} 题</small>
							</button>
						))}
						{contests.length === 0 && <p className="manual-muted">暂无竞赛草稿。</p>}
					</div>
				</aside>
				<section className="card contest-main">
					{draft ? (
						<>
							<div className="manual-section-heading">
								<div>
									<h2>{draft.title}</h2>
									<p>
										{draft.slug} · {selected.length} 题
									</p>
								</div>
								<button className="text-button danger" type="button" onClick={() => setDeleteOpen(true)}>
									删除草稿
								</button>
							</div>
							<div className="contest-add-row">
								<select
									aria-label="选择已验证题目"
									value={candidateId}
									onChange={(event) => setCandidateId(event.target.value)}
								>
									<option value="">选择已发布题目…</option>
									{candidates.map((item) => (
										<option key={item.id} value={item.id}>
											{item.title} · {item.scoringMode?.toUpperCase()} · v{item.revision}
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
									加入题目
								</button>
							</div>
							{oldReleaseCount > 0 && (
								<p className="manual-muted">
									{oldReleaseCount} 个旧发布版本需重新通过完整 Checker 验证后才能加入竞赛。
								</p>
							)}
							{selected.length === 0 ? (
								<p className="manual-muted">尚未加入题目。请先在制题工作台完整验证并发布。</p>
							) : (
								<div className="history-table-wrap">
									<table className="history-table">
										<thead>
											<tr>
												<th>题序</th>
												<th>题目版本</th>
												<th>赛制</th>
												<th>气球颜色</th>
												<th>操作</th>
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
															{item.slug} · v{item.revision}
														</code>
													</td>
													<td>{item.scoringMode?.toUpperCase() ?? "旧版"}</td>
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
															"Hydro 专用"
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
																上移
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
																下移
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
																移出
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
									onClick={() => void exportBundle("hydro")}
								>
									导出 Hydro 多题包
								</button>
								<button
									className="button secondary"
									type="button"
									disabled={busy || selected.length === 0 || !allReady || !allAcm}
									onClick={() => void exportBundle("domjudge")}
								>
									导出 DOMjudge 竞赛包
								</button>
							</div>
							{!allAcm && <p className="manual-muted">当前包含 OI 题目，只能导出 Hydro 竞赛包。</p>}
							{!allReady && (
								<p className="manual-muted">当前包含旧版或已删除的发布记录，请移出并重新发布题目。</p>
							)}
						</>
					) : (
						<p className="manual-muted">创建竞赛后，按题序加入已验证的题目。</p>
					)}
				</section>
			</div>
			{createOpen && (
				<div className="confirmation-backdrop" role="presentation">
					<form
						className="card confirmation-dialog contest-create-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="contest-create-title"
						onSubmit={(event) => {
							event.preventDefault();
							void create();
						}}
					>
						<div className="confirmation-heading">
							<span>竞赛草稿</span>
							<h2 id="contest-create-title">新建竞赛</h2>
						</div>
						<label className="field">
							<span>竞赛名称</span>
							<input
								value={title}
								onChange={(event) => setTitle(event.target.value)}
								placeholder="例如 校内练习赛"
								required
							/>
						</label>
						<label className="field">
							<span>目录标识</span>
							<input
								value={slug}
								onChange={(event) => setSlug(event.target.value)}
								placeholder="例如 practice-2026"
								required
							/>
						</label>
						<p>目录标识只使用字母、数字、点、下划线和连字符。</p>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setCreateOpen(false)}>
								取消
							</button>
							<button className="button primary" type="submit" disabled={busy}>
								{busy ? "创建中…" : "创建竞赛"}
							</button>
						</div>
					</form>
				</div>
			)}
			{historyOpen && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog contest-history-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="contest-history-title"
					>
						<div className="confirmation-heading">
							<span>竞赛打包</span>
							<h2 id="contest-history-title">历史竞赛包</h2>
						</div>
						<p>与题目发布版本绑定；删除竞赛草稿后仍可下载。</p>
						{bundles.length === 0 ? (
							<p className="manual-muted">尚无历史竞赛包。</p>
						) : (
							<div className="contest-history-list">
								{bundles.map((item) => (
									<div className="contest-bundle" key={item.id}>
										<span>
											<strong>{item.title}</strong> · {item.format === "hydro" ? "Hydro" : "DOMjudge"} ·{" "}
											{item.problems.length} 题 · {new Date(item.createdAt).toLocaleString("zh-CN")}
										</span>
										<a
											className="button secondary button-link"
											href={apiUrl(apiOrigin, `/contest-releases/${item.id}/download`)}
											download={`${item.slug}.${item.format}.contest.zip`}
										>
											下载
										</a>
									</div>
								))}
							</div>
						)}
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setHistoryOpen(false)}>
								关闭
							</button>
						</div>
					</div>
				</div>
			)}
			{deleteOpen && draft && (
				<div className="confirmation-backdrop" role="presentation">
					<div
						className="card confirmation-dialog"
						role="alertdialog"
						aria-modal="true"
						aria-labelledby="contest-delete-title"
					>
						<div className="confirmation-heading">
							<span>删除确认</span>
							<h2 id="contest-delete-title">删除“{draft.title}”？</h2>
						</div>
						<p>将删除竞赛草稿。历史上已导出的竞赛包仍可下载。</p>
						<div className="confirmation-actions">
							<button className="button secondary" type="button" onClick={() => setDeleteOpen(false)}>
								取消
							</button>
							<button className="button primary" type="button" disabled={busy} onClick={() => void remove()}>
								确认删除
							</button>
						</div>
					</div>
				</div>
			)}
		</main>
	);
}
