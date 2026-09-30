import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { compileContestPdfs } from "../src/contest-pdf.ts";
import { buildContestPdfSources } from "../src/contest-pdf-document.ts";
import { readContestPdfOptions } from "../src/contest-pdf-options.ts";
import { preparePdfMarkdown, typstString } from "../src/markdown-typst.ts";

import { pdfFixture } from "./fixtures/contest-pdf.ts";

it("validates all PDF settings and preserves the disabled legacy default", () => {
	expect(readContestPdfOptions(undefined).enabled).toBe(false);
	expect(readContestPdfOptions(pdfFixture.options)).toEqual(pdfFixture.options);
	expect(() => readContestPdfOptions({ ...pdfFixture.options, enabled: "true" })).toThrow();
	expect(() => readContestPdfOptions({ ...pdfFixture.options, language: "invalid" })).toThrow();
	expect(() => readContestPdfOptions({ ...pdfFixture.options, coverNotes: "x".repeat(20_001) })).toThrow();
});

it("renders active sections, escapes code and never fetches external or local images", () => {
	const sources = buildContestPdfSources(pdfFixture);
	expect(sources.booklet).toContain("交互器发送一个整数");
	expect(sources.booklet).not.toContain("隐藏");
	expect(sources.problems.get("A")).toContain("enable-titlepage: false");
	expect(sources.problems.get("A")).toContain("enable-header-footer: false");
	expect(preparePdfMarkdown('#read("/etc/passwd")')).toBe('#read("/etc/passwd")');
	expect(() => preparePdfMarkdown("![secret](/etc/passwd)")).toThrow("已上传");
	expect(() => preparePdfMarkdown("![remote](https://example.com/image.png)")).toThrow("已上传");
});

it("preserves upstream Markdown and safely rewrites attachment references", () => {
	const markdown = String.raw`![a\[b\]\\c](file://figure.svg)`;
	const images = new Map([["file://figure.svg", "/images/A-0.svg"]]);
	expect(preparePdfMarkdown(markdown, images)).toBe(String.raw`![a\[b\]\\c](/images/A-0.svg)`);
	expect(preparePdfMarkdown("![diagram][figure]\n\n[figure]: file://figure.svg", images)).toContain(
		"![diagram](/images/A-0.svg)",
	);
	expect(preparePdfMarkdown("**Bold**\n\n$x^2$\n\n> Quote")).toBe("**Bold**\n\n$x^2$\n\n> Quote");
});

it("escapes control characters without changing literal Unicode escape sequences", () => {
	expect(typstString("\b\f\n\r\t\0")).toBe('"\\u{8}\\u{c}\\u{a}\\u{d}\\u{9}\\u{0}"');
	expect(typstString(String.raw`\u0000 "#read"`)).toBe('"\\\\u0000 \\"#read\\""');
});

it("compiles a Chinese booklet, math and standalone ordinary/interactive PDFs", async () => {
	const directory = await mkdtemp(join(tmpdir(), "setdraft-pdf-test-"));
	try {
		const result = await compileContestPdfs(directory, pdfFixture);
		const originalFontNames = [
			"CMUSansSerif",
			"CMUSansSerif-Bold",
			"CMUTypewriter-Regular",
			"FZHTK--GBK1-0",
			"FZKTK--GBK1-0",
			"FZSSK--GBK1-0",
			"FZXBSK--GBK1-0",
			"NewCMMath-Book",
		];
		for (const path of [result.booklet, ...result.problems.values()]) {
			const bytes = await readFile(path);
			expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
			expect(bytes.length).toBeGreaterThan(5000);
			const fonts = new Set(
				Array.from(bytes.toString("latin1").matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/]+)/gu), (match) =>
					match[1].replace(/-Identity-H$/u, ""),
				),
			);
			expect(fonts.size).toBeGreaterThan(0);
			for (const font of fonts) expect(originalFontNames).toContain(font);
			if (path === result.booklet) expect([...fonts].sort()).toEqual(originalFontNames);
		}
		await result.cleanup();
		expect(await readdir(directory)).toEqual([]);
		const controller = new AbortController();
		controller.abort();
		await expect(compileContestPdfs(directory, pdfFixture, controller.signal)).rejects.toThrow();
		expect(await readdir(directory)).toEqual([]);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 90_000);
