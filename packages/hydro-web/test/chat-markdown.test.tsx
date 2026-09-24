import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "../src/ChatMarkdown.tsx";

describe("AI chat Markdown", () => {
	it("renders headings, GFM tables, fenced code and math", () => {
		const content = [
			"# 解题思路",
			"",
			"| 输入 | 输出 |",
			"| --- | --- |",
			"| 1 2 | 3 |",
			"",
			"```cpp",
			"std::cout << 3;",
			"```",
			"",
			"$a+b=3$",
		].join("\n");
		const html = renderToStaticMarkup(<ChatMarkdown content={content} />);
		expect(html).toContain("<h1>解题思路</h1>");
		expect(html).toContain("<table>");
		expect(html).toContain('class="language-cpp"');
		expect(html).toContain("katex");
	});
});
