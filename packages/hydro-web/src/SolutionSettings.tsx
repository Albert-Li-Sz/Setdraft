import type { Solution } from "@setdraft/contracts";
import { useLocale } from "./i18n.tsx";

export function SolutionSettings({
	solution,
	primary,
	canCopy,
	onChange,
	onPrimary,
	onCopy,
	onRemove,
}: {
	solution: Solution;
	primary: boolean;
	canCopy: boolean;
	onChange(change: Partial<Solution>): void;
	onPrimary(): void;
	onCopy(): void;
	onRemove(): void;
}) {
	const { t } = useLocale();
	return (
		<div className="solution-settings">
			<div className="verification-fields">
				<label className="field">
					<span>{t("解法名称")}</span>
					<input
						value={solution.name}
						maxLength={100}
						onChange={(event) => onChange({ name: event.target.value })}
					/>
				</label>
				<label className="field">
					<span>{t("用途")}</span>
					<select
						aria-label={t("用途")}
						value={solution.purpose}
						onChange={(event) => onChange({ purpose: event.target.value as Solution["purpose"] })}
					>
						{Object.entries({
							accepted: "正确解法",
							brute: "暴力解法",
							wrong: "已知 WA",
							slow: "预期 TLE",
							partial: "部分分解法",
						}).map(([value, name]) => (
							<option key={value} value={value}>
								{t(name)}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>{t("预期结果")}</span>
					<select
						aria-label={t("预期结果")}
						value={solution.expectation.kind}
						disabled={primary}
						onChange={(event) =>
							onChange({
								expectation:
									event.target.value === "score"
										? { kind: "score", min: 0, max: 50 }
										: { kind: event.target.value as "AC" | "WA" | "TLE" },
							})
						}
					>
						{["AC", "WA", "TLE", "score"].map((value) => (
							<option key={value} value={value}>
								{value === "score" ? t("总分区间") : value}
							</option>
						))}
					</select>
				</label>
				<label className="field">
					<span>{t("发布要求")}</span>
					<select
						aria-label={t("发布要求")}
						value={solution.required ? "required" : "observe"}
						disabled={primary}
						onChange={(event) => onChange({ required: event.target.value === "required" })}
					>
						<option value="observe">{t("仅观察")}</option>
						<option value="required">{t("必检")}</option>
					</select>
				</label>
				{solution.expectation.kind === "score" &&
					["min", "max"].map((bound) => (
						<label className="field" key={bound}>
							<span>{t(bound === "min" ? "最低总分" : "最高总分")}</span>
							<input
								type="number"
								min={0}
								max={100}
								step="0.01"
								value={solution.expectation.kind === "score" ? solution.expectation[bound as "min" | "max"] : 0}
								onChange={(event) => {
									if (solution.expectation.kind === "score")
										onChange({
											expectation: { ...solution.expectation, [bound]: Number(event.target.value) },
										});
								}}
							/>
						</label>
					))}
			</div>
			<div className="heading-actions">
				<button className="button secondary" type="button" disabled={primary} onClick={onPrimary}>
					{t(primary ? "主标程" : "设为主标程")}
				</button>
				<button className="button secondary" type="button" disabled={!canCopy} onClick={onCopy}>
					{t("复制解法")}
				</button>
				<button className="button secondary" type="button" disabled={primary} onClick={onRemove}>
					{t("删除解法")}
				</button>
			</div>
			<p className="manual-muted">
				{t(
					primary
						? "主标程用于生成答案，必须全部测试点满分。"
						: "WA / TLE 须至少命中一次，其余测试点为 AC；部分分按完整数据集判断。",
				)}
			</p>
		</div>
	);
}
