import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProblemPreview } from "../src/ProblemPreview.tsx";

describe("Hydro-style statement preview", () => {
	it("renders the shared statement fixture without changing its source or definition precedence", () => {
		const source = readFileSync(new URL("../../../fixtures/markdown/statement.md", import.meta.url), "utf8");
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement: source,
					samples: [],
					attachments: [
						{ name: "first.svg", contentBase64: "c3Zn" },
						{ name: "readme.txt", contentBase64: "dGV4dA==" },
					],
				}}
			/>,
		);
		expect(html.match(/src="data:image\/svg\+xml;base64,c3Zn"/gu)).toHaveLength(2);
		expect(html).toContain('href="data:text/plain;base64,dGV4dA=="');
		expect(html).toContain("<table>");
		expect(html).toContain("katex");
		expect(html).toContain("data-footnotes");
		expect(html).toContain("file://missing.png");
		expect(source).toBe(readFileSync(new URL("../../../fixtures/markdown/statement.md", import.meta.url), "utf8"));
	});
	it("shows escaped original text and a brief alert when parsing exceeds the shared limit", () => {
		const source = `${"- item\n".repeat(16_000)}<script>alert(1)</script>`;
		const html = renderToStaticMarkup(
			<ProblemPreview project={{ statement: source, samples: [], attachments: [] }} />,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
	});
	it("uses the same attachment destination for encoded, mixed-case and suffixed links", () => {
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement: "![图](FILE&#58;//plot.png?v=2#figure)",
					samples: [],
					attachments: [{ name: "plot.png", contentBase64: "aW1hZ2U=" }],
				}}
			/>,
		);
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
	});
	it("renders only authored Markdown, formulas, footnotes and attachments without raw HTML", () => {
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement:
						'# 题目\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x+1$[^note]\n\n[^note]: 注释\n\n![图](file://plot.png)\n\n[附件](file://readme.txt)\n\n<script>alert("x")</script>',
					samples: [{ input: "PUBLIC_SAMPLE_INPUT\n", output: "PUBLIC_SAMPLE_OUTPUT\n" }],
					attachments: [
						{ name: "plot.png", contentBase64: "aW1hZ2U=" },
						{ name: "readme.txt", contentBase64: "dGV4dA==" },
					],
				}}
			/>,
		);
		expect(html).toContain("<table>");
		expect(html).toContain('class="katex"');
		expect(html).toContain("data-footnotes");
		expect(html).toContain('src="data:image/png;base64,aW1hZ2U="');
		expect(html).toContain('href="data:text/plain;base64,dGV4dA=="');
		expect(html).not.toContain("language-input1");
		expect(html).not.toContain("language-output1");
		expect(html).not.toContain("PUBLIC_SAMPLE");
		expect(html).not.toContain("<script>");
	});

	it("rejects missing file links and unsafe Markdown URLs", () => {
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement: "[missing](file://none.txt) [unsafe](javascript:alert%281%29)",
					samples: [],
					attachments: [],
				}}
			/>,
		);
		expect(html).not.toContain("file://");
		expect(html).not.toContain("javascript:");
	});

	it.each(["default", "interactive"] as const)(
		"renders %s sections and samples using the export format",
		(judgingMode) => {
			const html = renderToStaticMarkup(
				<ProblemPreview
					project={{
						judgingMode,
						statement: "OLD_RENDERED_MARKDOWN",
						statementSections: {
							description: "结构化题面。",
							input: "BATCH_INPUT_ONLY",
							output: "BATCH_OUTPUT_ONLY",
							interaction: "INTERACTION_ONLY",
							notes: "注意边界。",
						},
						samples: [{ input: "1 2\n", output: "3\n" }],
						attachments: [],
					}}
				/>,
			);
			expect(html).toContain("<h2>描述</h2>");
			expect(html).toContain("<h2>提示</h2>");
			expect(html).toContain("<h2>样例</h2>");
			expect(html).toContain('class="language-input1"');
			expect(html).toContain('class="language-output1"');
			expect(html).not.toContain("OLD_RENDERED_MARKDOWN");
			if (judgingMode === "interactive") {
				expect(html).toContain("<h2>交互描述</h2>");
				expect(html).not.toContain("BATCH_INPUT_ONLY");
				expect(html).not.toContain("BATCH_OUTPUT_ONLY");
			} else {
				expect(html).toContain("<h2>输入</h2>");
				expect(html).toContain("<h2>输出</h2>");
				expect(html).not.toContain("INTERACTION_ONLY");
			}
		},
	);

	it("keeps sample Markdown and HTML inside code blocks", () => {
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement: "",
					statementSections: { description: "示例。", input: "", output: "", interaction: "", notes: "" },
					samples: [{ input: "```\n# NOT_A_HEADING\n<script>alert(1)</script>", output: "ok" }],
					attachments: [],
				}}
			/>,
		);
		expect(html).toContain("NOT_A_HEADING");
		expect(html).not.toContain("<h1>");
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

import { readFileSync } from "node:fs";
