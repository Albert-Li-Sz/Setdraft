import { type ProblemType, problemTypeNames, problemTypes } from "@setdraft/contracts";
import { useId } from "react";
import { useLocale } from "./i18n.tsx";

export const typeDescriptions: Record<ProblemType, string> = {
	standard: "运行程序后，与标准答案进行文本比较。",
	special: "运行程序后，由自定义 Checker 判定输出。",
	interactive: "选手程序与 Interactor 完成一次双向交互。",
	communication: "同一程序启动两轮，由通信裁判传递信息；每轮独立限额。",
};
export function ProblemTypeSelect({
	value,
	disabled,
	onChange,
}: {
	value: ProblemType;
	disabled?: boolean;
	onChange(value: ProblemType): void;
}) {
	const { t } = useLocale();
	const descriptionId = useId();
	return (
		<label className="field problem-type-select">
			<span>{t("题型")}</span>
			<select
				aria-label={t("题型")}
				aria-describedby={descriptionId}
				value={value}
				disabled={disabled}
				onChange={(event) => onChange(event.target.value as ProblemType)}
			>
				{problemTypes.map((type) => (
					<option key={type} value={type}>
						{t(problemTypeNames[type])}
					</option>
				))}
			</select>
			<small id={descriptionId}>{t(typeDescriptions[value])}</small>
		</label>
	);
}
