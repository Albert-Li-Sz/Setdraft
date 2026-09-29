import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthoringGuide } from "../src/AuthoringGuide.tsx";

describe("authoring guide", () => {
	it("renders the canonical guide with searchable chapter navigation", () => {
		const html = renderToStaticMarkup(<AuthoringGuide />);
		expect(html).toContain("搜索文档");
		expect(html).toContain("文档目录");
		expect(html).toContain('type="search"');
		expect(html).toContain('aria-controls="authoring-guide-section-15"');
		expect(html).toContain('id="authoring-guide-section-15"');
		expect(html).not.toContain('href="#authoring-guide-section-');
		expect(html).toContain("全交互");
		expect(html).toContain("半对拍");
		expect(html).toContain("booklet.pdf");
		expect(html).toContain("尚未完成");
		expect(html).toContain('href="#workspace"');
	});
});
