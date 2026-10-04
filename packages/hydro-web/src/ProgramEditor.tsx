import { CodeMirrorEditor } from "./CodeMirrorEditor.tsx";
import { useLocale } from "./i18n.tsx";
import { cppLanguageOptions, type ProgramLanguage } from "./platform.ts";

export function ProgramEditor(props: {
	label: string;
	language: ProgramLanguage;
	code: string;
	optional?: boolean;
	readOnly?: boolean;
	cppOnly?: boolean;
	onChange(language: ProgramLanguage, code: string): void;
	onImport(file: File): Promise<void>;
}) {
	const { t } = useLocale();
	return (
		<section className="manual-code-block">
			<div className="manual-code-heading">
				<div>
					<h3>
						{props.label}
						{props.optional && <span className="manual-optional">{t("可选")}</span>}
					</h3>
				</div>
				<div className="manual-code-actions">
					<select
						aria-label={t("{0}语言", props.label)}
						value={props.language}
						onChange={(event) => props.onChange(event.target.value as ProgramLanguage, props.code)}
					>
						{cppLanguageOptions.map((option) => (
							<option value={option.value} key={option.value}>
								{t(option.label)}
							</option>
						))}
						{!props.cppOnly && (
							<>
								<option value="python3">Python 3</option>
								<option value="java">Java</option>
							</>
						)}
					</select>
					<label className="button secondary manual-file-button">
						{t("上传程序")}
						<input
							type="file"
							accept={props.cppOnly ? ".cpp,.cc,.cxx,.txt" : ".cpp,.cc,.cxx,.py,.java,.txt"}
							onChange={(event) => {
								const file = event.currentTarget.files?.[0];
								if (file) void props.onImport(file).catch(() => {});
								event.currentTarget.value = "";
							}}
						/>
					</label>
				</div>
			</div>
			<CodeMirrorEditor
				readOnly={props.readOnly}
				value={props.code}
				language={props.language}
				previewLines={20}
				onChange={(code) => props.onChange(props.language, code)}
				ariaLabel={t("{0}源码", props.label)}
			/>
		</section>
	);
}
