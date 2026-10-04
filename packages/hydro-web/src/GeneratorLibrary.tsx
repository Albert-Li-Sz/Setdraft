import {
	type Generator,
	type GeneratorLanguage,
	nextGeneratorIndex,
	type ProjectSnapshot,
	projectGenerators,
	synchronizeGenerators,
} from "@setdraft/contracts";
import { useState } from "react";
import { createClientId } from "./browser-capabilities.ts";
import { CodeMirrorEditor } from "./CodeMirrorEditor.tsx";
import { useLocale } from "./i18n.tsx";
import { cppLanguageOptions } from "./platform.ts";

const pythonTemplate =
	"import random\nimport sys\n\nseed = int(sys.argv[1]) if len(sys.argv) > 1 else 1\nrng = random.Random(seed)\nprint(rng.randint(1, 100), rng.randint(1, 100))\n";
export function GeneratorLibrary({
	project,
	disabled,
	onEdit,
	onImport,
}: {
	project: ProjectSnapshot;
	disabled: boolean;
	onEdit(change: (current: ProjectSnapshot) => ProjectSnapshot): void;
	onImport(field: string, file: File, apply: (text: string) => void): Promise<void>;
}) {
	const { t } = useLocale();
	const generators = projectGenerators(project);
	const [selected, setSelected] = useState(generators[0]?.id ?? "");
	const [error, setError] = useState("");
	const active = generators.find((item) => item.id === selected) ?? generators[0];
	const change = (edit: (items: Generator[]) => Generator[]) =>
		onEdit((current) => {
			const next = { ...current, generators: edit(projectGenerators(current)) };
			synchronizeGenerators(next);
			return next;
		});
	const update = (id: string, patch: Partial<Generator>) =>
		change((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	const add = () => {
		const id = createClientId();
		onEdit((current) => {
			const item: Generator = {
				id,
				name: `gen_${nextGeneratorIndex(current)}`,
				language: "cpp17",
				code: "",
				remark: "",
			};
			const next = { ...current, generators: [...projectGenerators(current), item] };
			synchronizeGenerators(next);
			return next;
		});
		setSelected(id);
		setError("");
	};
	const remove = () => {
		if (!active) return;
		// Match the safe command token, including a quoted alias; do not execute the script.
		const used = project.generatorScript.split(/\r?\n/u).some((line) => {
			const first = /^\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/u.exec(line);
			return (first?.[1] ?? first?.[2] ?? first?.[3]) === active.name;
		});
		if (used) {
			setError(t("{0} 仍被生成脚本引用，请先修改脚本。", active.name));
			return;
		}
		change((items) => items.filter((item) => item.id !== active.id));
		setError("");
	};
	return (
		<section className="generator-library manual-code-block" aria-label={t("数据生成器 Gen")}>
			<div className="manual-code-heading">
				<h3>{t("数据生成器 Gen")}</h3>
				<button
					type="button"
					className="button secondary"
					disabled={disabled || generators.length >= 32}
					onClick={add}
				>
					{t("添加 Gen")}
				</button>
			</div>
			<fieldset className="generator-list" aria-label={t("选择 Gen")}>
				{generators.map((item) => (
					<button
						key={item.id}
						type="button"
						className="button secondary"
						aria-pressed={active?.id === item.id}
						onClick={() => setSelected(item.id)}
						title={item.remark}
					>
						<strong>{item.name}</strong>
						<small>{item.remark || t("无备注")}</small>
					</button>
				))}
			</fieldset>
			{active ? (
				<fieldset className="source-fields" disabled={disabled}>
					<label className="field">
						<span>{t("{0} 备注", active.name)}</span>
						<input
							maxLength={2000}
							value={active.remark}
							onChange={(event) => update(active.id, { remark: event.target.value })}
						/>
					</label>
					<div className="manual-code-actions">
						<select
							aria-label={t("{0}语言", active.name)}
							value={active.language}
							onChange={(event) => update(active.id, { language: event.target.value as GeneratorLanguage })}
						>
							{cppLanguageOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{t(option.label)}
								</option>
							))}
							<option value="python3">Python 3</option>
						</select>
						<label className="button secondary manual-file-button">
							{t("上传源码")}
							<input
								type="file"
								accept=".cpp,.cc,.cxx,.py,.txt"
								onChange={(event) => {
									const file = event.currentTarget.files?.[0];
									event.currentTarget.value = "";
									if (file)
										void onImport(`generator:${active.id}`, file, (code) =>
											change((items) =>
												items.map((item) =>
													item.id === active.id
														? {
																...item,
																code,
																language: file.name.toLowerCase().endsWith(".py")
																	? "python3"
																	: item.language === "python3"
																		? "cpp17"
																		: item.language,
															}
														: item,
												),
											),
										).catch(() => {});
								}}
							/>
						</label>
						{active.language === "python3" && (
							<button
								className="button secondary"
								type="button"
								onClick={() => {
									if (!active.code.trim() || window.confirm(t("覆盖现有生成器代码？")))
										update(active.id, { code: pythonTemplate });
								}}
							>
								{t("导入 Python 模板")}
							</button>
						)}
						<button className="button secondary" type="button" onClick={remove}>
							{t("删除 Gen")}
						</button>
					</div>
					<CodeMirrorEditor
						key={active.id}
						readOnly={disabled}
						value={active.code}
						language={active.language}
						ariaLabel={t("{0}源码", active.name)}
						onChange={(code) => update(active.id, { code })}
					/>
					<p className="manual-muted">{t("参数通过命令行传入，输入写到 stdout；编号固定，删除后不重新编号。")}</p>
				</fieldset>
			) : (
				<p className="manual-muted">{t("暂无生成器，点击添加 Gen。")}</p>
			)}
			{error && (
				<p role="alert" className="manual-error">
					{error}
				</p>
			)}
		</section>
	);
}
