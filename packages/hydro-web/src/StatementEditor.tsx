import { editableStatementSections, formatHydroStatement, statementSectionList } from "@setdraft/authoring/statement";
import { type ProjectSnapshot, resolveProblemType, type StatementSections, usesProtocol } from "@setdraft/contracts";
import { useId, useRef, useState } from "react";
import { createClientId } from "./browser-capabilities.ts";
import { EditorSplit } from "./EditorSplit.tsx";
import { useLocale } from "./i18n.tsx";
import { ProblemPreview } from "./ProblemPreview.tsx";
import { ProtocolSamples } from "./ProtocolSamples.tsx";

type Section = keyof StatementSections | "samples";

export function StatementEditor({
	project,
	disabled,
	onEdit,
}: {
	project: ProjectSnapshot;
	disabled: boolean;
	onEdit(change: (current: ProjectSnapshot) => ProjectSnapshot): void;
}) {
	const { t } = useLocale();
	const prefix = useId();
	const [selected, setSelected] = useState<Section>("description");
	const interactive = usesProtocol(project);
	const tabs: Array<{ id: Section; label: string }> = [
		...statementSectionList(project).map(({ key, title }) => ({ id: key, label: title })),
		{ id: "samples", label: "样例" },
	];
	const active = tabs.find((item) => item.id === selected) ?? tabs[0];
	const sections = editableStatementSections(project);
	const keys = useRef<string[]>([]);
	while (keys.current.length < project.samples.length) keys.current.push(createClientId());
	keys.current.length = project.samples.length;
	const change = (edit: (current: ProjectSnapshot) => ProjectSnapshot) =>
		onEdit((current) => {
			const next = edit({ ...current, statementSections: editableStatementSections(current) });
			return { ...next, statement: formatHydroStatement(next) };
		});
	return (
		<div className="sectioned-statement">
			<div className="statement-tabs" role="tablist" aria-label={t("题面分栏")}>
				{tabs.map((item, index) => (
					<button
						key={item.id}
						type="button"
						role="tab"
						id={`${prefix}-tab-${item.id}`}
						aria-controls={`${prefix}-panel`}
						aria-selected={active.id === item.id}
						tabIndex={active.id === item.id ? 0 : -1}
						onClick={() => setSelected(item.id)}
						onKeyDown={(event) => {
							const next =
								event.key === "ArrowRight"
									? (index + 1) % tabs.length
									: event.key === "ArrowLeft"
										? (index + tabs.length - 1) % tabs.length
										: event.key === "Home"
											? 0
											: event.key === "End"
												? tabs.length - 1
												: undefined;
							if (next === undefined) return;
							event.preventDefault();
							setSelected(tabs[next].id);
							document.getElementById(`${prefix}-tab-${tabs[next].id}`)?.focus();
						}}
					>
						{t(item.label)}
						{item.id === "samples" && (
							<span className="tab-count">
								{project.samples.length + (interactive ? (project.protocolSamples?.length ?? 0) : 0)}
							</span>
						)}
					</button>
				))}
			</div>
			{!project.statementSections && project.statement.trim() && (
				<p className="statement-migration-note">
					{t("旧版完整题面保留在“描述”中。编辑后按分栏排版，可将输入、输出和提示移到对应栏目。")}
				</p>
			)}
			<EditorSplit>
				<div
					className="editor-pane"
					role="tabpanel"
					id={`${prefix}-panel`}
					aria-labelledby={`${prefix}-tab-${active.id}`}
				>
					<div className="pane-heading">
						<strong>{t(active.label)}</strong>
						<span>{active.id === "samples" ? t("公开展示，不是私有测试数据") : "Markdown · LaTeX"}</span>
					</div>
					{active.id === "samples" ? (
						<div className="statement-samples">
							<p className="manual-muted">
								{t(
									interactive
										? "旧双栏内容保持原样；请手动整理为有序消息，确认后可删除旧样例。"
										: "样例会展示在题面和 PDF 中；普通题发布时会运行标程核验样例。",
								)}
							</p>
							{interactive && (
								<ProtocolSamples
									samples={project.protocolSamples ?? []}
									communication={resolveProblemType(project) === "communication"}
									disabled={disabled}
									onChange={(protocolSamples) => change((current) => ({ ...current, protocolSamples }))}
								/>
							)}
							{project.samples.map((sample, index) => (
								<section className="test-card" key={keys.current[index]}>
									<div className="test-card-heading">
										<strong>{t(interactive ? "旧双栏样例 {0}（顺序未整理）" : "样例 {0}", index + 1)}</strong>
										{interactive && (
											<button
												type="button"
												className="button secondary small"
												disabled={disabled || (project.protocolSamples?.length ?? 0) >= 20}
												onClick={() =>
													change((current) => ({
														...current,
														protocolSamples: [
															...(current.protocolSamples ?? []),
															{
																id: createClientId(),
																rounds: [
																	{ round: 1, messages: [] },
																	{ round: 2, messages: [] },
																],
															},
														],
													}))
												}
											>
												{t("手动整理消息顺序")}
											</button>
										)}
										<button
											type="button"
											className="text-button danger"
											disabled={disabled}
											onClick={() => {
												keys.current.splice(index, 1);
												change((current) => ({
													...current,
													samples: current.samples.filter((_, position) => position !== index),
												}));
											}}
										>
											{t("删除")}
										</button>
									</div>
									<div className="test-columns">
										{(["input", "output"] as const).map((field) => (
											<label key={field}>
												<span>
													{t(
														interactive
															? field === "input"
																? "裁判发送"
																: "选手发送"
															: field === "input"
																? "输入"
																: "输出",
													)}
												</span>
												<textarea
													aria-label={t(field === "input" ? "样例 {0} 输入" : "样例 {0} 输出", index + 1)}
													spellCheck={false}
													disabled={disabled}
													value={sample[field]}
													maxLength={200_000}
													onChange={(event) =>
														change((current) => ({
															...current,
															samples: current.samples.map((entry, position) =>
																position === index ? { ...entry, [field]: event.target.value } : entry,
															),
														}))
													}
												/>
											</label>
										))}
									</div>
								</section>
							))}
							{!interactive && (
								<button
									type="button"
									className="button secondary"
									disabled={disabled || project.samples.length >= 20}
									onClick={() =>
										change((current) => ({
											...current,
											samples: [...current.samples, { input: "", output: "" }],
										}))
									}
								>
									{t("添加样例")}
								</button>
							)}
						</div>
					) : (
						<textarea
							className="statement-editor"
							aria-label={t("{0} · Markdown", t(active.label))}
							value={sections[active.id] ?? ""}
							spellCheck={false}
							disabled={disabled}
							maxLength={1_000_000}
							placeholder={t(
								active.id === "interaction"
									? "说明交互协议、消息格式、查询次数、结束条件和 flush 要求…"
									: "填写本栏内容，无需重复栏目标题…",
							)}
							onChange={(event) =>
								change((current) => ({
									...current,
									statementSections: {
										...editableStatementSections(current),
										[active.id]: event.target.value,
									},
								}))
							}
						/>
					)}
				</div>
				<div className="preview-pane">
					<div className="pane-heading">
						<strong>{t("完整题面预览")}</strong>
					</div>
					<ProblemPreview project={project} />
				</div>
			</EditorSplit>
		</div>
	);
}
