import { useState } from "react";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import type { ManualRelease, ProjectSnapshot } from "./platform.ts";

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
	const [query, setQuery] = useState("");
	const [pendingDelete, setPendingDelete] = useState<ProjectSnapshot>();
	const search = query.trim().toLocaleLowerCase();
	const projects = props.projects.filter((item) =>
		[item.title, item.slug, ...item.tags].join(" ").toLocaleLowerCase().includes(search),
	);
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
					{t(props.loading ? "刷新中…" : "刷新")}
				</button>
			</section>
			<div className="problem-center-toolbar">
				<span>{t("{0} 道题目", projects.length)}</span>
				<label className="problem-search">
					<Icon name="search" />
					<input
						type="search"
						aria-label={t("搜索题目")}
						placeholder={t("搜索标题、标识或标签")}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</label>
			</div>
			{props.message && <output className={`notice ${props.tone}`}>{t(props.message)}</output>}
			<div className="problem-list" aria-busy={props.loading}>
				{projects.map((project) => (
					<article className="problem-row" key={project.id}>
						<button
							className="problem-row-main"
							type="button"
							disabled={props.busy}
							onClick={() => void props.onOpen(project.id)}
						>
							<span className="problem-row-icon">
								<Icon name="file" />
							</span>
							<span className="problem-row-content">
								<strong>{project.title || t("未命名题目")}</strong>
								<span>
									{project.scoringMode.toUpperCase()} · {project.slug || t("未设置标识")} ·{" "}
									{t("{0} 个测试点", project.cases.length)} ·{" "}
									{t(
										"{0} 个发布包",
										props.releases.filter((release) => release.projectId === project.id).length,
									)}
								</span>
								{project.tags.length > 0 && (
									<span className="problem-tags">
										{project.tags.map((tag) => (
											<span key={tag}>{tag}</span>
										))}
									</span>
								)}
							</span>
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
				{!projects.length && (
					<div className="home-empty">
						<Icon name="files" />
						<h3>{t(search ? "没有匹配的题目" : props.loading ? "正在读取题目…" : "暂无题目")}</h3>
						<p>{t(search ? "试试其他标题、标识或标签。" : "新建题目后，会显示在这里。")}</p>
					</div>
				)}
			</div>
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
