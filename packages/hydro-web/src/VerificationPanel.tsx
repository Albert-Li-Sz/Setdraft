import {
	type BackgroundTask,
	type MatrixCell,
	type MatrixOptions,
	type ProjectSnapshot,
	projectSolutions,
	type VerificationOptions,
	type VerificationRun,
} from "@setdraft/contracts";
import { useEffect, useRef, useState } from "react";
import { apiUrl, requestJson, waitForTask } from "./api-client.ts";
import { copyText } from "./browser-capabilities.ts";
import { Dialog } from "./Dialog.tsx";
import { useLocale } from "./i18n.tsx";
import type { ProjectSession } from "./project-session.ts";
import { useVerificationHistory } from "./use-verification-history.ts";
import { VerificationDetail } from "./VerificationDetail.tsx";
import { replaceWorkspaceLocation } from "./workspace-navigation.ts";

export function VerificationPanel({
	apiOrigin,
	project,
	session,
	disabled,
}: {
	apiOrigin: string;
	project: ProjectSnapshot;
	session: ProjectSession;
	disabled: boolean;
}) {
	const { t, locale } = useLocale();
	const history = useVerificationHistory(apiOrigin, project.id);
	const { mode, runs, run, task, setTask, route, select } = history;
	const setMode = history.selectMode;
	const [working, setBusy] = useState(false);
	const busy = working || task?.state === "queued" || task?.state === "running" || run?.state === "running";
	const [error, setError] = useState("");
	const [copied, setCopied] = useState(false);
	const [cell, setCell] = useState<MatrixCell>();
	const solutionFilter = history.location.solution ?? "";
	const subtask = history.location.subtask ?? "";
	const abnormal = history.location.abnormal ?? false;
	const setSolutionFilter = (value: string) => replaceWorkspaceLocation(project.id, { solution: value });
	const setSubtask = (value: string) => replaceWorkspaceLocation(project.id, { subtask: value });
	const setAbnormal = (value: boolean) => replaceWorkspaceLocation(project.id, { abnormal: value });
	const [limit, setLimit] = useState(100);
	const solutions = projectSolutions(project);
	const [baseline, setBaseline] = useState(project.referenceSolutionId ?? "reference");
	const [targets, setTargets] = useState<string[]>(
		solutions.filter((item) => item.id !== baseline).map((item) => item.id),
	);
	const [command, setCommand] = useState("gen {seed}");
	const [seed, setSeed] = useState(1);
	const [rounds, setRounds] = useState(100);
	const [seconds, setSeconds] = useState(60);
	const [importing, setImporting] = useState(false);
	const [importName, setImportName] = useState("");
	const [importSubtask, setImportSubtask] = useState(project.subtasks[0]?.id ?? 1);
	const [importRevision, setImportRevision] = useState(0);
	const lifecycle = useRef<AbortController | undefined>(undefined);
	const pending = useRef(false);
	useEffect(() => {
		const controller = new AbortController();
		lifecycle.current = controller;
		return () => controller.abort();
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A different run starts a fresh detail view.
	useEffect(() => {
		setCell(undefined);
		setCopied(false);
		setLimit(100);
	}, [run?.id]);
	async function start(replay?: VerificationRun, subset?: MatrixOptions) {
		if (pending.current || disabled) return;
		pending.current = true;
		setBusy(true);
		setError("");
		const signal = AbortSignal.any([session.signal, lifecycle.current!.signal]);
		try {
			await session.flush();
			signal.throwIfAborted();
			const current = session.getSnapshot().project;
			if (!current || current.id !== project.id) throw new Error("题目会话已变化。");
			const options: VerificationOptions =
				mode === "matrix"
					? (subset ?? { kind: "matrix" })
					: {
							kind: "stress",
							baselineId: baseline,
							solutionIds: targets.filter((id) => id !== baseline && solutions.some((item) => item.id === id)),
							command,
							seed,
							rounds,
							budgetMs: seconds * 1000,
						};
			const accepted = await requestJson<{ task: BackgroundTask }>(
				apiUrl(apiOrigin, replay ? `${route}/${replay.id}/replay` : route),
				{
					method: "POST",
					signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ...options, expectedRevision: current.revision }),
				},
			);
			setTask(accepted.task);
			replaceWorkspaceLocation(project.id, { tab: "validation", mode, task: accepted.task.id, run: undefined });
			const result = await waitForTask<{ runId: string }>(apiOrigin, accepted.task.id, setTask, signal);
			signal.throwIfAborted();
			await select(result.runId);
		} catch (cause) {
			if (!signal.aborted) setError(cause instanceof Error ? cause.message : "运行失败。");
		} finally {
			pending.current = false;
			if (!signal.aborted) setBusy(false);
		}
	}
	async function cancel() {
		try {
			if (task)
				setTask(
					await requestJson<BackgroundTask>(apiUrl(apiOrigin, `/tasks/${task.id}/cancel`), {
						method: "POST",
						signal: lifecycle.current?.signal,
					}),
				);
		} catch (cause) {
			if (!lifecycle.current?.signal.aborted) setError(cause instanceof Error ? cause.message : "取消失败。");
		}
	}
	async function previewImport() {
		try {
			await session.flush();
			setImportRevision(session.getSnapshot().project?.revision ?? 0);
			setImportName(`stress-${run?.id.slice(0, 8)}.in`);
			setImporting(true);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "请先保存题目。");
		}
	}
	async function importCase() {
		if (!run || pending.current) return;
		pending.current = true;
		setBusy(true);
		const signal = AbortSignal.any([session.signal, lifecycle.current!.signal]);
		try {
			await session.flush();
			signal.throwIfAborted();
			if (session.getSnapshot().project?.revision !== importRevision)
				throw new Error("题目版本已变化，请重新预览。");
			const next = await requestJson<ProjectSnapshot>(apiUrl(apiOrigin, `${route}/${run.id}/import`), {
				method: "POST",
				signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: importRevision, name: importName, subtaskId: importSubtask }),
			});
			signal.throwIfAborted();
			session.accept(next);
			setImporting(false);
			await select(run.id);
		} catch (cause) {
			if (!signal.aborted) setError(cause instanceof Error ? cause.message : "反例入库失败。");
		} finally {
			pending.current = false;
			if (!signal.aborted) setBusy(false);
		}
	}
	const matrix = run?.matrix;
	const columns = run?.solutions.filter((item) => !solutionFilter || item.id === solutionFilter) ?? [];
	const cellMap = new Map(matrix?.cells.map((item) => [`${item.caseId}/${item.solutionId}`, item]));
	const cases =
		matrix?.cases.filter(
			(item) =>
				(!subtask || item.subtaskId === Number(subtask)) &&
				(!abnormal ||
					columns.some((solution) => {
						const value = cellMap.get(`${item.origin}:${item.id}/${solution.id}`);
						return !value || value.verdict !== "AC" || value.score !== 100;
					})),
		) ?? [];
	const stale = run && (run.revision !== project.revision || session.getSnapshot().status !== "saved");
	const cellButton = (value?: MatrixCell) =>
		value ? (
			<button
				type="button"
				className={`matrix-cell ${value.verdict === "AC" && value.score === 100 ? "passed" : "failed"}`}
				onClick={() => setCell(value)}
			>
				<strong>{value.verdict}</strong>
				<small>
					{value.points !== undefined ? `${value.points} / ${value.fullPoints}` : `${value.score}%`} ·{" "}
					{value.durationMs} ms
				</small>
			</button>
		) : (
			<span>{t("未运行")}</span>
		);
	return (
		<section className="verification-panel" aria-label={t("解法验证")}>
			<div className="verification-heading">
				<div className="heading-actions">
					<button
						className="button secondary"
						type="button"
						aria-pressed={mode === "matrix"}
						onClick={() => {
							setMode("matrix");
						}}
					>
						{t("验证矩阵")}
					</button>
					<button
						className="button secondary"
						type="button"
						aria-pressed={mode === "stress"}
						onClick={() => {
							setMode("stress");
						}}
					>
						{t("随机对拍")}
					</button>
				</div>
				{busy ? (
					<button
						className="button secondary"
						type="button"
						disabled={!task || task.cleanupPending || !["queued", "running"].includes(task.state)}
						onClick={() => void cancel()}
					>
						{t("取消任务")}
					</button>
				) : (
					<button
						className="button secondary"
						type="button"
						disabled={disabled || (mode === "stress" && project.judgingMode === "interactive")}
						onClick={() => void start()}
					>
						{t(mode === "matrix" ? "运行完整矩阵" : "开始对拍")}
					</button>
				)}
			</div>
			{busy && (
				<output aria-live="polite">
					{t(
						task?.state === "queued"
							? "任务排队中，可在任务中心查看。"
							: "任务正在执行，可在任务中心查看或取消。",
					)}
				</output>
			)}
			{mode === "stress" &&
				(project.judgingMode === "interactive" ? (
					<p>{t("交互题请使用验证矩阵；随机对拍暂不支持。")}</p>
				) : (
					<div className="stress-options">
						<div className="verification-fields">
							<label className="field">
								<span>{t("基准解法")}</span>
								<select
									aria-label={t("基准解法")}
									value={baseline}
									disabled={busy}
									onChange={(event) => setBaseline(event.target.value)}
								>
									{solutions.map((item) => (
										<option key={item.id} value={item.id}>
											{item.name}
										</option>
									))}
								</select>
							</label>
							<label className="field">
								<span>{t("生成器参数模板")}</span>
								<input
									value={command}
									disabled={busy}
									onChange={(event) => setCommand(event.target.value)}
									placeholder="gen {seed}"
								/>
							</label>
							<label className="field">
								<span>{t("起始种子")}</span>
								<input
									type="number"
									min={0}
									value={seed}
									disabled={busy}
									onChange={(event) => setSeed(Number(event.target.value))}
								/>
							</label>
							<label className="field">
								<span>{t("轮数")}</span>
								<input
									type="number"
									min={1}
									max={1000}
									value={rounds}
									disabled={busy}
									onChange={(event) => setRounds(Number(event.target.value))}
								/>
							</label>
							<label className="field">
								<span>{t("总预算（秒，含编译）")}</span>
								<input
									type="number"
									min={1}
									max={900}
									value={seconds}
									disabled={busy}
									onChange={(event) => setSeconds(Number(event.target.value))}
								/>
							</label>
						</div>
						<fieldset className="verification-targets">
							<legend>{t("待测解法")}</legend>
							{solutions
								.filter((item) => item.id !== baseline)
								.map((item) => (
									<label key={item.id}>
										<input
											type="checkbox"
											disabled={busy}
											checked={targets.includes(item.id)}
											onChange={(event) =>
												setTargets((current) =>
													event.target.checked
														? [...current, item.id]
														: current.filter((id) => id !== item.id),
												)
											}
										/>
										{item.name}
									</label>
								))}
						</fieldset>
					</div>
				))}
			{(error || history.error || task?.error) && (
				<output className="notice failed" role="alert">
					{t(error || history.error || task?.error || "")}
				</output>
			)}
			<label className="field">
				<span>{t("运行记录")}</span>
				<select
					aria-label={t("运行记录")}
					value={run?.id ?? ""}
					onChange={(event) => {
						if (event.target.value) void select(event.target.value);
						else void select("");
					}}
				>
					<option value="">{t("选择运行记录")}</option>
					{(run && !runs.some((item) => item.id === run.id) ? [run, ...runs] : runs).map((item) => (
						<option key={item.id} value={item.id}>
							{new Date(item.createdAt).toLocaleString(locale)} ·{" "}
							{t(item.options.kind === "matrix" ? "验证矩阵" : "随机对拍")} · v{item.revision} ·{" "}
							{t(
								item.state === "running"
									? "运行中"
									: item.state === "failed"
										? "执行失败"
										: item.state === "cancelled"
											? "已取消"
											: "执行完成",
							)}
						</option>
					))}
				</select>
			</label>

			<div className="verification-pagination">
				<button
					type="button"
					className="button secondary"
					disabled={history.loading || history.page === 1}
					onClick={history.previous}
				>
					{t("上一页")}
				</button>
				<span>{t("第 {0} 页", history.page)}</span>
				<button
					type="button"
					className="button secondary"
					disabled={history.loading || !history.nextCursor}
					onClick={history.next}
				>
					{t("下一页")}
				</button>
			</div>
			{!runs.length && <p className="manual-muted">{t("尚无运行记录。矩阵检查现有测试点，对拍寻找新的反例。")}</p>}
			{run && (
				<>
					<div className="manual-report-status">
						<strong>
							{t(
								run.state === "running"
									? "运行中"
									: run.state === "failed"
										? "执行失败"
										: run.state === "cancelled"
											? "已取消"
											: "执行完成",
							)}
							{stale && ` · ${t("历史结果，当前版本需重新运行")}`}
						</strong>
						<span>
							{t("题目版本：{0}", run.revision)} · {run.id.slice(0, 8)}
						</span>
						{run.error && <span>{t(run.error)}</span>}
					</div>
					{run.progress && (
						<div className="verification-progress" aria-live="polite">
							<progress
								max={Math.max(1, run.progress.total)}
								value={run.progress.completed}
								aria-label={t("运行进度")}
							/>
							<span>
								{t("已完成 {0} / {1}", run.progress.completed, run.progress.total)} ·{" "}
								{t(
									"耗时 {0} 秒",
									(
										(run.state === "running"
											? Math.max(run.progress.elapsedMs, Date.now() - Date.parse(run.createdAt))
											: run.progress.elapsedMs) / 1000
									).toFixed(1),
								)}
							</span>
							<small>{t(run.progress.message)}</small>
						</div>
					)}
					<div className="heading-actions">
						<button
							className="button secondary"
							type="button"
							onClick={() =>
								void copyText(window.location.href)
									.then(() => setCopied(true))
									.catch(() => setError("复制失败，请检查浏览器剪贴板权限。"))
							}
						>
							{t(copied ? "已复制" : "复制运行链接")}
						</button>
						{run.diagnostics && (
							<a
								className="button secondary button-link"
								download
								href={apiUrl(apiOrigin, `${route}/${run.id}/diagnostics`)}
							>
								{t("下载完整诊断包")}
							</a>
						)}
					</div>
					{matrix && (
						<>
							<p>
								{t(matrix.full ? "完整数据集" : "抽样结果，不能用于发布")} ·{" "}
								{t(
									run.state === "running"
										? "运行中，尚不能用于发布"
										: matrix.requiredPassed
											? "全部必检预期满足"
											: "必检预期未全部满足",
								)}
							</p>
							<div className="verification-fields">
								<label className="field">
									<span>{t("解法筛选")}</span>
									<select
										aria-label={t("解法筛选")}
										value={solutionFilter}
										onChange={(event) => setSolutionFilter(event.target.value)}
									>
										<option value="">{t("全部解法")}</option>
										{run.solutions.map((item) => (
											<option key={item.id} value={item.id}>
												{item.name}
											</option>
										))}
									</select>
								</label>
								<label className="field">
									<span>{t("子任务筛选")}</span>
									<select
										aria-label={t("子任务筛选")}
										value={subtask}
										onChange={(event) => setSubtask(event.target.value)}
									>
										<option value="">{t("全部子任务")}</option>
										{[...new Set(matrix.cases.map((item) => item.subtaskId))].map((id) => (
											<option key={id} value={id}>
												{id}
											</option>
										))}
									</select>
								</label>
								<label className="verification-checkbox">
									<input
										type="checkbox"
										checked={abnormal}
										onChange={(event) => setAbnormal(event.target.checked)}
									/>
									{t("仅异常结果")}
								</label>
							</div>
							<div className="heading-actions">
								<button
									className="button secondary"
									type="button"
									disabled={
										busy ||
										disabled ||
										!solutionFilter ||
										!solutions.some((item) => item.id === solutionFilter)
									}
									onClick={() => void start(undefined, { kind: "matrix", solutionIds: [solutionFilter] })}
								>
									{t("重跑当前解法")}
								</button>
								<button
									className="button secondary"
									type="button"
									disabled={
										busy ||
										disabled ||
										!matrix.cells.some((item) => item.verdict !== "AC" || item.score !== 100)
									}
									onClick={() => {
										const failed = matrix.cells.filter(
											(item) =>
												(item.verdict !== "AC" || item.score !== 100) &&
												(!solutionFilter || item.solutionId === solutionFilter),
										);
										const solutionIds = [...new Set(failed.map((item) => item.solutionId))].filter((id) =>
											solutions.some((item) => item.id === id),
										);
										const caseIds = [...new Set(failed.map((item) => item.caseId))].filter(
											(id) =>
												project.cases.some((item) => `${item.origin}:${item.id}` === id) ||
												id === "manual:interactive-empty",
										);
										if (!solutionIds.length || !caseIds.length) {
											setError("所选失败项已不存在，请运行完整矩阵。");
											return;
										}
										void start(undefined, { kind: "matrix", solutionIds, caseIds });
									}}
								>
									{t("重跑失败项")}
								</button>
							</div>
							<p className="manual-muted">
								{t("重跑使用当前版本，生成独立记录；失败项按涉及的解法与测试点组合运行。")}
							</p>
							<div className="solution-summaries">
								{columns.map((item) => {
									const summary = matrix.solutions.find((value) => value.solutionId === item.id);
									const ac = matrix.cells
										.filter((value) => value.solutionId === item.id)
										.every((value) => value.verdict === "AC" && value.score === 100);
									return (
										<div key={item.id}>
											<strong>{item.name}</strong>
											<span>
												{t(item.required ? "必检" : "仅观察")} ·{" "}
												{t(summary?.complete ? "运行完整" : "运行不完整")} ·{" "}
												{ac && summary?.complete ? "AC" : t("未全 AC")} · {summary?.score ?? 0} / 100 ·{" "}
												{t(
													run.state === "running" && !summary?.complete
														? "等待判定"
														: summary?.matches
															? "符合预期"
															: "不符合预期",
												)}
											</span>
											{summary?.compile && !summary.compile.passed && <pre>{summary.compile.message}</pre>}
										</div>
									);
								})}
							</div>
							<section className="matrix-scroll" aria-label={t("测试点与解法矩阵")}>
								<table className="matrix-table">
									<thead>
										<tr>
											<th>{t("测试点")}</th>
											{columns.map((item) => (
												<th key={item.id} title={item.name}>
													{item.name}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{cases.slice(0, limit).map((item) => (
											<tr key={`${item.origin}:${item.id}`}>
												<th scope="row">
													{item.inputFile}
													<small>#{item.subtaskId}</small>
												</th>
												{columns.map((solution) => (
													<td key={solution.id}>
														{cellButton(cellMap.get(`${item.origin}:${item.id}/${solution.id}`))}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</section>
							<div className="matrix-mobile">
								{(solutionFilter ? columns : columns.slice(0, 1)).map((solution) => (
									<section key={solution.id}>
										<h3>{solution.name}</h3>
										<p>{t("使用解法筛选切换结果。")}</p>
										{cases.slice(0, limit).map((item) => (
											<div className="matrix-mobile-row" key={`${item.origin}:${item.id}`}>
												<span>{item.inputFile}</span>
												{cellButton(cellMap.get(`${item.origin}:${item.id}/${solution.id}`))}
											</div>
										))}
									</section>
								))}
							</div>
							{cases.length > limit && (
								<button
									className="button secondary"
									type="button"
									onClick={() => setLimit((value) => value + 100)}
								>
									{t("再显示 100 个测试点")}
								</button>
							)}
							{!cases.length && <p>{t("没有符合筛选条件的测试点。")}</p>}
						</>
					)}
					{run.stress && (
						<div className="stress-result">
							<p>
								{t(run.stress.message)} · {t("已完成 {0} 轮", run.stress.completedRounds)}
								{run.stress.seed !== undefined && ` · seed=${run.stress.seed}`}
							</p>
							{run.stress.cells.map((value) => (
								<div key={value.solutionId}>
									<strong>{run.solutions.find((item) => item.id === value.solutionId)?.name}</strong>
									{cellButton(value)}
								</div>
							))}
							{run.stress.reason === "counterexample" && (
								<>
									<div className="verification-previews">
										<div>
											<h3>{t("反例输入")}</h3>
											<pre>{run.stress.inputPreview}</pre>
										</div>
										<div>
											<h3>{t("基准输出")}</h3>
											<pre>{run.stress.outputPreview}</pre>
										</div>
									</div>
									{run.stress.truncated && <p>{t("预览已截断；下载与入库使用完整文件。")}</p>}
									<div className="heading-actions">
										<button
											className="button secondary"
											type="button"
											disabled={busy || disabled}
											onClick={() => void start(run)}
										>
											{t("按原快照重放")}
										</button>
										<a
											className="button secondary button-link"
											download
											href={apiUrl(apiOrigin, `${route}/${run.id}/download`)}
										>
											{t("下载复现包")}
										</a>
										<button
											className="button secondary"
											type="button"
											disabled={busy || disabled || !!run.importedCase}
											onClick={() => void previewImport()}
										>
											{t(run.importedCase ? "已加入测试数据" : "加入测试数据")}
										</button>
									</div>
								</>
							)}
						</div>
					)}
					{!!run.checks?.length && (
						<details>
							<summary>{t("编译与基础检查")}</summary>
							{run.checks
								.filter((item) => item.stage.startsWith("compile:") || !item.passed)
								.slice(0, 100)
								.map((item, index) => (
									<div key={`${item.stage}-${item.caseId}-${index}`}>
										<strong>
											{item.stage} {item.caseId} · {item.verdict}
										</strong>
										<pre>{t(item.message)}</pre>
									</div>
								))}
						</details>
					)}
					<details>
						<summary>{t("运行快照")}</summary>
						<p>{run.image}</p>
						<p>{run.fingerprint}</p>
						<pre>{JSON.stringify(run.options, null, 2)}</pre>
						{run.solutions.map((item) => (
							<details key={item.id}>
								<summary>
									{item.name} · {item.language}
								</summary>
								<pre>{item.code}</pre>
							</details>
						))}
					</details>
				</>
			)}
			<VerificationDetail
				apiOrigin={apiOrigin}
				route={route}
				run={run}
				cell={cell}
				onClose={() => setCell(undefined)}
			/>
			<Dialog
				open={importing}
				onClose={() => {
					if (!busy) setImporting(false);
				}}
				labelledBy="import-counterexample-title"
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void importCase();
					}}
				>
					<h2 id="import-counterexample-title">{t("反例入库预览")}</h2>
					<p>{t("题目版本：{0}", importRevision)}</p>
					<pre>{run?.stress?.inputPreview}</pre>
					<p>{t("导入完整输入与基准输出，并使旧验证结果过期。")}</p>
					<label className="field">
						<span>{t("输入文件名")}</span>
						<input
							required
							value={importName}
							disabled={busy}
							onChange={(event) => setImportName(event.target.value)}
						/>
					</label>
					<label className="field">
						<span>{t("子任务")}</span>
						<select
							aria-label={t("子任务")}
							value={importSubtask}
							disabled={busy}
							onChange={(event) => setImportSubtask(Number(event.target.value))}
						>
							{project.subtasks.map((item) => (
								<option key={item.id} value={item.id}>
									{item.id} · {item.score}
								</option>
							))}
						</select>
					</label>
					{error && <p role="alert">{t(error)}</p>}
					<div className="confirmation-actions">
						<button
							className="button secondary"
							type="button"
							disabled={busy}
							onClick={() => setImporting(false)}
						>
							{t("取消")}
						</button>
						<button className="button primary" type="submit" disabled={busy}>
							{t("确认加入")}
						</button>
					</div>
				</form>
			</Dialog>
		</section>
	);
}
