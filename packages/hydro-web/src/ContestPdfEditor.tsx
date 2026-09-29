import { type ContestDraft, type ContestPdfOptions, defaultContestPdfOptions } from "@setdraft/contracts";
import { useEffect, useRef, useState } from "react";
import { authFetch } from "./auth-client.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import { PdfPreview } from "./PdfPreview.tsx";
import { apiUrl, responseError } from "./platform.ts";

export function ContestPdfEditor({
	contest,
	apiOrigin,
	disabled,
	ready,
	onSave,
	onDirty,
}: {
	contest: ContestDraft;
	apiOrigin: string;
	disabled: boolean;
	ready: boolean;
	onSave(options: ContestPdfOptions): Promise<void>;
	onDirty(dirty: boolean): void;
}) {
	const { t } = useLocale();
	const saved = JSON.stringify(contest.pdf ?? defaultContestPdfOptions);
	const [options, setOptions] = useState<ContestPdfOptions>(() => ({ ...defaultContestPdfOptions, ...contest.pdf }));
	const [preview, setPreview] = useState<string>();
	const [generating, setGenerating] = useState(false);
	const [message, setMessage] = useState("");
	const controller = useRef<AbortController | undefined>(undefined);
	useEffect(() => {
		setOptions(JSON.parse(saved) as ContestPdfOptions);
	}, [saved]);
	const dirty = saved !== JSON.stringify(options);
	useEffect(() => {
		onDirty(dirty);
	}, [dirty, onDirty]);
	useEffect(
		() => () => {
			controller.current?.abort();
		},
		[],
	);
	useEffect(
		() => () => {
			if (preview) URL.revokeObjectURL(preview);
		},
		[preview],
	);
	const set = <Key extends keyof ContestPdfOptions>(key: Key, value: ContestPdfOptions[Key]) =>
		setOptions((current) => ({ ...current, [key]: value }));
	async function showPreview() {
		controller.current?.abort();
		const request = new AbortController();
		controller.current = request;
		setGenerating(true);
		setMessage("");
		try {
			const response = await authFetch(apiUrl(apiOrigin, `/contests/${contest.id}/pdf-preview`), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: contest.revision }),
				signal: request.signal,
			});
			if (!response.ok) throw new Error(responseError(await response.json()));
			const blob = await response.blob();
			if (!request.signal.aborted) setPreview(URL.createObjectURL(blob));
		} catch (error) {
			if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : "PDF 生成失败。");
		} finally {
			if (!request.signal.aborted) setGenerating(false);
		}
	}
	return (
		<section className="contest-pdf-settings" aria-labelledby="contest-pdf-title">
			<div className="manual-section-heading">
				<div>
					<h2 id="contest-pdf-title">{t("竞赛题面 PDF")}</h2>
					<p>{t("从已发布题面生成完整题册和单题 PDF，按当前题序排版；DOMjudge 题目包自动附带单题 PDF。")}</p>
					<p>
						{t("使用 XCPC 原模板与原字体。")}{" "}
						<a className="text-button" href="/open-source/index.html" target="_blank" rel="noreferrer">
							{t("开源与源码")}
						</a>
					</p>
				</div>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void onSave(options);
				}}
			>
				<fieldset disabled={disabled || generating} className="pdf-settings-fields">
					<label className="authoring-toggle">
						<span>{t("竞赛包附带 PDF")}</span>
						<input
							type="checkbox"
							role="switch"
							aria-checked={options.enabled}
							checked={options.enabled}
							onChange={(event) => set("enabled", event.target.checked)}
						/>
					</label>
					{options.enabled && (
						<>
							<div className="pdf-settings-grid">
								{(
									[
										{ key: "subtitle", label: "封面副标题" },
										{ key: "author", label: "署名 / 主办方" },
										{ key: "date", label: "日期 / 地点" },
									] as const
								).map((item) => (
									<label className="field" key={item.key}>
										<span>{t(item.label)}</span>
										<input
											value={options[item.key]}
											maxLength={200}
											onChange={(event) => set(item.key, event.target.value)}
										/>
									</label>
								))}
								{(
									[
										{ key: "language", label: "默认语言" },
										{ key: "titlePageLanguage", label: "封面语言" },
										{ key: "problemLanguage", label: "题面栏目语言" },
									] as const
								).map((item) => (
									<label className="field" key={item.key}>
										<span>{t(item.label)}</span>
										<select
											value={options[item.key]}
											onChange={(event) => {
												const value = event.target.value;
												if (value === "zh" || value === "en") set(item.key, value);
												else if (item.key !== "language") set(item.key, "auto");
											}}
										>
											{item.key !== "language" && <option value="auto">{t("跟随默认语言")}</option>}
											<option value="zh">中文</option>
											<option value="en">English</option>
										</select>
									</label>
								))}
							</div>
							<div className="pdf-layout-toggles">
								{(
									[
										{ key: "titlePage", label: "显示封面" },
										{ key: "problemList", label: "显示题目列表" },
										{ key: "headerFooter", label: "显示页眉页脚" },
									] as const
								).map((item) => (
									<label key={item.key}>
										<input
											type="checkbox"
											disabled={item.key === "problemList" && !options.titlePage}
											checked={options[item.key]}
											onChange={(event) => set(item.key, event.target.checked)}
										/>
										{t(item.label)}
									</label>
								))}
							</div>
							<p className="manual-muted">
								{t("题目列表位于封面；关闭封面时不显示。样例按原模板保留换行，不自动折行。")}
							</p>
							<label className="field">
								<span>{t("首页补充说明 · Markdown")}</span>
								<textarea
									rows={5}
									disabled={!options.titlePage}
									value={options.coverNotes}
									maxLength={20_000}
									placeholder={t("填写比赛时长、注意事项或主办方说明…")}
									onChange={(event) => set("coverNotes", event.target.value)}
								/>
							</label>
						</>
					)}
				</fieldset>
				<div className="manual-release-actions">
					<button className="button secondary" type="submit" disabled={disabled || generating || !dirty}>
						{t("保存 PDF 配置")}
					</button>
					<button
						className="button secondary"
						type="button"
						disabled={disabled || generating || dirty || !ready || !options.enabled}
						onClick={() => void showPreview()}
					>
						{t(generating ? "正在生成 PDF…" : "预览题册")}
					</button>
					{generating && (
						<button
							className="text-button"
							type="button"
							onClick={() => {
								controller.current?.abort();
								setGenerating(false);
							}}
						>
							{t("取消")}
						</button>
					)}
					{dirty && <span className="manual-muted">{t("配置尚未保存，保存后可预览和导出。")}</span>}
				</div>
			</form>
			{message && (
				<p role="alert" className="manual-error">
					{t(message)}
				</p>
			)}
			<Dialog
				open={!!preview}
				onClose={() => setPreview(undefined)}
				labelledBy="contest-preview-title"
				className="pdf-preview-dialog"
			>
				<div className="preview-dialog-heading">
					<h2 id="contest-preview-title">{t("竞赛题册预览")}</h2>
					<button type="button" className="button secondary" onClick={() => setPreview(undefined)}>
						{t("关闭")}
					</button>
				</div>
				{preview && (
					<>
						<PdfPreview url={preview} />
						<a className="button secondary button-link" href={preview} download={`${contest.slug}.pdf`}>
							{t("下载 PDF")}
						</a>
					</>
				)}
			</Dialog>
		</section>
	);
}
