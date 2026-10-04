import { type ProblemType, problemTypeNames, resolveProblemType } from "@setdraft/contracts";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "./Dialog.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { matchesSearch } from "./list-search.ts";
import type { ManualRelease, ProjectSnapshot } from "./platform.ts";
import { useLocationHash } from "./workspace-navigation.ts";

interface Props {
	projects: ProjectSnapshot[];
	releases: ManualRelease[];
	loading: boolean;
	busy: boolean;
	message: UiMessage;
	tone: "passed" | "failed";
	onRefresh(): Promise<void>;
	onOpen(id: string): Promise<void>;
	onDelete(id: string): Promise<void>;
	onCopy(project: ProjectSnapshot): void;
}

export function RecordsPage(props: Props) {
	const { t, locale } = useLocale();
	const hash = useLocationHash();
	const linkedQuery =
		hash.split("?")[0] === "#records" ? (new URLSearchParams(hash.split("?")[1]).get("q") ?? "") : "";
	const [query, setQuery] = useState(linkedQuery);
	const [scoringMode, setScoringMode] = useState("all");
	const [problemType, setProblemType] = useState<ProblemType | "all">("all");
	const [page, setPage] = useState(1);
	const [opening, setOpening] = useState<string>();
	const [pendingDelete, setPendingDelete] = useState<ProjectSnapshot>();
	const search = query.trim().toLocaleLowerCase();
	useEffect(() => {
		setQuery(linkedQuery);
		setPage(1);
	}, [linkedQuery]);
	const filtered = useMemo(
		() =>
			props.projects
				.filter(
					(item) =>
						(scoringMode === "all" || item.scoringMode === scoringMode) &&
						(problemType === "all" || resolveProblemType(item) === problemType) &&
						matchesSearch(query, [
							item.title || t("未命名题目"),
							item.slug,
							item.scoringMode,
							resolveProblemType(item),
							t(problemTypeNames[resolveProblemType(item)]),
							...item.tags,
						]),
				)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		[props.projects, scoringMode, problemType, query, t],
	);
	const releaseCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const release of props.releases) counts.set(release.projectId, (counts.get(release.projectId) ?? 0) + 1);
		return counts;
	}, [props.releases]);
	const pages = Math.max(1, Math.ceil(filtered.length / 25));
	const currentPage = Math.min(page, pages);
	const projects = filtered.slice((currentPage - 1) * 25, currentPage * 25);
	const changeQuery = (value: string) => {
		setQuery(value);
		setPage(1);
		const params = new URLSearchParams(window.location.hash.split("?")[1]);
		if (value) params.set("q", value);
		else params.delete("q");
		window.history.replaceState(null, "", `#records${params.size ? `?${params}` : ""}`);
	};
	const reset = () => {
		changeQuery("");
		setScoringMode("all");
		setProblemType("all");
		setPage(1);
	};
	const open = async (id: string) => {
		setOpening(id);
		try {
			await props.onOpen(id);
		} finally {
			setOpening(undefined);
		}
	};
	return (
		<main className="page problem-center" id="records">
			<section className="page-heading">
				<div>
					<h1>{t("题目中心")}</h1>
					<p>{t("管理题目，在题目内部查看和恢复发布包。")}</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() => void props.onRefresh()}
					disabled={props.loading}
				>
					<Icon
						name={props.loading ? "loader" : "resume"}
						className={props.loading ? "loading-icon" : undefined}
					/>
					{t(props.loading ? "刷新中…" : "刷新")}
				</button>
			</section>
			<div className="problem-center-toolbar list-toolbar">
				<output>{t("{0} 道题目", filtered.length)}</output>
				<select
					aria-label={t("筛选赛制")}
					value={scoringMode}
					onChange={(event) => {
						setScoringMode(event.target.value);
						setPage(1);
					}}
				>
					<option value="all">{t("全部赛制")}</option>
					<option value="acm">ACM</option>
					<option value="oi">OI</option>
				</select>
				<select
					aria-label={t("筛选题型")}
					value={problemType}
					onChange={(event) => {
						setProblemType(event.target.value as ProblemType | "all");
						setPage(1);
					}}
				>
					<option value="all">{t("全部题型")}</option>
					{Object.entries(problemTypeNames).map(([value, label]) => (
						<option key={value} value={value}>
							{t(label)}
						</option>
					))}
				</select>
				<label className="problem-search">
					<Icon name="search" />
					<input
						type="search"
						aria-label={t("搜索题目")}
						placeholder={t("搜索标题、标识或标签")}
						value={query}
						onChange={(event) => changeQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								changeQuery("");
							}
						}}
					/>
					{query && (
						<button
							type="button"
							className="icon-button"
							aria-label={t("清空搜索")}
							onClick={() => changeQuery("")}
						>
							<Icon name="close" />
						</button>
					)}
				</label>
			</div>
			{props.message && (
				<output className={`notice ${props.tone}`} role={props.tone === "failed" ? "alert" : undefined}>
					{t(props.message)}
				</output>
			)}
			<div className="problem-list" aria-busy={props.loading}>
				{projects.map((project) => (
					<article className="problem-row" key={project.id}>
						<button
							className="problem-row-main"
							type="button"
							disabled={props.busy || !!opening}
							aria-busy={opening === project.id}
							onClick={() => void open(project.id)}
						>
							<span className="problem-row-icon">
								<Icon name="file" />
							</span>
							<span className="problem-row-content">
								<strong>{project.title || t("未命名题目")}</strong>
								<span>
									{t(problemTypeNames[resolveProblemType(project)])} · {project.scoringMode.toUpperCase()} ·{" "}
									{project.slug || t("未设置标识")} · {t("{0} 个测试点", project.cases.length)} ·{" "}
									{t("{0} 个发布包", releaseCounts.get(project.id) ?? 0)}
								</span>
								{project.tags.length > 0 && (
									<span className="problem-tags">
										{project.tags.map((tag) => (
											<span key={tag}>{tag}</span>
										))}
									</span>
								)}
							</span>
							{opening === project.id && <Icon name="loader" className="loading-icon" />}
						</button>
						<div className="problem-row-end">
							<time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString(locale)}</time>
							<div className="history-actions">
								<button type="button" disabled={props.busy} onClick={() => props.onCopy(project)}>
									{t("复制给用户")}
								</button>
								<button
									type="button"
									className="danger"
									disabled={props.busy}
									onClick={() => setPendingDelete(project)}
								>
									{t("删除")}
								</button>
							</div>
						</div>
					</article>
				))}
				{!projects.length && props.loading ? (
					<LoadingState label={t("正在读取题目…")} />
				) : (
					!projects.length && (
						<EmptyState
							icon={search || scoringMode !== "all" || problemType !== "all" ? "search" : "files"}
							title={t(search || scoringMode !== "all" || problemType !== "all" ? "没有匹配的题目" : "暂无题目")}
							description={t(
								search || scoringMode !== "all" || problemType !== "all"
									? "调整筛选条件或清空搜索。"
									: "新建题目后，会显示在这里。",
							)}
						/>
					)
				)}
			</div>
			{(search || scoringMode !== "all" || problemType !== "all") && (
				<button type="button" className="text-button list-reset" onClick={reset}>
					{t("重置筛选")}
				</button>
			)}
			{pages > 1 && (
				<nav className="list-pagination" aria-label={t("题目分页")}>
					<span>
						{t(
							"显示 {0}–{1} / {2} 道题目",
							(currentPage - 1) * 25 + 1,
							Math.min(currentPage * 25, filtered.length),
							filtered.length,
						)}
					</span>
					<div>
						<button
							type="button"
							className="button secondary"
							disabled={currentPage === 1 || !!opening}
							onClick={() => setPage(currentPage - 1)}
						>
							{t("上一页")}
						</button>
						<span>
							{currentPage} / {pages}
						</span>
						<button
							type="button"
							className="button secondary"
							disabled={currentPage === pages || !!opening}
							onClick={() => setPage(currentPage + 1)}
						>
							{t("下一页")}
						</button>
					</div>
				</nav>
			)}
			<Dialog open={!!pendingDelete} onClose={() => setPendingDelete(undefined)} labelledBy="delete-project-title">
				<div className="confirmation-heading">
					<h2 id="delete-project-title">{t("删除“{0}”？", pendingDelete?.title || t("未命名题目"))}</h2>
				</div>
				<p>{t("这会删除题目、测试数据与所有发布包，无法撤销；被竞赛引用时须先移出。")}</p>
				<div className="confirmation-actions">
					<button className="button secondary" type="button" onClick={() => setPendingDelete(undefined)}>
						{t("取消")}
					</button>
					<button
						className="button primary"
						type="button"
						disabled={props.busy}
						onClick={() => {
							if (pendingDelete) void props.onDelete(pendingDelete.id);
							setPendingDelete(undefined);
						}}
					>
						{t("确认删除")}
					</button>
				</div>
			</Dialog>
		</main>
	);
}
