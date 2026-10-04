import { acceptCompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useId, useRef } from "react";
import { codeHighlightStyle, codeLanguageSupport, type EditorLanguage } from "./code-language.ts";
import { useLocale } from "./i18n.tsx";
import { useTheme } from "./theme.tsx";

interface Props {
	value: string;
	language: EditorLanguage;
	ariaLabel: string;
	previewLines?: number;
	readOnly?: boolean;
	onChange(value: string): void;
}

export function CodeMirrorEditor({ value, language, ariaLabel, onChange, readOnly = false }: Props) {
	const { t } = useLocale();
	const { dark } = useTheme();
	const hintId = useId();
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const languageRef = useRef(new Compartment());
	const labelRef = useRef(new Compartment());
	const themeRef = useRef(new Compartment());
	const writableRef = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	const applyingExternalRef = useRef(false);
	const initialPropsRef = useRef({ value, language, ariaLabel, dark, readOnly });
	onChangeRef.current = onChange;

	useEffect(() => {
		const parent = containerRef.current;
		if (!parent) return;
		const state = EditorState.create({
			doc: initialPropsRef.current.value,
			extensions: [
				basicSetup,
				themeRef.current.of(EditorView.theme({}, { dark: initialPropsRef.current.dark })),
				writableRef.current.of(EditorState.readOnly.of(initialPropsRef.current.readOnly)),
				syntaxHighlighting(codeHighlightStyle),
				EditorState.tabSize.of(4),
				indentUnit.of("    "),
				keymap.of([{ key: "Tab", run: acceptCompletion }, indentWithTab]),
				EditorView.contentAttributes.of({ "aria-describedby": hintId }),
				labelRef.current.of(EditorView.contentAttributes.of({ "aria-label": initialPropsRef.current.ariaLabel })),
				languageRef.current.of(codeLanguageSupport(initialPropsRef.current.language)),
				EditorView.updateListener.of((update) => {
					if (update.docChanged && !applyingExternalRef.current) {
						onChangeRef.current(update.state.doc.toString());
					}
				}),
			],
		});
		const view = new EditorView({ state, parent });
		viewRef.current = view;
		return () => {
			viewRef.current = null;
			view.destroy();
		};
	}, [hintId]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.state.doc.toString() === value) return;
		applyingExternalRef.current = true;
		try {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		} finally {
			applyingExternalRef.current = false;
		}
	}, [value]);

	useEffect(() => {
		viewRef.current?.dispatch({ effects: languageRef.current.reconfigure(codeLanguageSupport(language)) });
	}, [language]);

	useEffect(() => {
		viewRef.current?.dispatch({
			effects: labelRef.current.reconfigure(EditorView.contentAttributes.of({ "aria-label": ariaLabel })),
		});
	}, [ariaLabel]);
	useEffect(() => {
		viewRef.current?.dispatch({ effects: themeRef.current.reconfigure(EditorView.theme({}, { dark })) });
	}, [dark]);
	useEffect(() => {
		viewRef.current?.dispatch({ effects: writableRef.current.reconfigure(EditorState.readOnly.of(readOnly)) });
	}, [readOnly]);

	return (
		<div className="manual-code-editor">
			<div className="code-editor-surface" ref={containerRef} />
			<p className="code-editor-help" id={hintId}>
				{t("Tab 缩进 · Ctrl+Space 补全 · Esc 后按 Tab 离开编辑器")}
			</p>
		</div>
	);
}
