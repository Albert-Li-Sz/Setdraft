import type {
	AuthoringTarget,
	BoundaryCondition,
	BoundaryRule,
	DataQualityReport,
	ProjectSnapshot,
	PublicationReadiness,
} from "@setdraft/contracts";
import { useState } from "react";
import { createClientId } from "./browser-capabilities.ts";
import { useLocale } from "./i18n.tsx";

const stateNames = {
	ready: "就绪",
	pending: "待验证",
	error: "需处理",
	warning: "提示",
	detected: "已检出",
	"all-ac": "全部 AC",
	incomplete: "结果不完整",
};
interface StatusProps {
	loading: boolean;
	dirty: boolean;
	error: string;
	refresh(): void;
}
function ReportStatus({ loading, dirty, error, refresh }: StatusProps) {
	const { t } = useLocale();
	return (
		<div className="insight-status">
			<p role={error ? "alert" : "status"} className={error ? "insight-problem" : undefined}>
				{t(
					error ||
						(dirty
							? "保存完成后更新报告；未保存修改不计入报告。"
							: loading
								? "正在检查当前版本…"
								: "报告仅使用当前版本的完整评测结果。"),
				)}
			</p>
			<button type="button" className="text-button" disabled={loading || dirty} onClick={refresh}>
				{t("刷新报告")}
			</button>
		</div>
	);
}

function BoundaryEditor({
	project,
	disabled,
	onChange,
}: {
	project: ProjectSnapshot;
	disabled: boolean;
	onChange(value: BoundaryCondition[]): void;
}) {
	const { t } = useLocale();
	const [name, setName] = useState("");
	const [kind, setKind] = useState<BoundaryRule["kind"]>("cases");
	const [token, setToken] = useState("1"),
		[minimum, setMinimum] = useState(""),
		[maximum, setMaximum] = useState("");
	const [selected, setSelected] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [editing, setEditing] = useState<string>();
	const boundaries = project.boundaryConditions ?? [];
	const emptyInput = project.judgingMode === "interactive" && project.interactionInputMode === "empty";
	const caseIds = emptyInput ? ["manual:interactive-empty"] : project.cases.map((item) => `${item.origin}:${item.id}`);
	const submit = () => {
		if (!name.trim()) {
			setError("请填写边界条件名称。");
			return;
		}
		let rule: BoundaryRule = { kind: "cases", caseIds: selected };
		if (kind === "integer") {
			if (
				!Number.isSafeInteger(Number(token)) ||
				Number(token) < 1 ||
				Number(token) > 10000 ||
				(!minimum && !maximum) ||
				[minimum, maximum].some((value) => value && !/^-?\d{1,100}$/u.test(value)) ||
				(minimum && maximum && BigInt(minimum) > BigInt(maximum))
			) {
				setError("请填写有效整数位置与范围。");
				return;
			}
			rule = { kind, token: Number(token), min: minimum || undefined, max: maximum || undefined };
		}
		const entry = { id: editing ?? createClientId(), name: name.trim(), rule };
		onChange(editing ? boundaries.map((item) => (item.id === editing ? entry : item)) : [...boundaries, entry]);
		setName("");
		setSelected([]);
		setError("");
		setEditing(undefined);
	};
	return (
		<details className="insight-boundaries">
			<summary>
				{t("声明边界条件")} · {boundaries.length}
			</summary>
			<p className="manual-muted">
				{t("关联测试点由作者确认语义覆盖；整数规则按空白分隔的第 N 个输入值检查，不推断其他语义。")}
			</p>
			<div className="boundary-list">
				{boundaries.map((entry) => (
					<div key={entry.id} className="boundary-item">
						<strong>{entry.name}</strong>
						<span>
							{entry.rule.kind === "cases"
								? t("作者关联 {0} 个测试点", entry.rule.caseIds.length)
								: t(
										"第 {0} 个整数：{1}～{2}",
										entry.rule.token,
										entry.rule.min ?? "−∞",
										entry.rule.max ?? "+∞",
									)}
						</span>
						<button
							type="button"
							className="button secondary"
							disabled={disabled}
							onClick={() => {
								setEditing(entry.id);
								setName(entry.name);
								setKind(entry.rule.kind);
								if (entry.rule.kind === "cases") setSelected(entry.rule.caseIds);
								else {
									setToken(String(entry.rule.token));
									setMinimum(entry.rule.min ?? "");
									setMaximum(entry.rule.max ?? "");
								}
							}}
						>
							{t("编辑")}
						</button>
						<button
							type="button"
							className="button secondary"
							disabled={disabled}
							onClick={() => onChange(boundaries.filter((item) => item.id !== entry.id))}
							aria-label={t("删除边界条件 {0}", entry.name)}
						>
							{t("删除")}
						</button>
					</div>
				))}
			</div>
			<fieldset disabled={disabled || (!editing && boundaries.length >= 32)} className="boundary-form">
				<label>
					{t("边界条件名称")}
					<input
						value={name}
						maxLength={120}
						onChange={(event) => setName(event.target.value)}
						placeholder={t("例如：n = 1、最大数据、全相等")}
					/>
				</label>
				<label>
					{t("覆盖依据")}
					<select value={kind} onChange={(event) => setKind(event.target.value as BoundaryRule["kind"])}>
						<option value="cases">{t("作者关联测试点")}</option>
						<option value="integer" disabled={emptyInput}>
							{t("输入整数范围")}
						</option>
					</select>
				</label>
				{kind === "integer" ? (
					<div className="boundary-range">
						<label>
							{t("整数位置（从 1 开始）")}
							<input
								type="number"
								min={1}
								max={10000}
								value={token}
								onChange={(event) => setToken(event.target.value)}
							/>
						</label>
						<label>
							{t("最小值（含）")}
							<input inputMode="numeric" value={minimum} onChange={(event) => setMinimum(event.target.value)} />
						</label>
						<label>
							{t("最大值（含）")}
							<input inputMode="numeric" value={maximum} onChange={(event) => setMaximum(event.target.value)} />
						</label>
					</div>
				) : (
					<fieldset className="boundary-cases">
						<legend>{t("关联测试点")}</legend>
						{caseIds.map((id) => {
							return (
								<label key={id}>
									<input
										type="checkbox"
										checked={selected.includes(id)}
										onChange={(event) =>
											setSelected((values) =>
												event.target.checked ? [...values, id] : values.filter((value) => value !== id),
											)
										}
									/>
									{id}
								</label>
							);
						})}
					</fieldset>
				)}
				<button className="button secondary" type="button" onClick={submit}>
					{t(editing ? "保存边界条件" : "添加边界条件")}
				</button>
				{editing && (
					<button
						className="button secondary"
						type="button"
						onClick={() => {
							setEditing(undefined);
							setName("");
							setSelected([]);
							setError("");
						}}
					>
						{t("取消")}
					</button>
				)}
			</fieldset>
			{error && (
				<p role="alert" className="insight-problem">
					{t(error)}
				</p>
			)}
		</details>
	);
}

