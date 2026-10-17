import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdownReferences } from "@setdraft/authoring/markdown";
import type { Link } from "mdast";
import { describe, expect, it } from "vitest";
import { compileContestPdfs } from "../src/contest-pdf.ts";
import { buildContestPdfSources } from "../src/contest-pdf-document.ts";
import { preparePdfMarkdown } from "../src/markdown-typst.ts";
import { pdfFixture } from "./fixtures/contest-pdf.ts";

function textOf(node: Link): string {
	return node.children.map((child) => ("value" in child ? child.value : "")).join("");
}

// The contest PDF consumes Markdown, so a rewrite is only correct when the result parses back as
// exactly the reference the author wrote: one link, same label, same destination and title.
describe("PDF 链接改写在目标或标题含反斜杠时仍可解析", () => {
	it("控制组：不含反斜杠的定义链接改写后仍是同一个链接", () => {
		// [download][doc]
		//
		// [doc]: <https://example.com/download> "read me"
		const url = "https://example.com/download";
		const source = ["[download][doc]", "", "[doc]: <" + url + '> "read me"', ""].join("\n");
		expect(markdownReferences(source)).toHaveLength(1);

		const links = markdownReferences(preparePdfMarkdown(source));

		expect(links).toHaveLength(1);
		const [reference] = links;
		expect(reference.node.type).toBe("link");
		if (reference.node.type !== "link") return;
		expect(textOf(reference.node)).toBe("download");
		expect(reference.url).toBe(url);
		expect(reference.title).toBe("read me");
	});

	it("目标以反斜杠结尾的定义链接改写后仍是同一个链接", () => {
		// [download][doc]
		//
		// A backslash before the closing angle bracket must itself be escaped.
		const url = "https://example.com/a\\";
		const source = ["[download][doc]", "", "[doc]: <" + url.replaceAll("\\", "\\\\") + ">", ""].join("\n");
		expect(markdownReferences(source)).toHaveLength(1);

		const links = markdownReferences(preparePdfMarkdown(source));

		expect(links).toHaveLength(1);
		const [reference] = links;
		expect(reference.node.type).toBe("link");
		if (reference.node.type !== "link") return;
		expect(textOf(reference.node)).toBe("download");
		expect(reference.url).toBe(url);
	});

	it("标题以反斜杠结尾的定义链接改写后仍保留标题与标签", () => {
		// [download][doc]
		//
		// [doc]: <https://example.com/download> "read this\\"
		// CommonMark only lets a title end with a backslash when that backslash is written doubled,
		// so the decoded title is `read this\` and the rewrite must escape it again for the closing
		// quote of the rewritten title to survive.
		const url = "https://example.com/download";
		const title = ["read this", "\\"].join("");
		const source = ["[download][doc]", "", "[doc]: <" + url + '> "' + title.replaceAll("\\", "\\\\") + '"', ""].join(
			"\n",
		);
		expect(markdownReferences(source)).toHaveLength(1);

		const links = markdownReferences(preparePdfMarkdown(source));

		expect(links).toHaveLength(1);
		const [reference] = links;
		expect(reference.node.type).toBe("link");
		if (reference.node.type !== "link") return;
		expect(textOf(reference.node)).toBe("download");
		expect(reference.title).toBe(title);
	});
});

// Cover notes belong to the title page of the same booklet as the statements, so an image that
// resolves for a statement section must resolve there too instead of aborting the whole export.
describe("PDF 封面前言与题面使用同一套附件解析", () => {
	it("封面前言引用已上传附件中的图片时不应中止导出", () => {
		const attachment = { name: "cover.svg", contentBase64: Buffer.from("<svg/>").toString("base64") };
		const first = pdfFixture.problems[0];
		const mark = "COVERNOTES_SENTINEL_INSTRUCTIONS";
		const sources = buildContestPdfSources({
			...pdfFixture,
			options: { ...pdfFixture.options, coverNotes: mark + " ![封面图](file://cover.svg)" },
			problems: [{ ...first, attachments: [attachment] }],
		});

		// The cover notes must survive, and the image must become the mounted asset path rather than
		// staying a file:// URL that Typst cannot render.
		expect(sources.booklet).toContain(mark);
		expect(sources.booklet).not.toContain("file://cover.svg");
		expect(sources.booklet).toContain("/images/A-0.svg");
		expect(sources.assets.get("images/A-0.svg")).toEqual(Buffer.from(attachment.contentBase64, "base64"));
	});

	it("封面图片可来自任一题目，但拒绝跨题同名图片", () => {
		const attachment = { name: "cover.svg", contentBase64: Buffer.from("<svg/>").toString("base64") };
		const first = pdfFixture.problems[0];
		const document = {
			...pdfFixture,
			options: { ...pdfFixture.options, coverNotes: "![封面](file://cover.svg)" },
			problems: [
				{ ...first, attachments: [] },
				{ ...first, label: "B", attachments: [attachment] },
			],
		};
		expect(buildContestPdfSources(document).booklet).toContain("/images/B-0.svg");
		expect(() =>
			buildContestPdfSources({
				...document,
				problems: document.problems.map((problem) => ({ ...problem, attachments: [attachment] })),
			}),
		).toThrow("附件名称重复");
	});

	it("编译包含附件封面图片的 PDF 题册", async () => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-cover-image-"));
		try {
			const result = await compileContestPdfs(
				root,
				{
					...pdfFixture,
					options: { ...pdfFixture.options, coverNotes: "![封面](file://cover.svg)" },
					problems: [
						{
							...pdfFixture.problems[0],
							attachments: [
								{
									name: "cover.svg",
									contentBase64: Buffer.from(
										'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="blue"/></svg>',
									).toString("base64"),
								},
							],
						},
					],
				},
				undefined,
				true,
			);
			expect((await readFile(result.booklet)).subarray(0, 5).toString()).toBe("%PDF-");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 90_000);
});
