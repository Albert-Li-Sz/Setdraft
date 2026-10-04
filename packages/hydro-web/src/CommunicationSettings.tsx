import {
	type CommunicationConfig,
	communicationCompileStandard,
	communicationJudgeTemplate,
	communicationReferenceTemplate,
	type ProjectSnapshot,
} from "@setdraft/contracts";
import { useState } from "react";
import { useLocale } from "./i18n.tsx";
import { ProgramEditor } from "./ProgramEditor.tsx";

export function CommunicationSettings({
	project,
	disabled,
	onChange,
	onReference,
	onImport,
}: {
	project: ProjectSnapshot;
	disabled: boolean;
	onChange(config: CommunicationConfig): void;
	onReference(language: "cpp17" | "python3" | "java", code: string): void;
	onImport(file: File): Promise<void>;
}) {
	const { t } = useLocale();
	const config = project.communication ?? { judgeSource: "", judgeStandard: "cpp17", secondRound: "interactive" };
	const [language, setLanguage] = useState<"cpp17" | "python3" | "java">("cpp17");
	return (
		<fieldset className="communication-settings" disabled={disabled}>
			<legend>{t("通信设置")}</legend>
			<ol className="communication-flow">
				<li>{t("第一轮")}</li>
				<li>{t("信息交接")}</li>
				<li>{t("第二轮")}</li>
			</ol>
			<label className="field">
				<span>{t("第二轮判定")}</span>
				<select
					aria-label={t("第二轮判定")}
					value={config.secondRound}
					onChange={(event) =>
						onChange({ ...config, secondRound: event.target.value as CommunicationConfig["secondRound"] })
					}
				>
					<option value="interactive">{t("继续交互（默认）")}</option>
					<option value="text">{t("文本比较")}</option>
					<option value="custom">{t("特判 Checker")}</option>
				</select>
			</label>
			{config.secondRound === "text" && (
				<p className="manual-muted">
					{t("文本比较统一换行，忽略行尾空格、制表符和末尾空行；内部空格、大小写与数字写法必须一致。")}
				</p>
			)}
			{config.secondRound === "custom" && (
				<p className="manual-muted">
					{t(
						"通信裁判与 Checker 共用 {0} 编译，取各自设置的较高标准。",
						communicationCompileStandard(config, project.checkerStandard).replace("cpp", "C++"),
					)}
				</p>
			)}
			<p className="manual-muted">
				{t(
					"两轮使用全新进程和临时目录。第一轮不计分，第二轮决定分数；第一轮失败将跳过第二轮。耗时与内存显示两轮最大值。",
				)}
			</p>
			<div className="manual-code-actions">
				<button
					type="button"
					className="button secondary"
					onClick={() => {
						if (!config.judgeSource.trim() || window.confirm(t("覆盖现有通信裁判代码？")))
							onChange({
								...config,
								judgeSource: communicationJudgeTemplate(project.interactionInputMode ?? "provided"),
							});
					}}
				>
					{t("导入通信裁判模板")}
				</button>
				<select
					aria-label={t("配套标程语言")}
					value={language}
					onChange={(event) => setLanguage(event.target.value as typeof language)}
				>
					<option value="cpp17">C++17</option>
					<option value="python3">Python 3</option>
					<option value="java">Java</option>
				</select>
				<button
					type="button"
					className="button secondary"
					onClick={() => {
						if (!project.reference.code.trim() || window.confirm(t("覆盖现有标准程序？")))
							onReference(language, communicationReferenceTemplate(language));
					}}
				>
					{t("导入配套标程")}
				</button>
			</div>
			<ProgramEditor
				label={t("通信裁判 · C++ testlib")}
				language={config.judgeStandard}
				code={config.judgeSource}
				onChange={(language, code) => {
					if (language.startsWith("cpp"))
						onChange({
							...config,
							judgeStandard: language as CommunicationConfig["judgeStandard"],
							judgeSource: code,
						});
				}}
				onImport={onImport}
				cppOnly
			/>
			<p className="manual-muted">
				{t(
					"通过 communicationRound() 取得轮次；inf 读取原始私有输入；communicationHandoff() 读取交接；saveCommunicationHandoff(信息, 第二轮输入) 保存交接。模板向选手发送 first／second。",
				)}
			</p>
		</fieldset>
	);
}
