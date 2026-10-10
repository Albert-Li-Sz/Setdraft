import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	inspectMarkdown,
	markdownAttachmentName,
	markdownReferences,
	parseMarkdown,
	serializeMarkdown,
	splitMarkdownSections,
	walkMarkdown,
} from "../src/markdown.ts";
import { validateMarkdownAttachments } from "../src/validation.ts";

it("shares references and positioned diagnostics for the statement contract fixtures", () => {
	const source = readFileSync(new URL("../../../fixtures/markdown/statement.md", import.meta.url), "utf8");
	const references = markdownReferences(source);
	expect(references.map((reference) => markdownAttachmentName(reference.url))).toEqual([
		"first.svg",
		"readme.txt",
		"first.svg",
	]);
	expect(validateMarkdownAttachments(source, new Set(["first.svg", "readme.txt"]))).toEqual([]);
	const invalid = readFileSync(new URL("../../../fixtures/markdown/invalid.md", import.meta.url), "utf8");
	const issues = validateMarkdownAttachments(invalid, new Set());
	expect(issues.map((issue) => issue.code).sort()).toEqual([
		"INVALID_ATTACHMENT_REFERENCE",
		"MISSING_ATTACHMENT",
		"UNSAFE_MARKDOWN_URL",
	]);
	for (const issue of issues) expect(issue.position?.start.line).toBeGreaterThan(1);
	expect(inspectMarkdown(`${"- item\n".repeat(16_000)}<script>raw</script>`).diagnostics[0]).toMatchObject({
		code: "MARKDOWN_COMPLEXITY_LIMIT",
		position: { start: { line: expect.any(Number) } },
	});
});

it("locates flat attachments consistently despite protocol casing and URL suffixes", () => {
	expect(markdownAttachmentName("FILE://diagram.svg?v=2#figure")).toBe("diagram.svg");
	expect(markdownAttachmentName("file://../secret.svg")).toBeUndefined();
	expect(markdownAttachmentName("file:///etc/passwd")).toBeUndefined();
	expect(markdownAttachmentName("https://example.com/diagram.svg")).toBeUndefined();
});

it("keeps fenced headings out of the guide navigation and retains global references", () => {
	const source =
		"# Guide\n\nIntroduction\n\n## First\n\n```md\n## Not a chapter\n```\n\n[link][ref]\n\n## Second\n\n[ref]: https://example.com/docs\n";
	const sections = splitMarkdownSections(source);
	expect(sections.sections.map((section) => section.title)).toEqual(["First", "Second"]);
	expect(sections.sections[0].body).toContain("## Not a chapter");
	expect(sections.sections[0].body).toContain("[ref]: https://example.com/docs");
	expect(parseMarkdown("$x+1$", "statement").children[0]).toMatchObject({ children: [{ type: "inlineMath" }] });
	expect(parseMarkdown("$x+1$", "guide").children[0]).toMatchObject({ children: [{ type: "text", value: "$x+1$" }] });
});

it("uses AST text for Setext and formatted top-level guide headings", () => {
	const source = "# Guide\n\n**First** chapter\n---\n\n> ## Quoted\n\n## Second `code`\n\nBody";
	expect(splitMarkdownSections(source).sections.map((section) => section.title)).toEqual([
		"First chapter",
		"Second code",
	]);
});

it.each(["statement", "chat"] as const)("parses LaTeX delimiters with source positions in %s", (profile) => {
	const source = String.raw`行内 \(p\nmid a\)。

\[
\sum_{k=1}^{p-1} k
=
\frac{p(p-1)}{2}
\]

![图](file://figure.svg)`;
	const tree = parseMarkdown(source, profile);
	const formulas: Array<{ type: string; value: string; source: string }> = [];
	walkMarkdown(tree, (node) => {
		if (node.type === "inlineMath" || node.type === "math")
			formulas.push({
				type: node.type,
				value: node.value,
				source: source.slice(node.position?.start.offset, node.position?.end.offset),
			});
	});
	expect(formulas).toEqual([
		{ type: "inlineMath", value: String.raw`p\nmid a`, source: String.raw`\(p\nmid a\)` },
		{
			type: "math",
			value: "\\sum_{k=1}^{p-1} k\n=\n\\frac{p(p-1)}{2}",
			source: "\\[\n\\sum_{k=1}^{p-1} k\n=\n\\frac{p(p-1)}{2}\n\\]",
		},
	]);
	const reference = markdownReferences(source)[0];
	expect(source.slice(reference.node.position?.start.offset, reference.node.position?.end.offset)).toBe(
		"![图](file://figure.svg)",
	);
	expect(serializeMarkdown(tree)).toContain("$p\\nmid a$");
	expect(serializeMarkdown(tree)).toContain("$$\n\\sum_{k=1}^{p-1} k\n=\n\\frac{p(p-1)}{2}\n$$");
});

it("keeps escaped, code and guide delimiters literal and leaves dollar math intact", () => {
	const source = String.raw`\\(literal\\) \`\(code\)\` $x+1$

~~~tex
\[not math\]
~~~

$$
\frac{1}{2}
$$`.replaceAll("\\`", "`");
	const math: string[] = [];
	walkMarkdown(parseMarkdown(source), (node) => {
		if (node.type === "math" || node.type === "inlineMath") math.push(node.value);
	});
	expect(math).toEqual(["x+1", String.raw`\frac{1}{2}`]);
	expect(parseMarkdown(String.raw`\(x\)`, "guide").children[0]).toMatchObject({
		children: [{ type: "text", value: "(x)" }],
	});
});

it("retains ordinary Markdown escapes and entities in image alt text", () => {
	const source = String.raw`![a\[b\_c&copy;\]\\d](file://figure.svg) \(p\)`;
	const reference = markdownReferences(source)[0];
	expect(reference.node).toMatchObject({ type: "image", alt: "a[b_c©]\\d" });
	const tree = parseMarkdown(source);
	expect(tree.children[0]).toMatchObject({
		children: [
			{ type: "image", alt: "a[b_c©]\\d" },
			{ type: "text", value: " " },
			{ type: "inlineMath", value: "p" },
		],
	});
});
