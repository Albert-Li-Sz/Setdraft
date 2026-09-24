import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import type { ProgramLanguage } from "./platform.ts";

type EditorLanguage = ProgramLanguage | "gen-script";

const genScriptLanguage = StreamLanguage.define<void>({
	token(stream) {
		if (stream.eatSpace()) return null;
		if (stream.peek() === "#") {
			stream.skipToEnd();
			return "comment";
		}
		if (stream.match(/^(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?)/)) return "string";
		if (stream.match(/^gen\b/)) return "keyword";
		if (stream.match(/^[+-]?\d+(?:\.\d+)?\b/)) return "number";
		stream.next();
		return null;
	},
});

function languageSupport(language: EditorLanguage): Extension {
	if (language === "gen-script") return genScriptLanguage;
	if (language === "python3") return python();
	if (language === "java") return java();
	return cpp();
}

interface Props {
	value: string;
	language: EditorLanguage;
	ariaLabel: string;
	previewLines?: number;
	onChange(value: string): void;
}

export function CodeMirrorEditor({ value, language, ariaLabel, previewLines = 16, onChange }: Props) {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	const languageRef = useRef(new Compartment());
	const onChangeRef = useRef(onChange);
	const applyingExternalRef = useRef(false);
	const initialPropsRef = useRef({ value, language, ariaLabel });
	onChangeRef.current = onChange;

	useEffect(() => {
		const parent = containerRef.current;
		if (!parent) return;
		const state = EditorState.create({
			doc: initialPropsRef.current.value,
			extensions: [
				basicSetup,
				EditorState.tabSize.of(4),
				EditorView.contentAttributes.of({ "aria-label": initialPropsRef.current.ariaLabel }),
				languageRef.current.of(languageSupport(initialPropsRef.current.language)),
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
	}, []);

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
		viewRef.current?.dispatch({ effects: languageRef.current.reconfigure(languageSupport(language)) });
	}, [language]);

	let lineCount = 1;
	for (let index = 0; index < value.length && lineCount < previewLines; index++) {
		if (value.charCodeAt(index) === 10) lineCount++;
	}
	const phantomLines = Array.from(
		{ length: Math.max(0, previewLines - lineCount) },
		(_, index) => lineCount + index + 1,
	);
	return (
		<div className="manual-code-editor">
			<div ref={containerRef} />
			{phantomLines.length > 0 && (
				<div className="manual-code-phantom-lines" aria-hidden="true" style={{ top: 13 + lineCount * 19.2 }}>
					{phantomLines.map((line) => (
						<span key={line}>{line}</span>
					))}
				</div>
			)}
		</div>
	);
}