export function DataQualityPanel({
	report,
	titleId,
	project,
	disabled,
	onChange,
	onNavigate,
	...status
}: StatusProps & {
	report?: DataQualityReport;
	titleId?: string;
	project: ProjectSnapshot;
	disabled: boolean;
	onChange(value: BoundaryCondition[]): void;
	onNavigate(target: AuthoringTarget): void;
}) {
	const { t } = useLocale();
	const allAcCount = report?.faults.filter((fault) => fault.state === "all-ac").length ?? 0;
	return (
		<section className="authoring-insight" id="data-quality" tabIndex={-1}>
			<div className="manual-section-heading">
				<div>
					<h2 id={titleId}>{t("数据质量报告")}</h2>
					<p>{t("重复、配分、错误解检出与边界覆盖；质量提示不新增发布门槛。")}</p>
				</div>
				{report && <span className="insight-version">{t("版本 {0}", report.revision)}</span>}
			</div>
			<ReportStatus {...status} />
			{report && (
				<>
					<div className="insight-summary">
						<span>{t("测试点 {0}", report.caseCount)}</span>
						<span className={report.duplicates.length ? "insight-problem" : undefined}>
							{t("重复组 {0}", report.duplicates.length)}
						</span>
						<span className={allAcCount ? "insight-problem" : undefined}>
							{t("全部 AC 的错误解 {0}", allAcCount)}
						</span>
					</div>
					{report.intentionalEmpty && (
						<p>{t("无测试输入模式的空测试点为预期数据，隐藏数据不参与本次质量检查。")}</p>
					)}
					{report.issues.length ? (
						<ul className="insight-issues">
							{report.issues.map((issue, index) => (
								<li key={`${issue.code}:${index}`} className="insight-problem">
									<span className="insight-state">{t(issue.severity === "error" ? "需处理" : "提示")}</span>
									{"："}
									<span>{t(issue.message)}</span>
									<button type="button" className="text-button" onClick={() => onNavigate(issue.target)}>
										{t("查看")}
									</button>
								</li>
							))}
						</ul>
					) : (
						<p>{t("未发现数据结构问题。")}</p>
					)}
					<details>
						<summary>{t("子任务与配分")}</summary>
						<ul className="insight-issues">
							{report.subtasks.map((item) => (
								<li
									key={item.id}
									className={!item.caseCount || item.zeroPointCases.length ? "insight-problem" : undefined}
								>
									{t(
										"子任务 {0}：{1} 分，{2} 个测试点，零分点 {3}",
										item.id,
										item.score,
										item.caseCount,
										item.zeroPointCases.length,
									)}
								</li>
							))}
						</ul>
					</details>
					<h3>{t("错误解检出情况")}</h3>
					{!report.faults.length && (
						<p className="manual-muted">{t("添加设置了错误预期的程序，再运行完整矩阵或压力测试。")}</p>
					)}
					<div className="fault-detection-list">
						{report.faults.map((fault) => (
							<article
								key={fault.solutionId}
								className={`fault-detection${fault.state === "all-ac" || fault.state === "incomplete" || fault.matches === false ? " insight-problem" : ""}`}
								data-state={fault.state}
							>
								<div>
									<strong>{fault.name}</strong>
									<span className="insight-state">· {t(stateNames[fault.state])}</span>
									<span className="insight-state">· {t(fault.required ? "必检" : "仅观察")}</span>
								</div>
								<p>
									{fault.state === "all-ac"
										? t("此错误解通过全部数据，请补充能够检出的测试点。")
										: fault.state === "incomplete"
											? t("存在编译失败、系统错误或未完成结果，不能证明检出覆盖。")
											: fault.state === "pending"
												? t("尚无当前版本的完整结果。")
												: t(
														"被 {0} 个测试点检出；预期{1}。",
														fault.caseIds.length,
														t(fault.matches ? "满足" : "不满足"),
													)}
								</p>
								<div className="insight-case-links">
									{fault.caseIds.map((id) => (
										<button
											className="text-button"
											type="button"
											key={id}
											onClick={() => onNavigate({ tab: "data", caseId: id })}
										>
											{id}
										</button>
									))}
									<button
										className="text-button"
										type="button"
										onClick={() => onNavigate({ tab: "programs", solutionId: fault.solutionId })}
									>
										{t("查看程序")}
									</button>
								</div>
							</article>
						))}
					</div>
					<h3>{t("测试点区分能力")}</h3>
					{report.discriminationComplete ? (
						report.undistinguishedCaseIds.length ? (
							<>
								<p className="insight-problem">
									{t("以下测试点未检出任何已测错误解；这不代表它们没有边界或计分价值。")}
								</p>
								<div className="insight-case-links insight-problem">
									{report.undistinguishedCaseIds.map((id) => (
										<button
											type="button"
											className="text-button"
											key={id}
											onClick={() => onNavigate({ tab: "data", caseId: id })}
										>
											{id}
										</button>
									))}
								</div>
							</>
						) : (
							<p>{t("每个测试点至少检出一个错误解。")}</p>
						)
					) : (
						<p className="manual-muted">{t("请完整运行所有错误解后再判断测试点区分能力。")}</p>
					)}
					{!!report.boundaries.length && (
						<>
							<h3>{t("边界覆盖")}</h3>
							<ul className="insight-issues">
								{report.boundaries.map((boundary) => (
									<li
										key={boundary.id}
										className={
											!boundary.caseIds.length || boundary.missingCaseIds.length
												? "insight-problem"
												: undefined
										}
									>
										<strong>{boundary.name}</strong>
										{" · "}
										<span className="insight-state">{t(boundary.caseIds.length ? "已覆盖" : "未覆盖")}</span>
										{" · "}
										<span>
											{t(
												"{0} 个测试点 · {1}",
												boundary.caseIds.length,
												t(boundary.kind === "cases" ? "作者关联" : "整数规则"),
											)}
										</span>
									</li>
								))}
							</ul>
						</>
					)}
				</>
			)}
			<BoundaryEditor key={project.id} project={project} disabled={disabled} onChange={onChange} />
		</section>
	);
}

