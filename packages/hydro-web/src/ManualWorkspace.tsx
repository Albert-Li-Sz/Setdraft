import { useRef, useState } from "react";
import { CodeMirrorEditor } from "./CodeMirrorEditor.tsx";
import { type CheckerPreset, checkerPresets } from "./checker-presets.ts";
import { ProblemPreview } from "./ProblemPreview.tsx";
import {
	apiUrl,
	type CppLanguage,
	cppLanguageOptions,
	type ManualRelease,
	type ManualReport,
	type ProgramLanguage,
	type ProjectSnapshot,
	type SandboxStatus,
} from "./platform.ts";
import { parseTags } from "./problem.ts";

type Tab = "statement" | "data" | "generator" | "programs" | "validation";
type ProgramSection = "reference" | "oracle" | "checker" | "validator";
type Busy = "upload" | "generate" | "finalize" | "live" | undefined;
const checkLabels: Record<string, string> = {
	"compile:oracle": "编译第二标准程序",
	oracle: "运行第二标准程序",
	"oracle-compare": "第二标准程序核验",
};

interface Props {
	apiOrigin: string;
	project: ProjectSnapshot;
	release?: ManualRelease;
	report?: ManualReport;
	sandbox?: SandboxStatus;
	liveHydroConfigured: boolean;
	busy: Busy;
	saveStatus: string;
	notice: string;
	noticeTone: "pending" | "passed" | "failed";
	onEdit(change: (current: ProjectSnapshot) => ProjectSnapshot): void;
	onUpload(files: File[]): Promise<void>;
	onAddCase(value: { name?: string; input: string; output?: string; subtaskId: number }): Promise<void>;
	onUploadAttachments(files: File[]): Promise<void>;
	onUploadDomjudgePdf(file: File): Promise<void>;
	onDeleteDomjudgePdf(): Promise<void>;
	onDeleteFile(name: string): Promise<void>;
	onGenerate(): Promise<void>;
	onFinalize(): Promise<void>;
	onNew(): Promise<void>;
	onLiveVerify(): Promise<void>;
}

function CodeEditor(props: {
	label: string;
	value: string;
	onChange(value: string): void;
	standard?: CppLanguage;
	onStandardChange?(standard: CppLanguage): void;
	accept?: string;
	help?: string;
	syntax?: "cpp" | "gen-script";
	previewLines?: number;
}) {
	return (
		<section className="manual-code-block">
			<div className="manual-code-heading">
				<div>
					<h3>{props.label}</h3>
					{props.help && <p>{props.help}</p>}
				</div>
				<div className="manual-code-actions">
					{props.standard && (
						<select
							aria-label={`${props.label}C++标准`}
							value={props.standard}
							onChange={(event) => props.onStandardChange?.(event.target.value as CppLanguage)}
						>
							{cppLanguageOptions.map((option) => (
								<option value={option.value} key={option.value}>
									{option.label}
								</option>
							))}
						</select>
					)}
					<label className="button secondary manual-file-button">
						上传源码
						<input
							type="file"
							accept={props.accept ?? ".cpp,.cc,.cxx,.txt"}
							onChange={(event) => {
								const file = event.currentTarget.files?.[0];
								if (file) void file.text().then(props.onChange);
								event.currentTarget.value = "";
							}}
						/>
					</label>
				</div>
			</div>
			<CodeMirrorEditor
				value={props.value}
				language={props.syntax === "gen-script" ? "gen-script" : (props.standard ?? "cpp17")}
				previewLines={props.previewLines}
				onChange={props.onChange}
				ariaLabel={props.label}
			/>
		</section>
	);
}

