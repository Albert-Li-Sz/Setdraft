import { type ContestDraft, defaultContestPdfOptions } from "@setdraft/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContestPdfEditor } from "../src/ContestPdfEditor.tsx";

vi.mock("../src/PdfPreview.tsx", () => ({ PdfPreview: () => null }));

const contest: ContestDraft = {
	id: "contest",
	revision: 1,
	title: "春季赛",
	slug: "spring",
	releaseIds: [],
	colors: {},
	colorNames: {},
	createdAt: "",
	updatedAt: "",
};

function renderEditor(overrides: Partial<ContestDraft> = {}, ready = true) {
	return renderToStaticMarkup(
		<ContestPdfEditor
			contest={{ ...contest, ...overrides }}
			apiOrigin=""
			disabled={false}
			ready={ready}
			onSave={async () => {}}
			onDirty={() => {}}
		/>,
	);
}

describe("contest PDF settings", () => {
	it("keeps PDF generation opt-in for existing contests", () => {
		const html = renderEditor();
		expect(html).toContain("竞赛包附带 PDF");
		expect(html).not.toContain("封面副标题");
		expect(html).not.toContain('type="file"');
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>预览题册<\/button>/u);
	});

	it("includes cover editing, independent language controls, and layout settings", () => {
		const html = renderEditor({
			pdf: { ...defaultContestPdfOptions, enabled: true, coverNotes: "比赛时长：5 小时。" },
		});
		expect(html).toContain("封面副标题");
		expect(html).toContain("署名 / 主办方");
		expect(html).toContain("日期 / 地点");
		expect(html).toContain("默认语言");
		expect(html).toContain("封面语言");
		expect(html).toContain("题面栏目语言");
		expect(html).toContain("显示封面");
		expect(html).toContain("显示题目列表");
		expect(html).toContain("显示页眉页脚");
		expect(html).toContain("比赛时长：5 小时。");
		expect(html).toMatch(/<button[^>]*type="button">预览题册<\/button>/u);
		expect(html).not.toContain("上传 PDF");
		expect(html).toContain('href="/open-source/index.html"');
		expect(html).toContain("使用 XCPC 原模板与原字体。");
	});

	it("disables cover notes when the cover is hidden and preview until releases are ready", () => {
		const html = renderEditor({ pdf: { ...defaultContestPdfOptions, enabled: true, titlePage: false } }, false);
		expect(html).toMatch(/<textarea[^>]*disabled=""/u);
		expect(html).toMatch(/<input[^>]*disabled=""[^>]*\/>显示题目列表/u);
		expect(html).toMatch(/<button[^>]*disabled=""[^>]*>预览题册<\/button>/u);
	});
});
