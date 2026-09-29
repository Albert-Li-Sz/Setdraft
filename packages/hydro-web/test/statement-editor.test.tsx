import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatementEditor } from "../src/StatementEditor.tsx";
import { projectFixture } from "./project-fixture.ts";

describe("sectioned statement editor", () => {
	it.each(["default", "interactive"] as const)(
		"provides the correct accessible tabs for %s problems",
		(judgingMode) => {
			const html = renderToStaticMarkup(
				<StatementEditor
					project={projectFixture({
						judgingMode,
						statementSections: {
							description: "题目内容",
							input: "输入内容",
							output: "输出内容",
							interaction: "通信过程",
							notes: "提示内容",
						},
						samples: [{ input: "1", output: "2" }],
					})}
					disabled={false}
					onEdit={() => {}}
				/>,
			);
			const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>(.*?)<\/button>/gu)].map((match) => match[1]);
			expect(tabs).toEqual([
				"描述",
				...(judgingMode === "interactive" ? ["交互描述"] : ["输入", "输出"]),
				"提示",
				'样例<span class="tab-count">1</span>',
			]);
			expect(html).toContain('role="tablist" aria-label="题面分栏"');
			expect(html).toContain('aria-selected="true" tabindex="0">描述');
			expect(html).toContain('role="tabpanel"');
			expect(html).toContain('aria-label="描述 · Markdown"');
			expect(html).toContain("完整题面预览");
			expect(html).not.toContain("旧版完整题面");
		},
	);

	it("keeps the entire legacy statement editable and explains migration", () => {
		const html = renderToStaticMarkup(
			<StatementEditor
				project={projectFixture({ statement: "# 旧题面\n\n## 输入\n保留这段文本。" })}
				disabled={true}
				onEdit={() => {}}
			/>,
		);
		expect(html).toContain("旧版完整题面保留在“描述”中");
		expect(html).toMatch(/<textarea[^>]*disabled=""[^>]*># 旧题面\n\n## 输入\n保留这段文本。<\/textarea>/u);
	});
});
