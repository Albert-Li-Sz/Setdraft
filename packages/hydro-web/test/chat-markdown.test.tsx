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

	it("renders AI response formulas delimited with LaTeX parentheses and brackets", () => {
		const content = String.raw`## 一个可直接使用的命题

设 \(p\) 为奇素数，\(a\) 为整数且 \(p\nmid a\)。证明：

\[
\sum_{k=1}^{p-1}\left\lfloor \frac{ak}{p}\right\rfloor
=
\frac{(a-1)(p-1)}{2}.
\]

- **沃尔斯坦霍姆定理**：对素数 \(p\ge 5\)，
  \[
  \sum_{k=1}^{p-1}\frac{1}{k}\equiv 0 \pmod{p^2}.
  \]

> 若 \(\varphi(n)=n-k\)，能否刻画 \(n\) 的结构？`;
		const html = renderToStaticMarkup(<ChatMarkdown content={content} />);
		expect(html).toContain("<h2>一个可直接使用的命题</h2>");
		expect(html.match(/class="katex"/gu)).toHaveLength(8);
		expect(html.match(/class="katex-display"/gu)).toHaveLength(2);
		expect(html).toContain("\\sum_{k=1}^{p-1}\\left\\lfloor ");
		expect(html).not.toContain("katex-error");
	});

	it("preserves dollar math, LaTeX commands and literal delimiters inside code", () => {
		const content = String.raw`Inline $a+b$ and \(E/\mathbb{Q}\).

$$
\frac{1}{2}+\sqrt{x^2+y^2}
$$

\[
\begin{aligned}
a&=b\\
c&=d
\end{aligned}
\]

Literal: \`\(x\)\` and \`\[y\]\`.

~~~tex
\(not math\)
\[
not math
\]
~~~`.replaceAll("\\`", "`");
		const html = renderToStaticMarkup(<ChatMarkdown content={content} />);
		expect(html.match(/class="katex"/gu)).toHaveLength(4);
		expect(html.match(/class="katex-display"/gu)).toHaveLength(2);
		expect(html).toContain("<code>\\(x\\)</code>");
		expect(html).toContain("<code>\\[y\\]</code>");
		expect(html).toContain("\\(not math\\)\n\\[\nnot math\n\\]");
		expect(html.match(/aria-label="复制代码"/gu)).toHaveLength(1);
		expect(html).not.toContain("katex-error");
	});

	it.each([String.raw`\(p`, String.raw`\[\frac{1}{2}`])(
		"keeps unfinished streaming formulas visible until their closing delimiter arrives: %s",
		(content) => {
			const pending = renderToStaticMarkup(<ChatMarkdown content={content} />);
			expect(pending).not.toContain('class="katex"');
			expect(pending).not.toContain('role="alert"');
			expect(pending).toContain(content.slice(2));
			const complete = renderToStaticMarkup(
				<ChatMarkdown content={`${content}${content.startsWith("\\(") ? "\\)" : "\\]"}`} />,
			);
			expect(complete).toContain('class="katex"');
			expect(complete).not.toContain("katex-error");
		},
	);

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
