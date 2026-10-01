import { splitMarkdownSections } from "@setdraft/authoring/markdown";
import { useState } from "react";
import guideMarkdown from "../../../docs/authoring-guide.md?raw";
import { Icon } from "./Icon.tsx";
import { useLocale } from "./i18n.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import "./authoring-guide.css";

const { introduction, sections: chapters } = (() => {
	try {
		return splitMarkdownSections(guideMarkdown);
	} catch {
		return { introduction: guideMarkdown, sections: [] };
	}
})();
const sections = chapters.map((chapter, index) => ({ ...chapter, id: `authoring-guide-section-${index + 1}` }));

export function AuthoringGuide() {
	const { t } = useLocale();
	const [query, setQuery] = useState("");
	const search = query.trim().toLocaleLowerCase();
	const visible = sections.filter((section) =>
		`${section.title}\n${section.body}`.toLocaleLowerCase().includes(search),
	);
	return (
		<main className="page authoring-guide">
			<div className="page-heading">
				<div>
					<h1>{t("出题文档")}</h1>
					<p>{t("从题面和数据到本地验证、发布与竞赛 PDF。")}</p>
				</div>
				<a className="button secondary button-link" href="#workspace">
					<Icon name="arrow" />
					{t("返回工作台")}
				</a>
			</div>
			<div className="authoring-guide-layout">
				<aside className="authoring-guide-sidebar">
					<label className="field">
						<span>{t("搜索文档")}</span>
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("按关键词查找配置与操作…")}
						/>
					</label>
					<output className="authoring-guide-count">
						{t(search ? "找到 {0} 个章节" : "共 {0} 个章节", visible.length)}
					</output>
					<nav className="authoring-guide-toc" aria-label={t("文档目录")}>
						{visible.map((section) => (
							<button
								type="button"
								key={section.id}
								aria-controls={section.id}
								onClick={() => {
									const target = document.getElementById(section.id);
									target?.scrollIntoView({ block: "start", behavior: "instant" });
									target?.focus({ preventScroll: true });
								}}
							>
								{section.title}
							</button>
						))}
					</nav>
				</aside>
				<article className="authoring-guide-content" lang="zh-CN">
					{!search && <MarkdownView profile="guide">{introduction.trim()}</MarkdownView>}
					{visible.length === 0 && <p className="authoring-guide-empty">{t("未找到匹配章节。")}</p>}
					{visible.map((section) => (
						<section key={section.id} id={section.id} tabIndex={-1} aria-labelledby={`${section.id}-title`}>
							<h2 id={`${section.id}-title`}>{section.title}</h2>
							<MarkdownView
								profile="guide"
								components={{
									a: ({ children, href }) => (
										<a href={href} target="_blank" rel="noreferrer">
											{children}
										</a>
									),
								}}
							>
								{section.body}
							</MarkdownView>
						</section>
					))}
				</article>
			</div>
		</main>
	);
}
