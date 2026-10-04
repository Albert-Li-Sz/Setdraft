import { problemTypeNames, resolveProblemType } from "@setdraft/contracts";
import { useMemo, useState } from "react";
import { EmptyState } from "./EmptyState.tsx";
import { Icon } from "./Icon.tsx";
import { type UiMessage, useLocale } from "./i18n.tsx";
import { LoadingState } from "./LoadingState.tsx";
import { matchesSearch } from "./list-search.ts";
import type { ProjectSnapshot, SandboxStatus } from "./platform.ts";

export function WorkspaceHome({
	administrator,
	projects,
	sandbox,
	message,
	messageTone,
	loading = false,
	busy = false,
	onNew,
	onOpen,
}: {
	administrator?: boolean;
	projects: ProjectSnapshot[];
	sandbox?: SandboxStatus;
	message?: UiMessage;
	messageTone: "passed" | "failed";
	loading?: boolean;
	busy?: boolean;
	onNew(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { t, locale } = useLocale();
	const [opening, setOpening] = useState<string>();
	const [query, setQuery] = useState("");
	const matches = useMemo(
		() =>
			projects
				.filter((project) =>
					matchesSearch(query, [
						project.title || t("未命名题目"),
						project.slug,
						project.scoringMode,
						resolveProblemType(project),
						t(problemTypeNames[resolveProblemType(project)]),
						...project.tags,
					]),
				)
				.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
		[projects, query, t],
	);
	const recent = matches.slice(0, 8);
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
				<span>{t("个人工作区")}</span>
			</div>
			<button className="home-create" type="button" onClick={onNew} disabled={busy || !!opening}>
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
					{t("题目中心")}
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
			<section className="home-projects" aria-busy={loading}>
				<div className="home-section-heading">
					<h2>
						{t(query.trim() ? "搜索结果" : "最近题目")}
						<span>{matches.length}</span>
					</h2>
					<label className="home-search">
						<Icon name="search" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							aria-label={t("搜索题目")}
							placeholder={t("搜索标题、标识或标签")}
							onKeyDown={(event) => {
								if (event.key === "Escape") setQuery("");
							}}
						/>
						{query && (
							<button
								type="button"
								className="icon-button"
								aria-label={t("清空搜索")}
								onClick={() => setQuery("")}
							>
								<Icon name="close" />
							</button>
						)}
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
								title={project.title || t("未命名题目")}
								key={project.id}
								disabled={busy || !!opening}
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
				) : loading ? (
					<LoadingState label={t("正在读取题目…")} />
				) : (
					<EmptyState
						icon={query.trim() ? "search" : "files"}
						title={query.trim() ? t("没有匹配的题目") : t("暂无题目")}
						description={query.trim() ? t("试试其他关键词。") : t("新建题目后，题目将显示在这里。")}
					/>
				)}
				{query && !recent.length && !loading && (
					<button type="button" className="button secondary list-reset" onClick={() => setQuery("")}>
						{t("清空搜索")}
					</button>
				)}
				{matches.length > 8 && (
					<a
						className="home-all"
						href={query.trim() ? `#records?${new URLSearchParams({ q: query.trim() })}` : "#records"}
					>
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
