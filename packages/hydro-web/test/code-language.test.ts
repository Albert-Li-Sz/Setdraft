import { CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { Compartment, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { codeLanguageSupport, highlightCode } from "../src/code-language.ts";

async function complete(state: EditorState) {
	const context = new CompletionContext(state, state.selection.main.head, true);
	const sources = state.languageDataAt<CompletionSource>("autocomplete", context.pos);
	const results = await Promise.all(sources.map((source) => source(context)));
	return results.flatMap((result) => result?.options ?? []);
}

describe("code languages", () => {
	it.each([
		["cpp", '// note\nint main() { const char* s = "hello"; return 42; }'],
		["python", '# note\ndef solve():\n    s = "hello"\n    return 42'],
		["java", '// note\nclass Main { String s = "hello"; int solve() { return 42; } }'],
		["gen-script", '# note\ngen "hello" 42'],
	])("highlights %s without changing source text", (language, source) => {
		const tokens = highlightCode(source, language);
		expect(tokens.map((token) => token.text).join("")).toBe(source);
		for (const className of ["code-comment", "code-string", "code-literal"]) {
			expect(
				tokens.some((token) => token.className === className),
				className,
			).toBe(true);
		}
	});

	it("handles aliases, partial streamed code and unknown languages", () => {
		const partial = 'int main() {\n    cout << "<script>';
		expect(highlightCode(partial, "c++")).toEqual(highlightCode(partial, "cpp"));
		expect(
			highlightCode(partial, "cpp")
				.map((token) => token.text)
				.join(""),
		).toBe(partial);
		expect(highlightCode(partial, "unknown")).toEqual([{ from: 0, text: partial }]);
		expect(highlightCode("", "py")).toEqual([]);
	});

	it("reconfigures completion sources when switching languages", async () => {
		const language = new Compartment();
		let state = EditorState.create({ extensions: [language.of(codeLanguageSupport("cpp20"))] });
		const cpp = await complete(state);
		expect(cpp.some((item) => item.label === "constexpr")).toBe(true);
		expect(cpp.some((item) => item.label === "main" && item.type === "snippet")).toBe(true);
		state = state.update({ effects: language.reconfigure(codeLanguageSupport("java")) }).state;
		const java = await complete(state);
		expect(java.some((item) => item.label === "sout")).toBe(true);
		expect(java.some((item) => item.label === "constexpr")).toBe(false);
		state = state.update({ effects: language.reconfigure(codeLanguageSupport("python3")) }).state;
		const python = await complete(state);
		expect(python.some((item) => item.label === "def" && item.type === "snippet")).toBe(true);
		expect(python.some((item) => item.label === "sout")).toBe(false);
	});

	it.each(["// comment", 'const char* s = "value";'])("does not suggest code snippets inside %s", async (doc) => {
		const state = EditorState.create({
			doc,
			selection: { anchor: doc.startsWith("//") ? doc.length : doc.indexOf("value") + 2 },
			extensions: [codeLanguageSupport("cpp17")],
		});
		expect(await complete(state)).toEqual([]);
	});
});