function ProgramEditor(props: {
	label: string;
	language: ProgramLanguage;
	code: string;
	optional?: boolean;
	onChange(language: ProgramLanguage, code: string): void;
}) {
	return (
		<section className="manual-code-block">
			<div className="manual-code-heading">
				<div>
					<h3>
						{props.label}
						{props.optional && <span className="manual-optional">可选</span>}
					</h3>
				</div>
				<div className="manual-code-actions">
					<select
						aria-label={`${props.label}语言`}
						value={props.language}
						onChange={(event) => props.onChange(event.target.value as ProgramLanguage, props.code)}
					>
						{cppLanguageOptions.map((option) => (
							<option value={option.value} key={option.value}>
								{option.label}
							</option>
						))}
						<option value="python3">Python 3</option>
						<option value="java">Java</option>
					</select>
					<label className="button secondary manual-file-button">
						上传程序
						<input
							type="file"
							accept=".cpp,.cc,.cxx,.py,.java,.txt"
							onChange={(event) => {
								const file = event.currentTarget.files?.[0];
								if (file)
									void file
										.text()
										.then((code) =>
											props.onChange(
												file.name.endsWith(".py")
													? "python3"
													: file.name.endsWith(".java")
														? "java"
														: props.language.startsWith("cpp")
															? props.language
															: "cpp17",
												code,
											),
										);
								event.currentTarget.value = "";
							}}
						/>
					</label>
				</div>
			</div>
			<CodeMirrorEditor
				value={props.code}
				language={props.language}
				previewLines={20}
				onChange={(code) => props.onChange(props.language, code)}
				ariaLabel={`${props.label}源码`}
			/>
		</section>
	);
}

