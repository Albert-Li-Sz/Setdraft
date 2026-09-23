import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AgentRun, type AuthoringReport, agentStatusLabel, apiUrl, isTerminalAgentRun } from "./platform.ts";

interface Props {
	run: AgentRun;
	apiOrigin: string;
	className: string;
	busy: boolean;
	available: boolean;
	hasReferenceProgram: boolean;
	message: string;
	onMessageChange: (message: string) => void;
	onContinue: (message: string) => Promise<boolean>;
	onRetry: () => Promise<boolean>;
	onCancel: () => void;
	onEditProgram: () => void;
	liveHydroConfigured: boolean;
	liveBusy: boolean;
	onLiveVerify: () => void;
}

function useElapsed(startedAt: string | undefined, active: boolean): string {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!active || !startedAt) return;
		const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
		return () => window.clearInterval(timer);
	}, [active, startedAt]);
	if (!startedAt) return "";
	const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function AgentRunPanel(props: Props) {
	const { message, onMessageChange: setMessage } = props;
	const { run } = props;
	const canContinue = ["needs_input", "failed", "cancelled"].includes(run.status);
	const [report, setReport] = useState<AuthoringReport>();
	const [reportMessage, setReportMessage] = useState("");
	const elapsed = useElapsed(run.phaseStartedAt, run.status === "running");
	async function loadReport(): Promise<void> {
		setReportMessage("正在读取完整验证报告……");
		try {
			const response = await fetch(apiUrl(props.apiOrigin, `/runs/${run.id}/authoring-report`));
			const body = (await response.json()) as unknown;
			if (!response.ok) {
				const message =
					typeof body === "object" &&
					body !== null &&
					typeof (body as Record<string, unknown>).message === "string"
						? String((body as Record<string, unknown>).message)
						: "报告读取失败。";
				throw new Error(message);
			}
			setReport(body as AuthoringReport);
			setReportMessage("");
		} catch (error) {
			setReportMessage(error instanceof Error ? error.message : "报告读取失败。");
		}
	}
	return (
		<section className={`agent-run-panel ${props.className}`}>
			<div className="agent-run-heading">
				<div>
					<span>
						Pi Agent 任务
						{run.judgingType
							? ` · ${{ default: "普通程序题", interactive: "交互题", submit_answer: "提交答案题" }[run.judgingType]}`
							: ""}
					</span>
					<strong>{agentStatusLabel(run.status)}</strong>
				</div>
				<code>{run.id}</code>
			</div>
			{run.phaseMessage && (run.status === "running" || run.status === "queued") && (
				<output className="agent-phase">
					<span className="notice-dot" />
					<strong>{run.phaseMessage}</strong>
					{elapsed && <time>{elapsed}</time>}
				</output>
			)}
			{run.metrics && (
				<section className="agent-metrics" aria-label="任务执行统计">
					<span>
						模型 {run.metrics.modelTurns} 轮 · 等待 {Math.round(run.metrics.modelWaitMs / 1000)} 秒
					</span>
					<span>
						沙箱/工具 {Math.round(run.metrics.sandboxMs / 1000)} 秒 · {run.metrics.toolCalls} 次调用
					</span>
					<span>
						验证 quick {run.metrics.quickVerifications} 次 / full {run.metrics.fullVerifications} 次
					</span>
					<span>
						Token 输入 {run.metrics.inputTokens.toLocaleString()} / 输出{" "}
						{run.metrics.outputTokens.toLocaleString()} / 缓存读取 {run.metrics.cacheReadTokens.toLocaleString()}
					</span>
				</section>
			)}
			{(run.conversation?.length ?? 0) > 0 && (
				<details className="conversation-history">
					<summary>此前对话（{run.conversation?.length} 条）</summary>
					{run.conversation?.map((item, index) => (
						<div className="conversation-message" key={`${item.role}-${index}`}>
							<strong>{item.role === "user" ? "你的补充" : "Pi Agent"}</strong>
							<div className="agent-markdown">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
							</div>
						</div>
					))}
				</details>
			)}
			{run.assistantText && (
				<div className="agent-markdown current-reply">
					<ReactMarkdown remarkPlugins={[remarkGfm]}>{run.assistantText}</ReactMarkdown>
				</div>
			)}
			{run.error && <p className="history-message failed">{run.error}</p>}
			{canContinue && (
				<form
					className="continue-form"
					onSubmit={(event) => {
						event.preventDefault();
						void props.onContinue(message).then((ok) => {
							if (ok) setMessage("");
						});
					}}
				>
					<label htmlFor="agent-clarification">补充信息，继续当前任务</label>
					{run.status !== "needs_input" && (
						<button
							className="button primary"
							type="button"
							disabled={props.busy || !props.available}
							onClick={() => void props.onRetry()}
						>
							{props.busy ? "继续中…" : "一键继续修复"}
						</button>
					)}
					<p>补充题意或要求 Agent 修正后重试。标程可由 Agent 自动生成，原题面和此前对话会保留。</p>
					<textarea
						id="agent-clarification"
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						placeholder="例如：以题面为准，自动修正标程并完成 testlib 数据生成、校验和对拍。"
						disabled={props.busy}
					/>
					<div className="continue-options">
						<button
							className="text-button"
							type="button"
							onClick={() =>
								setMessage(
									"以当前题面为准。忽略不属于本题的旧程序、元数据或样例，自动编写正确标程、独立对拍程序、testlib 生成器与输入校验器；必要时生成 C++ testlib SPJ。运行完整验证，修复失败项后打包，无需我再上传程序。",
								)
							}
						>
							填写“以题面为准”
						</button>
						<button className="text-button" type="button" onClick={props.onEditProgram}>
							{props.hasReferenceProgram ? "已附加标准程序 · 编辑" : "添加标准程序"}
						</button>
					</div>
					<button
						className="button primary"
						type="submit"
						disabled={!message.trim() || props.busy || !props.available}
					>
						{props.busy ? "提交中…" : "提交补充并继续"}
					</button>
					{!props.available && (
						<p>
							<a href="#settings">配置 AI API</a> 后即可继续。
						</p>
					)}
				</form>
			)}
			<div className="agent-run-actions">
				{run.artifact?.authoring && (
					<a
						href={apiUrl(props.apiOrigin, `/runs/${run.id}/authoring`)}
						download={`${run.artifact.slug}.authoring.zip`}
					>
						下载制题工程（标程 / testlib / SPJ）
					</a>
				)}
				{!isTerminalAgentRun(run.status) && (
					<button type="button" onClick={props.onCancel}>
						取消任务
					</button>
				)}
				{run.status === "succeeded" && run.artifact && (
					<a href={apiUrl(props.apiOrigin, `/runs/${run.id}/archive`)} download={`${run.artifact.slug}.hydro.zip`}>
						下载 Hydro 包
					</a>
				)}
				{run.status === "succeeded" && run.artifact?.authoring && props.liveHydroConfigured && (
					<button type="button" onClick={props.onLiveVerify} disabled={props.liveBusy}>
						{props.liveBusy ? "Hydro 实测中…" : "运行 Hydro 实测"}
					</button>
				)}
			</div>
			{run.artifact?.authoring && (
				<section className="sandbox-results">
					<strong>testlib 制题验证通过</strong>
					<p>
						{run.artifact.authoring.testCases} 个测试点 · {run.artifact.authoring.generatedCases} 个生成点 ·{" "}
						{run.artifact.authoring.oracleCases} 次独立对拍 · {run.artifact.authoring.validatorNegativeCases}{" "}
						个非法输入已拒绝 · {run.artifact.authoring.wrongPrograms} 个错误程序已检出
					</p>
					<p>
						{run.artifact.authoring.checker === "testlib"
							? `C++ testlib SPJ · ${run.artifact.authoring.checkerProbes} 个判定探针通过`
							: "Hydro 默认比较器"}
					</p>
					<div className="report-actions">
						<button type="button" onClick={() => void loadReport()} disabled={report !== undefined}>
							{report ? "完整报告已加载" : "加载完整执行记录"}
						</button>
						{reportMessage && <span>{reportMessage}</span>}
					</div>
					{report && (
						<details open>
							<summary>执行记录（{report.checks.length} 项）</summary>
							{report.checks.map((check, index) => (
								<div key={`${check.stage}-${index}`}>
									{check.passed ? "✓" : "!"} {check.stage}
									{check.caseId ? ` · ${check.caseId}` : ""}
									<pre>{check.message}</pre>
								</div>
							))}
						</details>
					)}
				</section>
			)}
			{run.artifact?.liveVerification && (
				<section className={`sandbox-results ${run.artifact.liveVerification.success ? "passed" : "failed"}`}>
					<strong>
						{run.artifact.liveVerification.success ? "真实 Hydro 实测通过" : "真实 Hydro 实测未通过"}
					</strong>
					<p>{run.artifact.liveVerification.message}</p>
					<p>
						标程 {run.artifact.liveVerification.reference.verdict}
						{run.artifact.liveVerification.reference.score === undefined
							? ""
							: ` / ${run.artifact.liveVerification.reference.score} 分`}
						· {run.artifact.liveVerification.wrongPrograms.length} 个错误程序已提交
					</p>
					{run.artifact.liveVerification.problemUrl && (
						<a href={run.artifact.liveVerification.problemUrl} target="_blank" rel="noreferrer">
							打开 Hydro 题目
						</a>
					)}
				</section>
			)}
		</section>
	);
}
