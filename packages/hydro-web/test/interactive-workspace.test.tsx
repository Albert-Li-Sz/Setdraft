import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ManualWorkspace } from "../src/ManualWorkspace.tsx";
import { projectFixture } from "./project-fixture.ts";

it.each(["provided", "empty"] as const)(
	"shows interactive configuration and the correct generation entry for %s input",
	(interactionInputMode) => {
		const html = renderToStaticMarkup(
			<ManualWorkspace
				apiOrigin=""
				signal={new AbortController().signal}
				project={projectFixture({ judgingMode: "interactive", interactionInputMode })}
				busy={undefined}
				deleting={false}
				saveStatus="已保存"
				notice=""
				noticeTone="pending"
				onEdit={() => {}}
				onUpload={async () => {}}
				onAddCase={async () => {}}
				onManageCases={async () => {}}
				onUploadAttachments={async () => {}}
				onDeleteFile={async () => {}}
				onGenerate={async () => {}}
				onFinalize={async () => {}}
				onRestore={async () => {}}
				onReleasesChanged={() => {}}
				onCopy={() => {}}
				onDelete={async () => {}}
			/>,
		);
		expect(html).toContain('value="interactive" selected=""');
		expect(html).toContain("交互协议");
		expect(html).toContain("程序与判题");
		expect(html).toContain(interactionInputMode === "empty" ? "无测试输入" : "使用私有测试数据");
		expect(html).not.toContain("启用交互题");
		expect(html).not.toContain("全交互");
		expect(html).not.toContain("半对拍");
		expect(html).not.toContain("上传 PDF");
		expect(html).toContain('href="#contests">配置竞赛 PDF</a>');
		expect(html).toMatch(/href="#authoring-guide"[^>]*target="_blank"[^>]*>出题文档<\/a>/u);
		expect(html).not.toContain("公开样例在“测试数据”中配置");
		if (interactionInputMode === "empty") expect(html).not.toContain('id="authoring-tab-generator"');
		else expect(html).toContain('id="authoring-tab-generator"');
	},
);