export function PublicationReadinessPanel({
	report,
	titleId,
	onNavigate,
	...status
}: StatusProps & { report?: PublicationReadiness; titleId?: string; onNavigate(target: AuthoringTarget): void }) {
	const { t } = useLocale();
	return (
		<section className="authoring-insight publication-readiness" aria-label={t("发布准备")}>
			<div className="manual-section-heading">
				<div>
					<h2 id={titleId}>{t("发布准备")}</h2>
					<p>{t("集中检查发布所需内容；观察项提供提示，发布仍执行原有完整验证。")}</p>
				</div>
			</div>
			<ReportStatus {...status} />
			{report && (
				<>
					<div className="readiness-list">
						{report.checks.map((check) => (
							<button
								type="button"
								className={`readiness-item${check.state === "error" || check.state === "warning" ? " insight-problem" : ""}`}
								key={check.id}
								onClick={() => onNavigate(check.target)}
							>
								<span className="insight-state">{t(stateNames[check.state])}</span>
								<span>
									<strong>{t(check.label)}</strong>
									{"："}
									{t(check.message)}
								</span>
								<span aria-hidden="true">→</span>
							</button>
						))}
					</div>
					<details>
						<summary>{t("平台兼容状态")}</summary>
						<p className="manual-muted">{t("这里展示导出能力，不代表目标平台已经导入并评测通过。")}</p>
						<ul className="insight-issues">
							{report.platforms.map((platform) => (
								<li key={platform.id} className={platform.supported ? undefined : "insight-problem"}>
									<strong>
										{platform.id === "hydro"
											? "Hydro"
											: platform.id === "domjudge"
												? "DOMjudge"
												: platform.id.toUpperCase()}
									</strong>
									{" · "}
									<span className="insight-state">{t(platform.supported ? "支持导出" : "暂不支持")}</span>
									{" · "}
									<span>{t(platform.reason)}</span>
								</li>
							))}
						</ul>
					</details>
				</>
			)}
		</section>
	);
}
