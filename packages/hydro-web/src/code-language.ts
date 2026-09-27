import { completeFromList, ifNotIn, snippetCompletion } from "@codemirror/autocomplete";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { highlightTree, tags } from "@lezer/highlight";
import type { ProgramLanguage } from "./platform.ts";

export type EditorLanguage = ProgramLanguage | "gen-script";

const languages = { cpp: cpp(), java: java(), python3: python() };
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
	languageData: { commentTokens: { line: "#" }, closeBrackets: { brackets: ["(", "[", "{", "'", '"'] } },
});

// Static classes let the editor and Markdown use the same syntax palette.
export const codeHighlightStyle = HighlightStyle.define([
	{ tag: tags.keyword, class: "code-keyword" },
	{ tag: [tags.name, tags.variableName], class: "code-name" },
	{ tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], class: "code-function" },
	{ tag: [tags.typeName, tags.className, tags.namespace], class: "code-type" },
	{ tag: [tags.string, tags.character, tags.regexp], class: "code-string" },
	{ tag: [tags.number, tags.bool, tags.null, tags.atom], class: "code-literal" },
	{ tag: [tags.operator, tags.punctuation], class: "code-punctuation" },
	{ tag: [tags.meta, tags.processingInstruction], class: "code-meta" },
	{ tag: tags.comment, class: "code-comment" },
	{ tag: tags.invalid, class: "code-invalid" },
]);

function keywords(source: string) {
	return source.split(" ").map((label) => ({ label, type: "keyword" }));
}

const completions = {
	cpp: completeFromList([
		...keywords(
			"auto bool break case char class const constexpr continue default delete double else enum false float for if int long namespace new nullptr private protected public return short signed sizeof static std struct switch template this true typedef typename unsigned using vector void while",
		),
		snippetCompletion("for (int #{i} = 0; #{i} < #{n}; ++#{i}) {\n\t#{}\n}", {
			label: "for",
			detail: "for (…) { … }",
			type: "snippet",
			boost: 1,
		}),
		snippetCompletion("if (#{condition}) {\n\t#{}\n}", { label: "if", detail: "if (…) { … }", type: "snippet" }),
		snippetCompletion(
			"int main() {\n\tstd::ios::sync_with_stdio(false);\n\tstd::cin.tie(nullptr);\n\t#{}\n\treturn 0;\n}",
			{
				label: "main",
				detail: "int main()",
				type: "snippet",
			},
		),
	]),
	java: completeFromList([
		...keywords(
			"boolean break byte case catch char class continue default double else enum extends false final finally float for if implements import int interface long new null package private protected public return short static String super switch this throw throws true try void while",
		),
		snippetCompletion("for (int #{i} = 0; #{i} < #{n}; #{i}++) {\n\t#{}\n}", {
			label: "for",
			detail: "for (…) { … }",
			type: "snippet",
			boost: 1,
		}),
		snippetCompletion("public static void main(String[] args) {\n\t#{}\n}", {
			label: "main",
			detail: "public static void main(…)",
			type: "snippet",
		}),
		snippetCompletion("System.out.println(#{value});", {
			label: "sout",
			detail: "System.out.println(…)",
			type: "snippet",
		}),
	]),
	python3: completeFromList([
		snippetCompletion("for #{item} in #{items}:\n\t#{}", { label: "for", detail: "for … in …", type: "snippet" }),
		snippetCompletion("def #{solve}(#{args}):\n\t#{}", { label: "def", detail: "def …(…)", type: "snippet" }),
		snippetCompletion('if __name__ == "__main__":\n\t#{}', {
			label: "main",
			detail: 'if __name__ == "__main__"',
			type: "snippet",
		}),
	]),
};

export function codeLanguageSupport(language: EditorLanguage): Extension {
	if (language === "gen-script") return genScriptLanguage;
	const key = language === "python3" || language === "java" ? language : "cpp";
	const support = languages[key];
	return [
		support,
		support.language.data.of({
			autocomplete: ifNotIn(
				["Comment", "LineComment", "BlockComment", "String", "StringLiteral", "CharLiteral", "TextBlock"],
				completions[key],
			),
		}),
	];
}

export interface CodeToken {
	from: number;
	text: string;
	className?: string;
}

export function highlightCode(source: string, language: string): CodeToken[] {
	const parser = /^(?:c|cpp|c\+\+|cc|cxx)$/i.test(language)
		? languages.cpp.language.parser
		: /^(?:python|python3|py)$/i.test(language)
			? languages.python3.language.parser
			: /^java$/i.test(language)
				? languages.java.language.parser
				: language === "gen-script"
					? genScriptLanguage.parser
					: undefined;
	if (!parser) return [{ from: 0, text: source }];
	const tokens: CodeToken[] = [];
	let position = 0;
	highlightTree(parser.parse(source), codeHighlightStyle, (from, to, className) => {
		if (from > position) tokens.push({ from: position, text: source.slice(position, from) });
		tokens.push({ from, text: source.slice(from, to), className });
		position = to;
	});
	if (position < source.length) tokens.push({ from: position, text: source.slice(position) });
	return tokens;
}
