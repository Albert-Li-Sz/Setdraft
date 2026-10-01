import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileContestPdfs } from "../src/contest-pdf.ts";
import { createContestPdfCompiler } from "../src/contest-pdf-compiler.ts";
import { buildContestPdfSources } from "../src/contest-pdf-document.ts";
import { preparePdfFootnotes, preparePdfMarkdown } from "../src/markdown-typst.ts";
import { pdfFixture } from "./fixtures/contest-pdf.ts";

it("renders nested, repeated and cross-section notes completely in real PDFs", async () => {
	const sources = buildContestPdfSources({
		...pdfFixture,
		problems: [
			{
				...pdfFixture.problems[0],
				samples: [],
				statementSections: {
					description: "Text[^a]. Again[^a].",
					input: "Also[^b].",
					output: "",
					interaction: "",
					notes: "[^a]: OUTER_NOTE[^b].\n\n[^b]: INNER_NOTE_REQUIRED[^c].\n\n[^c]: DEEPEST_NOTE_REQUIRED\n\n[^b]: DUPLICATE_IGNORED",
				},
			},
		],
	});
	const compiler = await createContestPdfCompiler();
	try {
		for (const source of [sources.booklet, sources.problems.get("A")!]) {
			compiler.addSource("/nested.typ", `#show text: it => [#metadata(it.text) <pdf-text>#it]\n${source}`);
			await compiler.runWithWorld({ mainFilePath: "/nested.typ" }, async (world) => {
				const result = await world.compile({ diagnostics: "full" });
				expect(result.hasError, JSON.stringify(result.diagnostics)).toBe(false);
				const text = (await world.query<string[]>({ selector: "<pdf-text>", field: "value" })).join("");
				for (const content of ["OUTER_NOTE", "INNER_NOTE_REQUIRED", "DEEPEST_NOTE_REQUIRED"])
					expect(text.match(new RegExp(content, "gu"))).toHaveLength(1);
				expect(text).not.toContain("[^b]");
				expect(text).not.toContain("DUPLICATE_IGNORED");
				expect((await world.pdf({ diagnostics: "full" })).result).toBeTruthy();
			});
		}
	} finally {
		await compiler.reset();
	}
});

it.each(["[^a]: A[^a]", "[^a]: A[^b]\n\n[^b]: B[^a]"])("diagnoses a reachable footnote cycle: %s", (definition) => {
	expect(() => preparePdfFootnotes([`Text[^a].\n\n${definition}`])).toThrow(/脚注.*循环/u);
});

it("treats user HTML with the internal footnote name as literal text in a real PDF", async () => {
	const marker = '<setdraft-footnote data-note="0" data-first="1"></setdraft-footnote>';
	const sources = buildContestPdfSources({
		...pdfFixture,
		problems: [
			{
				...pdfFixture.problems[0],
				samples: [],
				statementSections: {
					description: `${marker}\n\nReal[^a].`,
					input: "",
					output: "",
					interaction: "",
					notes: `[^a]: NOTE_CONTENT ${marker}`,
				},
			},
		],
	});
	const compiler = await createContestPdfCompiler();
	try {
		compiler.addSource(
			"/literal.typ",
			`#show text: it => [#metadata(it.text) <pdf-text>#it]\n${sources.problems.get("A")!}`,
		);
		await compiler.runWithWorld({ mainFilePath: "/literal.typ" }, async (world) => {
			const result = await world.compile({ diagnostics: "full" });
			expect(result.hasError, JSON.stringify(result.diagnostics)).toBe(false);
			const text = (await world.query<string[]>({ selector: "<pdf-text>", field: "value" })).join("");
			expect(text.replace(/[“”]/gu, '"')).toContain(marker);
			expect(text).toContain("NOTE_CONTENT");
			expect(text.match(/NOTE_CONTENT/gu)).toHaveLength(1);
		});
	} finally {
		await compiler.reset();
	}
});

it.each(["n", "中文脚注"])(
	"keeps cross-section footnote %s connected in real single PDFs and booklets",
	async (identifier) => {
		const first = pdfFixture.problems[0];
		const sources = buildContestPdfSources({
			...pdfFixture,
			problems: [
				{
					...first,
					samples: [],
					statementSections: {
						description: `Cross section footnote here[^${identifier}]. Again[^${identifier}].`,
						input: `Another section[^${identifier}].`,
						output: "",
						interaction: "",
						notes: `[^${identifier}]: CRITICAL_FOOTNOTE_CONTENT\n\n[^${identifier}]: DUPLICATE_IGNORED`,
					},
				},
			],
		});
		const compiler = await createContestPdfCompiler();
		try {
			for (const source of [sources.booklet, sources.problems.get("A")!]) {
				compiler.addSource("/footnotes.typ", `#show text: it => [#metadata(it.text) <pdf-text>#it]\n${source}`);
				await compiler.runWithWorld({ mainFilePath: "/footnotes.typ" }, async (world) => {
					const compilation = await world.compile({ diagnostics: "full" });
					expect(compilation.hasError, JSON.stringify(compilation.diagnostics)).toBe(false);
					const text = (await world.query<string[]>({ selector: "<pdf-text>", field: "value" })).join("");
					expect(text).not.toContain(`[^${identifier}]`);
					expect(text.match(/CRITICAL_FOOTNOTE_CONTENT/gu)).toHaveLength(1);
					expect(text).not.toContain("DUPLICATE_IGNORED");
					const pdf = await world.pdf({ diagnostics: "full" });
					expect(Buffer.from(pdf.result!).subarray(0, 5).toString()).toBe("%PDF-");
				});
			}
		} finally {
			await compiler.reset();
		}
	},
);

describe("PDF reference definitions", () => {
	it("normalizes inline attachment link destinations without changing ordinary links", () => {
		expect(preparePdfMarkdown("[附件](FILE&#58;//readme.txt?v=1#text) [原样](https://example.com?q=1#text)")).toBe(
			"[附件](<file://readme.txt>) [原样](https://example.com?q=1#text)",
		);
	});
	it("rewrites only resolved image source ranges in the shared statement fixture", async () => {
		const source = await readFile(new URL("../../../fixtures/markdown/statement.md", import.meta.url), "utf8");
		const result = preparePdfMarkdown(source, new Map([["file://first.svg", "/images/first.svg"]]));
		expect(result).toContain("![跨栏目图片](/images/first.svg)");
		expect(result).toContain("![实体与转义](/images/first.svg)");
		for (const original of [
			"$a+b$[^note]",
			"| A | B |",
			"![不解析](file://missing.png)",
			"[figure]: FILE&#58;//first.svg?version=1#figure",
			"[^note]: 保留 &amp; 实体和 **脚注**。",
		])
			expect(result).toContain(original);
	});
	it("locates the same attachment as the preview for protocol casing and suffixes", () => {
		expect(
			preparePdfMarkdown(
				"![图](FILE&#58;//figure.svg?v=2#figure)",
				new Map([["file://figure.svg", "images/figure.svg"]]),
			),
		).toBe("![图](images/figure.svg)");
	});
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
