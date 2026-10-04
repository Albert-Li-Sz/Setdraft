import type { DraftRevision, DraftRevisionSummary, ProjectSnapshot } from "@setdraft/contracts";
import { useEffect, useState } from "react";
import { requestJson } from "./api-client.ts";
import { Dialog } from "./Dialog.tsx";
import { type DraftChoices, draftDifferences, mergeDraft } from "./draft-merge.ts";
import type { DraftRecovery } from "./draft-recovery.ts";
import { useLocale } from "./i18n.tsx";
import { apiUrl } from "./platform.ts";

const labels: Record<string, string> = {
	title: "标题",
	slug: "题目代号",
	statement: "题面",
	statementSections: "题面栏目",
	samples: "样例",
	protocolSamples: "协议样例",
	solutions: "标程库",
	reference: "主标程",
	oracle: "对照程序",
	generators: "生成器",
	generatorScript: "生成脚本",
	checkerSource: "Checker 源码",
	interactorSource: "Interactor 源码",
	communication: "通信配置",
	validatorSource: "Validator 源码",
	cases: "测试数据",
	caseSubtasks: "子任务分配",
	subtasks: "子任务配分",
	boundaryConditions: "边界条件",
	attachments: "附件",
	timeLimit: "时间限制",
	memoryLimit: "内存限制",
	problemType: "题型",
	interactionInputMode: "测试输入来源",
};
function pathLabel(path: string) {
	const root = path.split(/[.[]/u)[0];
	return { label: labels[root] ?? root, suffix: path.slice(root.length) };
}
function valueText(value: unknown, path: string) {
	if (value === undefined) return "∅";
	if (path === "attachments" && Array.isArray(value))
		return JSON.stringify(
			value.map((item: { name?: string; contentBase64?: string }) => ({
				name: item.name,
				encodedBytes: item.contentBase64?.length,
			})),
			null,
			2,
		);
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
export function DraftDiff({ before, after }: { before: ProjectSnapshot; after: ProjectSnapshot }) {
	const { t } = useLocale();
	const differences = draftDifferences(before, after);
	return (
		<div className="draft-diff">
			{!differences.length && <p>{t("没有内容差异。")}</p>}
			{differences.map((difference) => {
				const label = pathLabel(difference.path);
				return (
					<details key={difference.path}>
						<summary>
							{t(label.label)}
							<small>{label.suffix}</small>
						</summary>
						<div className="draft-diff-columns">
							<div>
								<strong>{t("所选历史版本")}</strong>
								<pre>{valueText(difference.before, difference.path)}</pre>
							</div>
							<div>
								<strong>{t("当前草稿")}</strong>
								<pre>{valueText(difference.after, difference.path)}</pre>
							</div>
						</div>
					</details>
				);
			})}
		</div>
	);
}

export function DraftHistoryDialog({
	apiOrigin,
	project,
	open,
	busy,
	onClose,
	onRestore,
}: {
	apiOrigin: string;
	project: ProjectSnapshot;
	open: boolean;
	busy: boolean;
	onClose(): void;
	onRestore(revision: number): Promise<void>;
}) {
	const { t } = useLocale();
	const [rows, setRows] = useState<DraftRevisionSummary[]>([]),
		[selected, setSelected] = useState<DraftRevision>();
	const [revision, setRevision] = useState<number>(),
		[error, setError] = useState(""),
		[loading, setLoading] = useState(false),
		[restoring, setRestoring] = useState(false);
	useEffect(() => {
		if (!open) return;
		const controller = new AbortController();
		setSelected(undefined);
		setError("");
		setLoading(true);
		void requestJson<{ drafts: DraftRevisionSummary[] }>(
			apiUrl(apiOrigin, `/projects/${project.id}/drafts?revision=${project.revision}`),
			{
				signal: controller.signal,
			},
		)
			.then(({ drafts }) => {
				if (!controller.signal.aborted) {
					setRows(drafts);
					setRevision(drafts.find((item) => !item.current)?.revision ?? drafts[0]?.revision);
				}
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "草稿历史读取失败。");
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [apiOrigin, project.id, project.revision, open]);
	useEffect(() => {
		if (!open || revision === undefined) return;
		const controller = new AbortController();
		setSelected(undefined);
		void requestJson<DraftRevision>(apiUrl(apiOrigin, `/projects/${project.id}/drafts/${revision}`), {
			signal: controller.signal,
		})
			.then((value) => {
				if (!controller.signal.aborted) setSelected(value);
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "草稿历史读取失败。");
			});
		return () => controller.abort();
	}, [apiOrigin, project.id, revision, open]);
	return (
		<Dialog
			open={open}
			onClose={() => {
				if (!restoring) onClose();
			}}
			labelledBy="draft-history-title"
			className="draft-dialog"
		>
			<div className="confirmation-heading">
				<h2 id="draft-history-title">{t("草稿历史")}</h2>
			</div>
			<p>{t("保留最近 40 个已保存版本，并受历史存储容量限制；恢复源码与当时的数据会创建新版本，需重新验证。")}</p>
			{loading && <output>{t("正在读取历史…")}</output>}
			{error && <p role="alert">{t(error)}</p>}
			<label className="field">
				<span>{t("选择历史版本")}</span>
				<select
					value={revision ?? ""}
					disabled={loading || restoring}
					onChange={(event) => {
						setRevision(Number(event.target.value));
						setError("");
					}}
				>
					{rows.map((row) => (
						<option key={row.id} value={row.revision}>
							{t("版本 {0}", row.revision)} · {new Date(row.savedAt).toLocaleString()} ·{" "}
							{row.title || t("未命名题目")}
							{row.current ? ` · ${t("当前")}` : ""}
						</option>
					))}
				</select>
			</label>
			{selected && <DraftDiff before={selected.project} after={project} />}
			<div className="confirmation-actions">
				<button className="button secondary" type="button" disabled={restoring} onClick={onClose}>
					{t("关闭")}
				</button>
				<button
					type="button"
					className="button primary"
					disabled={busy || restoring || !selected || selected.current}
					onClick={() => {
						if (!selected) return;
						setRestoring(true);
						setError("");
						void onRestore(selected.revision)
							.then(onClose)
							.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "草稿恢复失败。"))
							.finally(() => setRestoring(false));
					}}
				>
					{t(restoring ? "正在恢复…" : "恢复此版本")}
				</button>
			</div>
		</Dialog>
	);
}

export function DraftCompareDialog({
	base,
	local,
	server,
	recovery,
	onClose,
	onServer,
	onApply,
}: {
	base: ProjectSnapshot;
	local: ProjectSnapshot;
	server: ProjectSnapshot;
	recovery?: DraftRecovery;
	onClose(): void;
	onServer(): void;
	onApply(choices: DraftChoices): Promise<void>;
}) {
	const { t } = useLocale();
	const [choices, setChoices] = useState<DraftChoices>({}),
		[error, setError] = useState(""),
		[saving, setSaving] = useState(false);
	const { project: merged, conflicts } = mergeDraft(base, local, server, choices);
	return (
		<Dialog
			open
			onClose={() => {
				if (!saving) onClose();
			}}
			labelledBy="draft-compare-title"
			className="draft-dialog"
		>
			<div className="confirmation-heading">
				<span>{t(recovery ? "未保存内容恢复" : "版本冲突")}</span>
				<h2 id="draft-compare-title">{t("比较与选择草稿")}</h2>
			</div>
			<p>{t("服务器版本 {0}；没有冲突的修改自动合并，冲突处由你选择。保存仍检查最新版本。", server.revision)}</p>
			{recovery && (
				<p>{t("恢复副本保存于 {0}，仅在当前浏览器和账号可见。", new Date(recovery.savedAt).toLocaleString())}</p>
			)}
			{!!conflicts.length && (
				<div className="draft-choice-actions">
					<button
						className="button secondary"
						type="button"
						disabled={saving}
						onClick={() =>
							setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.path, "local" as const])))
						}
					>
						{t("全部保留本地修改")}
					</button>
					<button
						className="button secondary"
						type="button"
						disabled={saving}
						onClick={() =>
							setChoices(Object.fromEntries(conflicts.map((conflict) => [conflict.path, "server" as const])))
						}
					>
						{t("全部采用服务器内容")}
					</button>
				</div>
			)}
			<div className="draft-conflicts">
				{conflicts.map((conflict) => {
					const label = pathLabel(conflict.path);
					return (
						<fieldset key={conflict.path} disabled={saving}>
							<legend>
								{t(label.label)} <small>{label.suffix}</small>
							</legend>
							<div className="draft-diff-columns">
								{(["local", "server"] as const).map((side) => (
									<label key={side}>
										<span>
											<input
												type="radio"
												name={`draft-choice:${conflict.path}`}
												checked={choices[conflict.path] === side}
												onChange={() => setChoices((current) => ({ ...current, [conflict.path]: side }))}
											/>
											{t(side === "local" ? "本地修改" : "服务器内容")}
										</span>
										<pre>{valueText(side === "local" ? conflict.local : conflict.server, conflict.path)}</pre>
									</label>
								))}
							</div>
							<details>
								<summary>{t("共同基线")}</summary>
								<pre>{valueText(conflict.base, conflict.path)}</pre>
							</details>
						</fieldset>
					);
				})}
			</div>
			<details>
				<summary>{t("合并预览")}</summary>
				<DraftDiff before={server} after={merged} />
			</details>
			{error && <p role="alert">{t(error)}</p>}
			<div className="confirmation-actions">
				<button type="button" className="button secondary" disabled={saving} onClick={onClose}>
					{t("稍后处理")}
				</button>
				<button type="button" className="button secondary" disabled={saving} onClick={onServer}>
					{t(recovery ? "丢弃此恢复副本" : "加载服务器版本")}
				</button>
				<button
					type="button"
					className="button primary"
					disabled={saving || conflicts.some((conflict) => !choices[conflict.path])}
					onClick={() => {
						setSaving(true);
						setError("");
						void onApply(choices)
							.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "草稿恢复失败。"))
							.finally(() => setSaving(false));
					}}
				>
					{t(saving ? "正在保存" : "合并并保存")}
				</button>
			</div>
		</Dialog>
	);
}
