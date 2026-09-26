import { Icon } from "./Icon.tsx";
import { useLocale } from "./i18n.tsx";
import type { ProjectSnapshot, SandboxStatus } from "./platform.ts";

const workflowSteps = [
	{ number: "01", icon: "file", title: "写下题目", description: "用 Markdown 编写题面，整理样例与思路。" },
	{ number: "02", icon: "code", title: "打磨数据", description: "导入测试点，或用生成器覆盖每一种边界。" },
	{ number: "03", icon: "layers", title: "验证与发布", description: "在隔离沙箱中验证，导出可交付的题目包。" },
] as const;

export function WorkspaceHome({
	projects,
	sandbox,
	onNew,
	onOpen,
}: {
	projects: ProjectSnapshot[];
	sandbox?: SandboxStatus;
	onNew(): void;
	onOpen(id: string): Promise<void>;
}) {
	const { t, locale } = useLocale();
	const recent = [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);
	return (
		<main className="page studio-home">
			<section className="studio-hero">
				<div className="studio-intro">
					<div className="eyebrow">
						<span className="eyebrow-line" />
						{t("为出题者，留一处专注的空间")}
					</div>
					<h1>
						{t("把灵感，")}
						<br />
						<span>{t("写成好题。")}</span>
					</h1>
					<p className="studio-description">
						{t("从第一行题面，到最后一次验证。让创作井然有序，让每一道题都准备就绪。")}
					</p>
					<div className="studio-actions">
						<button className="button primary" type="button" onClick={onNew}>
							<Icon name="plus" />
							{t("新建题目")}
							<Icon name="arrow" />
						</button>
						<a className="studio-text-link" href="#records">
							{t("打开制题记录")}
							<span aria-hidden="true">↗</span>
						</a>
					</div>
					<div className="studio-meta">
						<span className={`service-dot ${sandbox?.available ? "ready" : ""}`} />
						{sandbox?.available ? t("本地沙箱就绪") : sandbox ? t("沙箱尚未就绪") : t("正在连接工作区")}
						<span className="meta-divider" />
						{t("数据保存在本机")}
					</div>
				</div>
				<div className="studio-object" aria-hidden="true">
					<div className="object-coordinate">HYDRO / 01</div>
					<div className="object-sheet object-sheet-back" />
					<div className="object-sheet object-sheet-middle" />
					<div className="object-sheet object-sheet-front">
						<div className="object-sheet-header">
							<span>PROBLEM / A</span>
							<Icon name="file" />
						</div>
						<div className="object-formula">
							a <span>+</span> b
						</div>
						<div className="object-lines">
							<i />
							<i />
							<i />
						</div>
						<div className="object-code">
							<span>01</span>
							<code>read(a, b)</code>
							<span>02</span>
							<code>return a + b</code>
						</div>
						<div className="object-sheet-footer">
							<span>INPUT → OUTPUT</span>
							<Icon name="check" />
						</div>
					</div>
					<div className="object-caption">
						<span />
						{t("每一步，都有依据。")}
					</div>
				</div>
			</section>
			<section className="studio-workflow" aria-label={t("制题流程")}>
				{workflowSteps.map((step) => (
					<div className="studio-step" key={step.number}>
						<div className="studio-step-top">
							<span>{step.number}</span>
							<Icon name={step.icon} />
						</div>
						<h2>{t(step.title)}</h2>
						<p>{t(step.description)}</p>
					</div>
				))}
			</section>
			{recent.length > 0 && (
				<section className="studio-recent">
					<div className="studio-section-heading">
						<h2>{t("继续创作")}</h2>
						<a href="#records">
							{t("全部草稿")} <span aria-hidden="true">↗</span>
						</a>
					</div>
					{recent.map((project) => (
						<button
							type="button"
							className="studio-recent-row"
							key={project.id}
							onClick={() => void onOpen(project.id)}
						>
							<Icon name="file" />
							<strong>{project.title || t("未命名题目")}</strong>
							<span>{project.scoringMode.toUpperCase()}</span>
							<time dateTime={project.updatedAt}>{new Date(project.updatedAt).toLocaleDateString(locale)}</time>
							<Icon name="arrow" className="studio-recent-arrow" />
						</button>
					))}
				</section>
			)}
		</main>
	);
}
