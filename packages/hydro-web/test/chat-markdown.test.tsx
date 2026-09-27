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
		expect(html).toContain('class="code-literal">3</span>');
		expect(html).toContain("katex");
		expect(html).toContain('aria-label="复制代码"');
	});

	it("escapes highlighted code and preserves inline code and unknown languages", () => {
		const content = [
			"Inline: `value`",
			"",
			"~~~cpp",
			'const char* s = "<script>alert(1)</script>";',
			"~~~",
			"",
			"~~~unknown",
			"<img src=x onerror=alert(1)>",
			"~~~",
		].join("\n");
		const html = renderToStaticMarkup(<ChatMarkdown content={content} />);
		expect(html).toContain("<code>value</code>");
		expect(html).toContain('class="code-string"');
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain('<code class="language-unknown">&lt;img');
		expect(html).not.toContain("<img");
		expect(html.match(/aria-label="复制代码"/gu)).toHaveLength(2);
	});

	it("offers copying for plain, indented and still-streaming code blocks without changing their whitespace", () => {
		const html = renderToStaticMarkup(
			<ChatMarkdown
				content={'    indented code\n\n```\n  plain <text>\n\tline two\n```\n\n```python\nprint("未完成")'}
			/>,
		);
		expect(html.match(/aria-label="复制代码"/gu)).toHaveLength(3);
		expect(html).toContain("<pre><code>indented code\n</code></pre>");
		expect(html).toContain("<pre><code>  plain &lt;text&gt;\n\tline two\n</code></pre>");
		expect(html).toContain('class="language-python"');
	});
});
