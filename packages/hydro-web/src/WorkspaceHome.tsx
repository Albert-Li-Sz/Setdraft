import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import type { ProjectSnapshot, SandboxStatus } from "./platform.ts";

export function WorkspaceHome({
	projects,
	sandbox,
	message,
	onNew,
	onOpen,
}: {
	projects: ProjectSnapshot[];
	sandbox?: SandboxStatus;
	message?: UiMessage;
	onNew(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { t, locale } = useLocale();
	const [opening, setOpening] = useState<string>();
	const [query, setQuery] = useState("");
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
				<h1>{t("工作台")}</h1>
				<span>{t("本地工作区")}</span>
			</div>
			<button className="home-create" type="button" onClick={onNew}>
				<Icon name="compose" />
				<span>
					<strong>{t("新建题目")}</strong>
					<small>ACM / OI</small>
				</span>
				<Icon name="plus" />
			</button>
			<div className="home-quick-links">
				<a href="#records">
					<Icon name="files" />
					{t("制题记录")}
				</a>
				<a href="#chat">
					<Icon name="chat" />
					{t("AI 对话")}
				</a>
				<a href="#contests">
					<Icon name="layers" />
					{t("竞赛")}
				</a>
			</div>
			<section className="home-projects">
				<div className="home-section-heading">
					<h2>
						{t("最近草稿")}
						<span>{projects.length}</span>
					</h2>
					<label className="home-search">
						<Icon name="search" />
						<input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							aria-label={t("搜索草稿")}
							placeholder={t("搜索题目")}
						/>
					</label>
				</div>
				{message && (
					<output className="notice failed" role="alert">
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
					<div className="home-empty">
						<Icon name={query.trim() ? "search" : "files"} />
						<h3>{query.trim() ? t("没有匹配的题目") : t("暂无草稿")}</h3>
						<p>{query.trim() ? t("试试其他关键词。") : t("新建题目后，草稿将显示在这里。")}</p>
					</div>
				)}
				{projects.length > 8 && (
					<a className="home-all" href="#records">
						{t("查看全部")}
						<Icon name="arrow" />
					</a>
				)}
			</section>
			<div className="home-status">
				<a href="#settings">
					<Icon name="terminal" />
					{sandbox?.available ? t("本地沙箱就绪") : sandbox ? t("沙箱尚未就绪") : t("正在连接工作区")}
				</a>
				<span>·</span>
				<span>{t("数据保存在本机")}</span>
			</div>
		</main>
	);
}
