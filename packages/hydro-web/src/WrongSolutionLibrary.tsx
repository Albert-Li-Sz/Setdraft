import { type ProjectSnapshot, projectSolutions, type Solution, synchronizeSolutions } from "@setdraft/contracts";
import { useEffect, useRef, useState } from "react";
import { createClientId } from "./browser-capabilities.ts";
import { readSourceFile } from "./file-transfer.ts";
import { useLocale } from "./i18n.tsx";
import { ProgramEditor } from "./ProgramEditor.tsx";
import type { ProjectSession } from "./project-session.ts";
import { SolutionSettings } from "./SolutionSettings.tsx";
import { SourceImports } from "./source-import.ts";

export function WrongSolutionLibrary({
	project,
	session,
	disabled,
}: {
	project: ProjectSnapshot;
	session: ProjectSession;
	disabled: boolean;
}) {
	const { t } = useLocale();
	const all = projectSolutions(project);
	const items = all.filter((item) => item.expectation.kind !== "AC");
	const [selected, setSelected] = useState(items[0]?.id ?? "");
	const active = items.find((item) => item.id === selected) ?? items[0];
	const scope = useRef({ projectId: project.id, signal: session.signal });
	scope.current = { projectId: project.id, signal: session.signal };
	const [imports] = useState(() => new SourceImports(readSourceFile, () => scope.current));
	useEffect(() => () => imports.cancel(), [imports]);
	const change = (edit: (items: Solution[]) => Solution[]) =>
		session.edit((current) => {
			const next = { ...current, solutions: edit(projectSolutions(current)) };
			synchronizeSolutions(next);
			return next;
		});
	const update = (id: string, patch: Partial<Solution>) =>
		change((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
	const add = (copy?: Solution) => {
		const id = createClientId();
		change((items) => [
			...items,
			{
				id,
				name: t("新错误解"),
				language: "cpp17",
				code: "",
				purpose: "wrong",
				expectation: { kind: "WA" },
				...copy,
				required: false,
				...(copy ? { id, name: `${copy.name.slice(0, 90)} (${t("副本")})` } : {}),
			},
		]);
		setSelected(id);
	};
	return (
		<section className="wrong-solution-library" aria-label={t("压力测试错误解")}>
			<div className="verification-heading">
				<h3>{t("错误解")}</h3>
				<button
					type="button"
					className="button secondary"
					disabled={disabled || all.length >= 32}
					onClick={() => add()}
				>
					{t("添加错误解")}
				</button>
			</div>
			<p className="manual-muted">
				{t("在完整测试数据上评测错误解，核对预设错误；全部 AC 或出现其他错误时提醒出题人。")}
			</p>
			{items.length ? (
				<>
					<label className="field">
						<span>{t("编辑错误解")}</span>
						<select
							aria-label={t("编辑错误解")}
							value={active?.id ?? ""}
							onChange={(event) => setSelected(event.target.value)}
						>
							{items.map((item) => (
								<option key={item.id} value={item.id}>
									{item.name} · {item.expectation.kind}
								</option>
							))}
						</select>
					</label>
					{active && (
						<fieldset className="source-fields" disabled={disabled}>
							<SolutionSettings
								solution={active}
								primary={false}
								wrongOnly
								canCopy={all.length < 32}
								onChange={(patch) => update(active.id, patch)}
								onPrimary={() => {}}
								onCopy={() => add(active)}
								onRemove={() => change((items) => items.filter((item) => item.id !== active.id))}
							/>
							<ProgramEditor
								readOnly={disabled}
								label={active.name}
								language={active.language}
								code={active.code}
								onChange={(language, code) => update(active.id, { language, code })}
								onImport={(file) =>
									imports.import(`solution:${active.id}`, file, (code) =>
										change((items) =>
											items.map((item) =>
												item.id === active.id
													? {
															...item,
															code,
															language: file.name.endsWith(".py")
																? "python3"
																: file.name.endsWith(".java")
																	? "java"
																	: item.language.startsWith("cpp")
																		? item.language
																		: "cpp17",
														}
													: item,
											),
										),
									)
								}
							/>
						</fieldset>
					)}
				</>
			) : (
				<p className="manual-muted">{t("尚无错误解，添加后设置 WA、TLE、MLE、RE 或总分区间。")}</p>
			)}
		</section>
	);
}
