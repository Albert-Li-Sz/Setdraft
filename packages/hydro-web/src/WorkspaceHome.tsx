import { problemTypeNames, resolveProblemType } from "@setdraft/contracts";
import { useState } from "react";
import { EmptyState } from "./EmptyState.tsx";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import type { ProjectSnapshot, SandboxStatus } from "./platform.ts";

export function WorkspaceHome({
	administrator,
	projects,
	sandbox,
	message,
	messageTone,
	onNew,
	onOpen,
}: {
	administrator?: boolean;
	projects: ProjectSnapshot[];
	sandbox?: SandboxStatus;
	message?: UiMessage;
	messageTone: "passed" | "failed";
	onNew(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { t, locale } = useLocale();
	const [opening, setOpening] = useState<string>();
	const [query, setQuery] = useState("");
	const caseCount = projects.reduce((total, project) => total + project.cases.length, 0);
	const publishedCount = projects.filter((project) => project.latestReleaseId).length;
	const recent = [...projects]
		.filter((project) =>
			(project.title || t("未命名题目")).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
		)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
		.slice(0, 8);
	async function open(id: string) {
		setOpening(id);
		try {
			await onOpen(id);
		} finally {
			setOpening(undefined);
		}
	}
	return (
		<main className="page workspace-home">
			<div className="home-heading">
				<div>
					<h1>{t("工作台")}</h1>
					<p>{t("撰写题面，构建数据，验证与发布。")}</p>
				</div>
				<span>{t("个人工作区")}</span>
			</div>
			<div className="home-entry">
				<button className="home-create" type="button" onClick={onNew}>
					<span className="home-create-mark" aria-hidden="true">
						<Icon name="compose" />
					</span>
					<span className="home-create-copy">
						<strong>{t("新建题目")}</strong>
						<small>{t("四种题型 · ACM / OI")}</small>
					</span>
					<span className="home-create-arrow" aria-hidden="true">
						<Icon name="plus" />
					</span>
				</button>
				<section className="home-overview" aria-label={t("工作区概览")}>
					<span className="home-summary-label">{t("工作区概览")}</span>
					<dl className="home-stats">
						<div>
							<dt>{t("题目数量")}</dt>
							<dd>{projects.length.toLocaleString(locale)}</dd>
						</div>
						<div>
							<dt>{t("测试点")}</dt>
							<dd>{caseCount.toLocaleString(locale)}</dd>
						</div>
						<div>
							<dt>{t("已发布题目")}</dt>
							<dd>{publishedCount.toLocaleString(locale)}</dd>
						</div>
					</dl>
				</section>
			</div>
			<div className="home-quick-links">
				<a href="#records">
					<Icon name="files" />
					<span>
						<strong>{t("题目中心")}</strong>
						<small>{t("管理题目与发布记录")}</small>
					</span>
					<Icon name="arrow" />
				</a>
				<a href="#chat">
					<Icon name="chat" />
					<span>
						<strong>{t("AI 对话")}</strong>
						<small>{t("讨论思路与搜索资料")}</small>
					</span>
					<Icon name="arrow" />
				</a>
				<a href="#contests">
					<Icon name="layers" />
					<span>
						<strong>{t("竞赛")}</strong>
						<small>{t("组织题目与导出题册")}</small>
					</span>
					<Icon name="arrow" />
				</a>
			</div>
			<section className="home-projects">
				<div className="home-section-heading">
					<h2>
						{t("最近题目")}
						<span>{projects.length}</span>
					</h2>
					<label className="home-search">
						<Icon name="search" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							aria-label={t("搜索题目")}
							placeholder={t("搜索题目")}
						/>
					</label>
				</div>
				{message && (
					<output className={`notice ${messageTone}`} role={messageTone === "failed" ? "alert" : undefined}>
						{t(message)}
					</output>
				)}
				{recent.length ? (
					<div className="home-project-list">
						{recent.map((project) => (
							<button
								type="button"
								className="home-project-row"
								key={project.id}
								disabled={!!opening}
								aria-busy={opening === project.id}
								onClick={() => void open(project.id)}
							>
								<Icon name="file" />
								<span className="project-row-copy">
									<strong>{project.title || t("未命名题目")}</strong>
									<small>
										{t(problemTypeNames[resolveProblemType(project)])}
										<span>·</span>
										{project.scoringMode.toUpperCase()}
										<span>·</span>
										{t("测试点 {0}", project.cases.length)}
									</small>
								</span>
								<time dateTime={project.updatedAt}>
									{new Date(project.updatedAt).toLocaleDateString(locale, { month: "short", day: "numeric" })}
								</time>
								<Icon
									name={opening === project.id ? "loader" : "arrow"}
									className={opening === project.id ? "loading-icon" : "project-row-arrow"}
								/>
							</button>
						))}
					</div>
				) : (
					<EmptyState
						icon={query.trim() ? "search" : "files"}
						title={query.trim() ? t("没有匹配的题目") : t("暂无题目")}
						description={query.trim() ? t("试试其他关键词。") : t("新建题目后，题目将显示在这里。")}
					/>
				)}
				{projects.length > 8 && (
					<a className="home-all" href="#records">
						{t("查看全部")}
						<Icon name="arrow" />
					</a>
				)}
			</section>
			<footer className="home-status">
				<a href={administrator ? "#admin" : undefined}>
					<Icon name="terminal" />
					{sandbox?.available ? t("本地沙箱就绪") : sandbox ? t("沙箱尚未就绪") : t("正在连接工作区")}
				</a>
				<span>·</span>
				<span>{t("数据按账号独立保存")}</span>
			</footer>
		</main>
	);
}
