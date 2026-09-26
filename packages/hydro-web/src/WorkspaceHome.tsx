import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import type { ProjectSnapshot, SandboxStatus } from "./platform.ts";

const shortcuts = [
	{ href: "#records", icon: "files", label: "制题记录", description: "草稿与发布包" },
	{ href: "#chat", icon: "chat", label: "AI 对话", description: "题目讨论与代码分析" },
	{ href: "#contests", icon: "layers", label: "竞赛", description: "组题与竞赛包导出" },
] as const;

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
	const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
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
			<section className="home-heading">
				<div>
					<div className="home-location">
						<Icon name="grid" />
						{t("本地工作区")}
					</div>
					<h1>{t("工作台")}</h1>
					<p>{t("管理题目、测试数据与发布包。")}</p>
				</div>
				<button className="button primary" type="button" onClick={onNew}>
					<Icon name="plus" />
					{t("新建题目")}
				</button>
			</section>
			<section className="home-shortcuts" aria-label={t("快捷入口")}>
				{shortcuts.map((shortcut) => (
					<a className="home-shortcut" href={shortcut.href} key={shortcut.href}>
						<span className="shortcut-icon">
							<Icon name={shortcut.icon} />
						</span>
						<div>
							<h2>{t(shortcut.label)}</h2>
							<p>{t(shortcut.description)}</p>
						</div>
						<Icon name="arrow" className="shortcut-arrow" />
					</a>
				))}
			</section>
			<div className="home-layout">
				<section className="card home-projects">
					<div className="home-section-heading">
						<h2>
							{t("最近草稿")}
							<span>{projects.length}</span>
						</h2>
						<a href="#records">
							{t("查看全部")}
							<Icon name="arrow" />
						</a>
					</div>
					{message && (
						<output className="notice failed" role="alert">
							{t(message)}
						</output>
					)}
					{recent.length > 0 ? (
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
									<span className="project-file-icon">
										<Icon name="file" />
									</span>
									<span className="project-row-copy">
										<strong>{project.title || t("未命名题目")}</strong>
										<small className="project-row-meta">
											{project.scoringMode.toUpperCase()}
											<span>·</span>
											{t("测试点 {0}", project.cases.length)}
											<span>·</span>
											{t("版本 {0}", project.revision)}
										</small>
									</span>
									<time dateTime={project.updatedAt}>
										{new Date(project.updatedAt).toLocaleDateString(locale, {
											month: "short",
											day: "numeric",
										})}
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
							<Icon name="files" />
							<h3>{t("暂无草稿")}</h3>
							<p>{t("新建题目后，草稿将显示在这里。")}</p>
						</div>
					)}
				</section>
				<aside className="home-side">
					<section className="card home-environment">
						<div className="home-environment-heading">
							<span className="environment-icon">
								<Icon name="terminal" />
							</span>
							<h2>{t("运行环境")}</h2>
						</div>
						<dl>
							<div>
								<dt>{t("本地沙箱")}</dt>
								<dd>
									<span className={`environment-dot ${sandbox?.available ? "ready" : ""}`} />
									{sandbox?.available ? t("已就绪") : sandbox ? t("未就绪") : t("检测中")}
								</dd>
							</div>
							<div>
								<dt>{t("数据存储")}</dt>
								<dd>{t("本机")}</dd>
							</div>
							<div>
								<dt>{t("支持赛制")}</dt>
								<dd>ACM / OI</dd>
							</div>
						</dl>
						<a className="home-settings-link" href="#settings">
							{t("环境设置")}
							<Icon name="arrow" />
						</a>
					</section>
					<a href="#tasks" className="card home-task-link">
						<span className="shortcut-icon">
							<Icon name="activity" />
						</span>
						<span>
							<strong>{t("任务状态")}</strong>
							<small className="home-task-caption">{t("查看后台任务进度")}</small>
						</span>
						<Icon name="arrow" className="shortcut-arrow" />
					</a>
				</aside>
			</div>
		</main>
	);
}
