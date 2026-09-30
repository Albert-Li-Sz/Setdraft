import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileContestPdfs } from "../src/contest-pdf.ts";
import { buildContestPdfSources } from "../src/contest-pdf-document.ts";
import { preparePdfMarkdown } from "../src/markdown-typst.ts";
import { pdfFixture } from "./fixtures/contest-pdf.ts";

describe("PDF reference definitions", () => {
	it("resolves references across statement sections in both single PDFs and booklets", () => {
		const first = pdfFixture.problems[0];
		const sources = buildContestPdfSources({
			...pdfFixture,
			problems: [
				{
					...first,
					attachments: [
						{
							name: "diagram.svg",
							contentBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
						},
					],
					statementSections: {
						...first.statementSections!,
						description: "![figure][fig]",
						input: "![input][fig]",
						notes: "> [fig]: file://diagram.svg\n\n[fig]: file://missing.svg",
					},
				},
			],
		});
		for (const source of [sources.booklet, sources.problems.get("A")!]) {
			expect(source).toContain("![figure](/images/A-0.svg)");
			expect(source).toContain("![input](/images/A-0.svg)");
		}
	});
	it("finds document definitions nested in quotes and lists", () => {
		const images = new Map([["file://figure.svg", "images/figure.svg"]]);
		for (const definition of ["> [figure]: file://figure.svg", "- [figure]: file://figure.svg"])
			expect(preparePdfMarkdown(`![示意图][figure]\n\n${definition}`, images)).toContain(
				"![示意图](images/figure.svg)",
			);
	});
	it("uses the first definition in document order", () => {
		expect(
			preparePdfMarkdown(
				"![图][figure]\n\n> [figure]: file://first.svg\n\n[figure]: file://second.svg",
				new Map([["file://first.svg", "images/first.svg"]]),
			),
		).toContain("![图](images/first.svg)");
	});
});

it("compiles both PDF outputs with globally defined images and links", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-global-pdf-"));
	const first = pdfFixture.problems[0];
	const document = {
		...pdfFixture,
		problems: [
			{
				...first,
				attachments: [
					{
						name: "diagram.svg",
						contentBase64: Buffer.from(
							'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#2563eb"/></svg>',
						).toString("base64"),
					},
				],
				statementSections: {
					...first.statementSections!,
					description: "![figure][fig]\n\n[documentation][docs]",
					input: "![input][fig]",
					notes: "> [fig]: file://diagram.svg\n> [docs]: https://example.com/docs\n\n[fig]: file://missing.svg",
				},
			},
		],
	};
	try {
		const result = await compileContestPdfs(root, document);
		try {
			for (const path of [result.booklet, ...result.problems.values()])
				expect((await readFile(path)).subarray(0, 5).toString()).toBe("%PDF-");
		} finally {
			await result.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
