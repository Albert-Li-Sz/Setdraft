import { acceptCompletion } from "@codemirror/autocomplete";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useId, useRef } from "react";
import { codeHighlightStyle, codeLanguageSupport, type EditorLanguage } from "./code-language.ts";
import { useLocale } from "./i18n.tsx";

interface Props {
	value: string;
	language: EditorLanguage;
	ariaLabel: string;
	previewLines?: number;
	onChange(value: string): void;
}

export function CodeMirrorEditor({ value, language, ariaLabel, onChange }: Props) {
	const { t } = useLocale();
	const hintId = useId();
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const languageRef = useRef(new Compartment());
	const labelRef = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	const applyingExternalRef = useRef(false);
	const initialPropsRef = useRef({ value, language, ariaLabel });
	onChangeRef.current = onChange;

	useEffect(() => {
		const parent = containerRef.current;
		if (!parent) return;
		const sizeToViewport = () => {
			const top = Math.max(96, parent.getBoundingClientRect().top);
			parent.style.setProperty("--editor-height", `${Math.max(200, window.innerHeight - top - 64)}px`);
		};
		sizeToViewport();
		window.addEventListener("resize", sizeToViewport);
		const state = EditorState.create({
			doc: initialPropsRef.current.value,
			extensions: [
				basicSetup,
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
			window.removeEventListener("resize", sizeToViewport);
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

	return (
		<div className="manual-code-editor">
			<div ref={containerRef} />
			<p className="code-editor-help" id={hintId}>
				{t("Tab 缩进 · Ctrl+Space 补全 · Esc 后按 Tab 离开编辑器")}
			</p>
		</div>
	);
}
