import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProblemPreview } from "../src/ProblemPreview.tsx";

describe("Hydro-style statement preview", () => {
	it("renders common Markdown, samples, formulas, footnotes and attachments without raw HTML", () => {
		const html = renderToStaticMarkup(
			<ProblemPreview
				project={{
					statement:
						'# 题目\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n$x+1$[^note]\n\n[^note]: 注释\n\n![图](file://plot.png)\n\n[附件](file://readme.txt)\n\n<script>alert("x")</script>',
					samples: [{ input: "1 2\n", output: "3\n" }],
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
		expect(html).toContain("language-input1");
		expect(html).toContain("language-output1");
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
});