export function ManualWorkspace(props: Props) {
	const { project } = props;
	const [tab, setTab] = useState<Tab>("statement");
	const [programSection, setProgramSection] = useState<ProgramSection>("reference");
	const [pendingCheckerPreset, setPendingCheckerPreset] = useState<
		{ projectId: string; preset: CheckerPreset } | undefined
	>();
	const [caseName, setCaseName] = useState("");
	const [caseInput, setCaseInput] = useState("");
	const [caseOutput, setCaseOutput] = useState("");
	const [caseSubtaskId, setCaseSubtaskId] = useState(1);
	const [includeCaseOutput, setIncludeCaseOutput] = useState(false);
	const [caseError, setCaseError] = useState("");
	const [caseSubmitting, setCaseSubmitting] = useState(false);
	const caseSubmissionRef = useRef(false);
	const isAcm = project.scoringMode === "acm";
	const selectedCaseSubtaskId = project.subtasks.some((item) => item.id === caseSubtaskId)
		? caseSubtaskId
		: (project.subtasks[0]?.id ?? 1);
	const sampleKeys = useRef<{ projectId: string; keys: string[] }>({ projectId: project.id, keys: [] });
	if (sampleKeys.current.projectId !== project.id) sampleKeys.current = { projectId: project.id, keys: [] };
	while (sampleKeys.current.keys.length < project.samples.length) sampleKeys.current.keys.push(crypto.randomUUID());
	if (sampleKeys.current.keys.length > project.samples.length) sampleKeys.current.keys.length = project.samples.length;
	const currentRelease =
		props.release?.projectHash === props.report?.projectHash && props.report?.revision === project.revision;
	const report = props.report ?? project.lastReport;
	const reportIsCurrent =
		props.report === report &&
		(report?.mode ?? "finalize") === "finalize" &&
		report?.revision === project.revision &&
		props.saveStatus === "已保存";
	const tabItems: Array<{ id: Tab; label: string; count?: number }> = [
		{ id: "statement", label: "题面与样例" },
		{ id: "data", label: "测试数据", count: project.cases.length },
		{ id: "generator", label: "Gen 生成" },
		{ id: "programs", label: "程序与 SPJ" },
		{ id: "validation", label: "验证与发布" },
	];
	const set = <K extends keyof ProjectSnapshot>(field: K, value: ProjectSnapshot[K]) =>
		props.onEdit((current) => ({ ...current, [field]: value }));
	const programSections: Array<{ id: ProgramSection; label: string; filled: boolean; required: boolean }> = [
		{ id: "reference", label: "标准程序", filled: !!project.reference.code.trim(), required: true },
		{ id: "oracle", label: "第二标准程序", filled: !!project.oracle?.code.trim(), required: false },
		{
			id: "checker",
			label: "SPJ · C++ testlib checker",
			filled: project.checkerMode === "text" || !!project.checkerSource.trim(),
			required: true,
		},
		{
			id: "validator",
			label: "输入校验器 · C++ testlib validator",
			filled: !!project.validatorSource.trim(),
			required: false,
		},
	];
	function importCheckerPreset(preset: CheckerPreset): void {
		if (project.checkerSource.trim() && project.checkerSource !== preset.source) {
			setPendingCheckerPreset({ projectId: project.id, preset });
			return;
		}
		props.onEdit((current) => ({ ...current, checkerMode: "custom", checkerSource: preset.source }));
		setPendingCheckerPreset(undefined);
	}

	return (
		<main className="page" id="workspace">
			<div className="breadcrumb">题库 / 制题工作台 / {project.title || "未命名题目"}</div>
			<section className="page-heading">
				<div>
					<div className="eyebrow">手工制题 · {isAcm ? "ACM" : "OI"} · Docker</div>
					<h1>{project.title || "新建题目"}</h1>
					<p>上传测试数据或运行 Gen，完成沙箱验证后下载 Hydro 包。</p>
				</div>
				<div className="heading-actions">
					<button
						className="button secondary"
						type="button"
						onClick={() => void props.onNew()}
						disabled={!!props.busy}
					>
						新建题目
					</button>
					<button
						className="button primary"
						type="button"
						onClick={() => {
							setTab("validation");
							void props.onFinalize();
						}}
						disabled={!!props.busy || !project.reference.code.trim()}
					>
						{props.busy === "finalize" ? "验证中…" : "验证并打包"}
					</button>
					{props.release && (
						<a
							className="button secondary button-link"
							href={apiUrl(props.apiOrigin, `/releases/${props.release.id}/hydro`)}
							download={`${props.release.slug}.hydro.zip`}
						>
							下载 Hydro 包{currentRelease ? "" : "（历史版本）"}
						</a>
					)}
				</div>
			</section>
			<output className={`notice ${props.noticeTone}`} aria-live="polite">
				<span className="notice-dot" />
				{props.notice} · {props.saveStatus}
			</output>
			<div className="manual-layout">
				<section className="card workspace-card">
					<div className="tabs" role="tablist" aria-label="制题步骤">
						{tabItems.map((item) => (
							<button
								key={item.id}
								className={tab === item.id ? "active" : ""}
								type="button"
								onClick={() => setTab(item.id)}
							>
								{item.label}
								{item.count !== undefined && <span className="tab-count">{item.count}</span>}
							</button>
						))}
					</div>
					{tab === "statement" && (
						<div className="manual-statement">
							<div className="editor-grid">
								<div className="editor-pane">
									<div className="pane-heading">
										<strong>Markdown 题面</strong>
										<span>样例单独管理，不写入私有测试点</span>
									</div>
									<textarea
										className="statement-editor"
										value={project.statement}
										onChange={(event) => set("statement", event.target.value)}
										placeholder="粘贴题目描述、输入格式、输出格式和约束…"
										spellCheck={false}
									/>
								</div>
								<div className="preview-pane">
									<div className="pane-heading">
										<strong>Hydro 题面预览</strong>
									</div>
									<ProblemPreview project={project} />
								</div>
							</div>
							<div className="manual-section">
								<div className="manual-section-heading">
									<div>
										<h2>公开样例</h2>
										<p>只会出现在题面中，不会自动作为私有测试数据。</p>
									</div>
									<button
										className="button secondary"
										type="button"
										onClick={() => set("samples", [...project.samples, { input: "", output: "" }])}
									>
										添加样例
									</button>
								</div>
								{project.samples.map((sample, index) => (
									<div className="test-card" key={sampleKeys.current.keys[index]}>
										<div className="test-card-heading">
											<strong>样例 {index + 1}</strong>
											<button
												className="text-button danger"
												type="button"
												onClick={() => {
													sampleKeys.current.keys.splice(index, 1);
													set(
														"samples",
														project.samples.filter((_, position) => position !== index),
													);
												}}
											>
												删除
											</button>
										</div>
										<div className="test-columns">
											<label>
												<span>输入</span>
												<textarea
													value={sample.input}
													onChange={(event) =>
														set(
															"samples",
															project.samples.map((item, position) =>
																position === index ? { ...item, input: event.target.value } : item,
															),
														)
													}
												/>
											</label>
											<label>
												<span>输出</span>
												<textarea
													value={sample.output}
													onChange={(event) =>
														set(
															"samples",
															project.samples.map((item, position) =>
																position === index ? { ...item, output: event.target.value } : item,
															),
														)
													}
												/>
											</label>
										</div>
									</div>
								))}
							</div>
						</div>
					)}
					{tab === "data" && (
						<div className="tab-body manual-tab-body">
							<div className="info-strip">
								一次选择多个 .in、.out、.ans 文件，按同名主干配对。.in
								必需；未提供输出时由标程生成，已提供输出时由标程核对。单文件上限 64 MiB，项目默认上限 512 MiB。
							</div>
							<label className="button secondary manual-file-button">
								上传测试文件
								<input
									type="file"
									accept=".in,.out,.ans"
									multiple
									onChange={(event) => {
										const files = [...(event.currentTarget.files ?? [])];
										event.currentTarget.value = "";
										if (files.length) void props.onUpload(files);
									}}
								/>
							</label>
							<form
								className="manual-case-form"
								onSubmit={(event) => {
									event.preventDefault();
									if (caseSubmissionRef.current || props.busy) return;
									caseSubmissionRef.current = true;
									setCaseSubmitting(true);
									setCaseError("");
									void props
										.onAddCase({
											name: caseName.trim() || undefined,
											input: caseInput,
											output: includeCaseOutput ? caseOutput : undefined,
											subtaskId: isAcm ? 1 : selectedCaseSubtaskId,
										})
										.then(() => {
											setCaseName("");
											setCaseInput("");
											setCaseOutput("");
											setIncludeCaseOutput(false);
										})
										.catch((error: unknown) =>
											setCaseError(error instanceof Error ? error.message : "测试点保存失败。"),
										)
										.finally(() => {
											caseSubmissionRef.current = false;
											setCaseSubmitting(false);
										});
								}}
							>
								<div className="manual-case-form-heading">
									<div>
										<h2>手动添加测试点</h2>
										<p>输入留空会创建真正的空文件；空格与换行会原样保存。</p>
									</div>
									<span>每个文本栏最多 1 MiB</span>
								</div>
								<div className="manual-case-form-meta">
									<label className="field">
										<span>输入文件名</span>
										<input
											value={caseName}
											onChange={(event) => setCaseName(event.target.value)}
											placeholder="留空自动编号，如 3.in"
										/>
									</label>
									{!isAcm && (
										<label className="field">
											<span>所属子任务</span>
											<select
												value={selectedCaseSubtaskId}
												onChange={(event) => setCaseSubtaskId(Number(event.target.value))}
											>
												{project.subtasks.map((subtask) => (
													<option key={subtask.id} value={subtask.id}>
														子任务 {subtask.id}
													</option>
												))}
											</select>
										</label>
									)}
								</div>
								<div className="manual-case-form-text">
									<label className="field">
										<span>测试输入</span>
										<textarea
											value={caseInput}
											onChange={(event) => setCaseInput(event.target.value)}
											placeholder="在这里输入测试数据；无输入题可留空"
											spellCheck={false}
										/>
									</label>
									<label className="field">
										<span>期望输出（可选）</span>
										<span className="manual-case-output-toggle">
											<input
												type="checkbox"
												checked={includeCaseOutput}
												onChange={(event) => setIncludeCaseOutput(event.target.checked)}
											/>
											填写期望输出；留空则建立零字节 .out
										</span>
										<textarea
											value={caseOutput}
											onChange={(event) => setCaseOutput(event.target.value)}
											disabled={!includeCaseOutput}
											placeholder={includeCaseOutput ? "可留空" : "未勾选时由标准程序生成"}
											spellCheck={false}
										/>
									</label>
								</div>
								<div className="manual-case-form-actions">
									{caseError && <p role="alert">{caseError}</p>}
									<button
										className="button primary"
										type="submit"
										disabled={!!props.busy || caseSubmitting || project.subtasks.length === 0}
									>
										{caseSubmitting ? "保存中…" : "添加测试点"}
									</button>
								</div>
							</form>
							<div className="manual-section-heading">
								<div>
									<h2>测试点</h2>
									<p>生成点排在手动点后；重跑 Gen 原子替换上一批生成点。</p>
								</div>
							</div>
							{project.cases.length === 0 ? (
								<p className="manual-muted">尚无私有测试点。</p>
							) : (
								<div className="history-table-wrap">
									<table className="history-table">
										<thead>
											<tr>
												<th>输入</th>
												<th>输出</th>
												<th>来源</th>
												{!isAcm && <th>子任务</th>}
												<th>操作</th>
											</tr>
										</thead>
										<tbody>
											{project.cases.map((item) => (
												<tr key={`${item.origin}:${item.id}`}>
													<td>
														<a
															href={apiUrl(
																props.apiOrigin,
																`/projects/${project.id}/files/${encodeURIComponent(item.inputFile)}?origin=${item.origin}`,
															)}
															download={item.inputFile}
														>
															{item.inputFile}
														</a>
														<small>{(item.inputBytes / 1024).toFixed(1)} KiB</small>
													</td>
													<td>
														{item.outputFile ? (
															<a
																href={apiUrl(
																	props.apiOrigin,
																	`/projects/${project.id}/files/${encodeURIComponent(item.outputFile)}?origin=${item.origin}`,
																)}
																download={item.outputFile}
															>
																{item.outputFile}
															</a>
														) : (
															"标程生成"
														)}
													</td>
													<td>{item.origin === "manual" ? "手动" : "Gen"}</td>
													{!isAcm && (
														<td>
															<select
																aria-label={`${item.inputFile} 所属子任务`}
																value={item.subtaskId}
																onChange={(event) =>
																	props.onEdit((current) => ({
																		...current,
																		caseSubtasks: {
																			...current.caseSubtasks,
																			[`${item.origin}:${item.id}`]: Number(event.target.value),
																		},
																		cases: current.cases.map((entry) =>
																			entry.origin === item.origin && entry.id === item.id
																				? { ...entry, subtaskId: Number(event.target.value) }
																				: entry,
																		),
																	}))
																}
															>
																{project.subtasks.map((subtask) => (
																	<option key={subtask.id} value={subtask.id}>
																		{subtask.id}
																	</option>
																))}
															</select>
														</td>
													)}
													<td>
														{item.origin === "manual" && (
															<div className="history-actions">
																<button
																	type="button"
																	className="danger"
																	onClick={() => void props.onDeleteFile(item.inputFile)}
																>
																	删除输入
																</button>
																{item.outputFile && (
																	<button
																		type="button"
																		className="danger"
																		onClick={() => void props.onDeleteFile(item.outputFile!)}
																	>
																		删除输出
																	</button>
																)}
															</div>
														)}
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
							{project.orphanOutputs.length > 0 && (
								<p className="manual-error">缺少同名 .in：{project.orphanOutputs.join("、")}</p>
							)}
							{isAcm ? (
								<div className="info-strip">ACM 判题：所有测试点均须通过。</div>
							) : (
								<section className="manual-section">
									<div className="manual-section-heading">
										<div>
											<h2>OI 子任务</h2>
											<p>各子任务分值之和为 100；测试点按 sum、min 或 max 汇总。</p>
										</div>
										<button
											className="button secondary"
											type="button"
											onClick={() => {
												const nextId = Math.max(0, ...project.subtasks.map((item) => item.id)) + 1;
												set("subtasks", [...project.subtasks, { id: nextId, type: "sum", score: 0 }]);
											}}
										>
											添加子任务
										</button>
									</div>
									{project.subtasks.map((subtask) => (
										<div className="manual-case-form-meta" key={subtask.id}>
											<label className="field">
												<span>子任务 {subtask.id} 分值</span>
												<input
													type="number"
													min="0"
													max="100"
													value={subtask.score}
													onChange={(event) =>
														set(
															"subtasks",
															project.subtasks.map((entry) =>
																entry.id === subtask.id
																	? { ...entry, score: Number(event.target.value) }
																	: entry,
															),
														)
													}
												/>
											</label>
											<label className="field">
												<span>计分方式</span>
												<select
													value={subtask.type}
													onChange={(event) =>
														set(
															"subtasks",
															project.subtasks.map((entry) =>
																entry.id === subtask.id
																	? { ...entry, type: event.target.value as "sum" | "min" | "max" }
																	: entry,
															),
														)
													}
												>
													<option value="sum">sum</option>
													<option value="min">min</option>
													<option value="max">max</option>
												</select>
											</label>
											<button
												className="text-button danger"
												type="button"
												disabled={
													project.subtasks.length === 1 ||
													project.cases.some((item) => item.subtaskId === subtask.id)
												}
												onClick={() =>
													set(
														"subtasks",
														project.subtasks.filter((entry) => entry.id !== subtask.id),
													)
												}
											>
												删除
											</button>
										</div>
									))}
								</section>
							)}
						</div>
					)}
					{tab === "generator" && (
						<div className="tab-body manual-tab-body">
							<div className="info-strip">
								Gen 使用所选 C++ 标准编译，沙箱内提供 testlib.h。脚本每行一条 gen 命令，支持引号参数和 #
								注释，不执行 Shell
								管道或变量展开。相同参数会重跑并比对输入哈希；填写第二标准程序后还会交叉核验输出。
							</div>
							<div className="manual-generator-layout">
								<CodeEditor
									label="数据生成器 Gen"
									value={project.generatorSource}
									onChange={(value) => set("generatorSource", value)}
									standard={project.generatorStandard}
									onStandardChange={(standard) => set("generatorStandard", standard)}
									help="可直接 #include &quot;testlib.h&quot;，编译后的命令固定为 gen。"
								/>
								<CodeEditor
									label="生成脚本"
									value={project.generatorScript}
									onChange={(value) => set("generatorScript", value)}
									syntax="gen-script"
									accept=".txt,.sh,.gen"
									help="示例：gen large 1000000 100；每行生成一个测试点。"
								/>
							</div>
							<div className="manual-generate-actions">
								<button
									className="button primary"
									type="button"
									onClick={() => void props.onGenerate()}
									disabled={
										!!props.busy ||
										!project.generatorSource.trim() ||
										!project.generatorScript.trim() ||
										!project.reference.code.trim()
									}
								>
									{props.busy === "generate" ? "生成中…" : "生成并验证"}
								</button>
							</div>
						</div>
					)}
					{tab === "programs" && (
						<div className="tab-body manual-tab-body">
							<div className="info-strip">
								标准程序和 Checker 必填；第二标准程序可选，用于独立核验输出。默认 Checker 按 Hydro
								文本规则比较，也可选择预设或自定义 C++ testlib Checker。
							</div>
							<div className="manual-program-layout">
								<nav className="manual-program-menu" aria-label="程序与 SPJ 分区">
									<div className="manual-program-menu-title">程序文件</div>
									{programSections.map((section) => (
										<button
											key={section.id}
											className={programSection === section.id ? "active" : ""}
											type="button"
											aria-current={programSection === section.id ? "true" : undefined}
											onClick={() => setProgramSection(section.id)}
										>
											<span>{section.label}</span>
											<small>{section.filled ? "已填写" : section.required ? "必填" : "可选"}</small>
										</button>
									))}
								</nav>
								<div className="manual-program-panel">
									{programSection === "reference" && (
										<ProgramEditor
											label="标准程序"
											language={project.reference.language}
											code={project.reference.code}
											onChange={(language, code) => set("reference", { language, code })}
										/>
									)}
									{programSection === "oracle" && (
										<ProgramEditor
											label="第二标准程序"
											optional
											language={project.oracle?.language ?? "cpp17"}
											code={project.oracle?.code ?? ""}
											onChange={(language, code) =>
												set("oracle", code.trim() ? { language, code } : undefined)
											}
										/>
									)}
									{programSection === "checker" && (
										<>
											<div className="manual-checker-presets">
												<div className="manual-checker-presets-heading">
													<strong>预设 Checker</strong>
													<span>点击导入可编辑的 testlib 源码，发布前仍需完整验证。</span>
												</div>
												<div className="manual-checker-preset-list">
													{checkerPresets.map((preset) => (
														<button
															key={preset.id}
															type="button"
															onClick={() => importCheckerPreset(preset)}
														>
															<strong>{preset.label}</strong>
															<span>{preset.description}</span>
														</button>
													))}
												</div>
												{pendingCheckerPreset?.projectId === project.id && (
													<div className="manual-checker-replace" role="alert">
														<span>导入 {pendingCheckerPreset.preset.label} 会覆盖现有 SPJ 源码。</span>
														<button
															className="button primary"
															type="button"
															onClick={() => {
																props.onEdit((current) => ({
																	...current,
																	checkerMode: "custom",
																	checkerSource: pendingCheckerPreset.preset.source,
																}));
																setPendingCheckerPreset(undefined);
															}}
														>
															确认覆盖
														</button>
														<button
															className="button secondary"
															type="button"
															onClick={() => setPendingCheckerPreset(undefined)}
														>
															取消
														</button>
													</div>
												)}
											</div>
											<div className="manual-checker-preset-list">
												<button type="button" onClick={() => set("checkerMode", "text")}>
													<strong>默认文本比对</strong>
													<span>统一换行，忽略行尾空格与末尾空行</span>
												</button>
												<button type="button" onClick={() => set("checkerMode", "custom")}>
													<strong>自定义 Checker</strong>
													<span>编辑 C++ testlib 判定代码</span>
												</button>
											</div>
											<p className="manual-muted">
												当前：
												{project.checkerMode === "text"
													? "文本比对 Checker"
													: project.checkerMode === "custom"
														? "自定义 Checker"
														: "旧草稿尚未选择 Checker"}
											</p>
											{project.checkerMode === "custom" && (
												<CodeEditor
													label="SPJ · C++ testlib checker"
													value={project.checkerSource}
													onChange={(value) => set("checkerSource", value)}
													standard={project.checkerStandard}
													onStandardChange={(standard) => set("checkerStandard", standard)}
													help="使用 registerTestlibCmd(argc, argv)，正确输出必须得到满分。"
													previewLines={20}
												/>
											)}
										</>
									)}
									{programSection === "validator" && (
										<CodeEditor
											label="输入校验器 · C++ testlib validator"
											value={project.validatorSource}
											onChange={(value) => set("validatorSource", value)}
											standard={project.validatorStandard}
											onStandardChange={(standard) => set("validatorStandard", standard)}
											help="使用 registerValidation(argc, argv) 校验所有正式输入。"
											previewLines={20}
										/>
									)}
								</div>
							</div>
						</div>
					)}
					{tab === "validation" && (
						<div className="tab-body manual-tab-body">
							<div className="manual-section-heading">
								<div>
									<h2>完整验证</h2>
									<p>编译、生成复现、输入校验、标准程序、可选第二标准程序与 Checker 判定均通过后才发放包。</p>
								</div>
								<button
									className="button primary"
									type="button"
									onClick={() => void props.onFinalize()}
									disabled={!!props.busy || !project.reference.code.trim()}
								>
									{props.busy === "finalize" ? "验证中…" : "验证并打包"}
								</button>
							</div>
							{report ? (
								<>
									<div className={`manual-report-status ${report.success ? "passed" : "failed"}`}>
										<strong>
											{report.mode === "generate"
												? report.success
													? "Gen 生成与验证通过 · 尚需完整验证"
													: "Gen 生成或验证未通过"
												: reportIsCurrent
													? report.success
														? "本地完整验证通过"
														: "本地验证未通过"
													: "历史验证报告 · 当前草稿待验证"}
										</strong>
										<span>
											版本 {report.revision ?? "—"} · {report.caseCount} 个测试点 · 标程已运行
											{report.oracleCount
												? ` · 第二标准程序核验 ${report.oracleCount} 点`
												: " · 未提供第二标准程序"}
											{report.validatorUsed ? " · 输入校验器已运行" : " · 输入约束未经校验"}
											{report.checkerUsed ? " · SPJ 已测试" : ""}
										</span>
									</div>
									<div className="manual-check-list">
										{report.checks.map((check, index) => (
											<div
												key={`${check.stage}-${check.caseId}-${index}`}
												className={`manual-check ${check.passed ? "passed" : "failed"}`}
											>
												<strong>
													{check.passed ? "通过" : "失败"} · {checkLabels[check.stage] ?? check.stage}
													{check.caseId ? ` · ${check.caseId}` : ""}
												</strong>
												<span>{check.message}</span>
											</div>
										))}
									</div>
								</>
							) : (
								<p className="manual-muted">尚未运行完整验证。</p>
							)}
							{props.release && (
								<div className="manual-release-actions">
									<a
										className="button primary button-link"
										href={apiUrl(props.apiOrigin, `/releases/${props.release.id}/hydro`)}
										download={`${props.release.slug}.hydro.zip`}
									>
										下载 Hydro 包
									</a>
									<a
										className="button secondary button-link"
										href={apiUrl(props.apiOrigin, `/releases/${props.release.id}/source`)}
										download={`${props.release.slug}.authoring.zip`}
									>
										下载制题工程
									</a>
									<a
										className="button secondary button-link"
										href={apiUrl(props.apiOrigin, `/releases/${props.release.id}/report`)}
										target="_blank"
										rel="noreferrer"
									>
										查看报告 JSON
									</a>
									{props.liveHydroConfigured && (
										<button
											className="button secondary"
											type="button"
											onClick={() => void props.onLiveVerify()}
											disabled={!!props.busy}
										>
											真实 Hydro 实测
										</button>
									)}
								</div>
							)}
							{props.release && !currentRelease && (
								<p className="manual-muted">当前草稿已修改；上方下载的是此前验证通过的版本。</p>
							)}
							{props.release?.liveVerification && (
								<div
									className={`manual-report-status ${props.release.liveVerification.success ? "passed" : "failed"}`}
								>
									<strong>真实 Hydro 实测{props.release.liveVerification.success ? "通过" : "未通过"}</strong>
									<span>
										{props.release.liveVerification.reference.verdict}
										{props.release.liveVerification.reference.score !== undefined
											? ` · ${props.release.liveVerification.reference.score} 分`
											: ""}
										{` · ${props.release.liveVerification.message}`}
									</span>
								</div>
							)}
						</div>
					)}
				</section>
				<aside className="manual-sidebar">
					<section className="card manual-side-card">
						<h2>题目配置</h2>
						<p>赛制：{isAcm ? "ACM（全部通过）" : "OI（子任务计分）"}</p>
						<label className="field">
							<span>题目标题</span>
							<input
								value={project.title}
								onChange={(event) => set("title", event.target.value)}
								placeholder="例如 A + B"
							/>
						</label>
						<label className="field">
							<span>目录标识 slug</span>
							<input
								value={project.slug}
								onChange={(event) => set("slug", event.target.value)}
								placeholder="例如 a-plus-b"
								spellCheck={false}
							/>
						</label>
						<label className="field">
							<span>标签</span>
							<input
								value={project.tags.join(", ")}
								onChange={(event) => set("tags", parseTags(event.target.value))}
								placeholder="入门, 模拟"
							/>
						</label>
						<div className="manual-limit-grid">
							<label className="field">
								<span>时间限制</span>
								<input
									value={project.timeLimit}
									onChange={(event) => set("timeLimit", event.target.value)}
									placeholder="1s"
								/>
							</label>
							<label className="field">
								<span>内存限制</span>
								<input
									value={project.memoryLimit}
									onChange={(event) => set("memoryLimit", event.target.value)}
									placeholder="256m"
								/>
							</label>
						</div>
					</section>
					<section className="card manual-side-card">
						<h2>题面附件</h2>
						<p>在题面中使用 file://文件名 引用。</p>
						<label className="button secondary manual-file-button">
							上传附件
							<input
								type="file"
								multiple
								onChange={(event) => {
									const files = [...(event.currentTarget.files ?? [])];
									event.currentTarget.value = "";
									if (files.length) void props.onUploadAttachments(files);
								}}
							/>
						</label>
						{project.attachments.map((item) => (
							<div className="manual-attachment" key={item.name}>
								<span>{item.name}</span>
								<button
									className="text-button danger"
									type="button"
									onClick={() =>
										set(
											"attachments",
											project.attachments.filter((file) => file.name !== item.name),
										)
									}
								>
									删除
								</button>
							</div>
						))}
					</section>
					{isAcm && (
						<section className="card manual-side-card">
							<h2>DOMjudge PDF</h2>
							<p>DOMjudge 包默认不含题面；上传 PDF 后才会附带原文件。</p>
							<label className="button secondary manual-file-button">
								{project.domjudgePdf ? "替换 PDF" : "上传 PDF"}
								<input
									type="file"
									accept="application/pdf,.pdf"
									onChange={(event) => {
										const file = event.currentTarget.files?.[0];
										event.currentTarget.value = "";
										if (file) void props.onUploadDomjudgePdf(file);
									}}
								/>
							</label>
							{project.domjudgePdf && (
								<div className="manual-attachment">
									<a
										href={apiUrl(props.apiOrigin, `/projects/${project.id}/domjudge-pdf`)}
										target="_blank"
										rel="noreferrer"
									>
										problem.pdf · {(project.domjudgePdf.size / 1024).toFixed(1)} KiB
									</a>
									<button
										className="text-button danger"
										type="button"
										onClick={() => void props.onDeleteDomjudgePdf()}
									>
										删除
									</button>
								</div>
							)}
						</section>
					)}
					<section className="card manual-side-card">
						<h2>运行状态</h2>
						<p>{props.sandbox?.message ?? "正在检测 Linux 沙箱…"}</p>
						<p>草稿版本：{project.revision}</p>
						<p>
							测试点：{project.cases.length}（Gen{" "}
							{project.cases.filter((item) => item.origin === "generated").length}）
						</p>
					</section>
				</aside>
			</div>
		</main>
	);
}
