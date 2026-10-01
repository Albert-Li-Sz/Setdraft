import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
	inspectMarkdown,
	markdownAttachmentName,
	markdownReferences,
	parseMarkdown,
	splitMarkdownSections,
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
