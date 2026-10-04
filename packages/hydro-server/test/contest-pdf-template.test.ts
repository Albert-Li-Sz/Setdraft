import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { createContestPdfCompiler, renderContestPdf } from "../src/contest-pdf-compiler.ts";
import { buildContestPdfSources, type ContestPdfDocument } from "../src/contest-pdf-document.ts";
import { pdfFixture } from "./fixtures/contest-pdf.ts";

const assets = fileURLToPath(new URL("../assets/", import.meta.url));
const fontHashes: Record<string, string> = {
	"NewCMMath-Book.otf": "765b14d6f8a8d3e9b319f168cc1b10dd89df38d34108e75b44013904bb173218",
	"cmunss.otf": "a0e41b8611156eed280c3a730ddcf03c35090fb03efc9413bbe2b1e2915de95b",
	"cmunsx.otf": "5d3a5b51898be3279b28734ac135dc89f4971dc7be1215981eff3fa9f66300da",
	"cmuntt.ttf": "75b653ab15c2a678a303a1293db1692cbe6c3dfdd5d90f5fce97690aa9991948",
	"FZSSK.ttf": "00fdbfb433aaf4c00dd02b79319bbfe94ffca399dba1be9e6455e4bb650e0273",
	"FZHTK.ttf": "5be63dbc864f04b012f83db53b2e0ea4a2c70311c4a42cc33c6206ae9cd47ef0",
	"FZKTK.ttf": "6527f1a53414d9d1dcdb64f7f26cc451ef7ab2c57a2a2b1a06e5255e97f2d894",
	"FZXBSK.ttf": "a6e4e1ee8878b824b4eb66dc58e25ed255992ef3ac901264b8444a5bc5a30029",
};
const fonts = await Promise.all(Object.keys(fontHashes).map((name) => readFile(join(assets, "xcpc/fonts", name))));
const compiler = await createContestPdfCompiler();
const upstream = await readFile(join(assets, "xcpc/upstream.typ"), "utf8");
const localUpstream = upstream.replace(/@preview\/(numbly|cmarker|mitex):[0-9.]+/gu, "/$1/lib.typ");
compiler.addSource("/xcpc/original-local.typ", localUpstream);
afterAll(() => compiler.reset());

function render(source: string) {
	return renderContestPdf(compiler, `#set document(date: none)\n${source}`);
}

interface LayoutSpan {
	text: string;
	size: string;
	position: { page: number; x: string; y: string };
}

async function layoutSpans(source: string): Promise<LayoutSpan[]> {
	compiler.addSource(
		"/layout.typ",
		`#show text: it => context [#metadata((text: it.text, size: text.size, position: here().position())) <layout-span>#it]\n${source}`,
	);
	return compiler.runWithWorld({ mainFilePath: "/layout.typ" }, async (world) => {
		const compilation = await world.compile({ diagnostics: "full" });
		expect(compilation.hasError, JSON.stringify(compilation.diagnostics)).toBe(false);
		return world.query<LayoutSpan[]>({ selector: "<layout-span>", field: "value" });
	});
}

function span(spans: LayoutSpan[], text: string): LayoutSpan {
	const found =
		spans.find((entry) => entry.text.trim() === text) ??
		(text.endsWith(":") ? spans.find((entry) => entry.text.trim() === text.slice(0, -1)) : undefined);
	if (!found) throw new Error(`Missing layout span: ${text}`);
	return found;
}

it.each([true, false])(
	"places cover notes in the bottom information block with problemList=%s",
	async (problemList) => {
		const spans = await layoutSpans(
			buildContestPdfSources({ ...pdfFixture, options: { ...pdfFixture.options, problemList } }).booklet,
		);
		const note = span(spans, "请检查试题册是否完整。比赛时长：");
		expect(note.position.page).toBe(1);
		expect(Number.parseFloat(note.position.y)).toBeGreaterThan(600);
		if (problemList)
			expect(Number.parseFloat(note.position.y)).toBeGreaterThan(
				Number.parseFloat(span(spans, "试题列表").position.y),
			);
	},
);

it.each([
	{ language: "zh", time: "时间限制", memory: "内存限制" },
	{ language: "en", time: "Time Limit", memory: "Memory Limit" },
] as const)("matches the supplied example's natural-width LaTeX tabular limits: $language", async (labels) => {
	const first = pdfFixture.problems[0];
	const document: ContestPdfDocument = {
		...pdfFixture,
		options: { ...pdfFixture.options, language: labels.language },
		problems: [{ ...first, timeLimit: "1 second", memoryLimit: "512 megabytes" }],
	};
	const actual = await layoutSpans(buildContestPdfSources(document).problems.get("A")!);
	const description = String.raw`\begin{tabular}{ll}
${labels.time}: & 1 second \\
${labels.memory}: & 512 megabytes \\
\end{tabular}`;
	const expected = await layoutSpans(`#import "/xcpc/original-local.typ": contest-conf
#show: contest-conf.with(enable-titlepage: false, enable-header-footer: false,
  problems: ((problem: (display_name: ${JSON.stringify(first.title)}, format: "latex", samples: ()),
    statement: (description: ${JSON.stringify(description)}, input: "", output: "", notes: "")),))`);
	for (const text of [`${labels.time}:`, `${labels.memory}:`, "1 second", "512 megabytes"]) {
		const actualSpan = span(actual, text);
		const expectedSpan = span(expected, text);
		expect(actualSpan.size).toBe("12pt");
		expect(actualSpan.position).toEqual(expectedSpan.position);
	}
});

it("keeps scoring tables out of the preview fixture without stripping author-written tables", async () => {
	expect(pdfFixture.problems[0].statementSections?.description).not.toContain("全部数据");
	const first = pdfFixture.problems[0];
	const description = "| 范围 | 分值 |\n| --- | --- |\n| 全部数据 | 100 |";
	const source = buildContestPdfSources({
		...pdfFixture,
		problems: [{ ...first, statementSections: { ...first.statementSections!, description } }],
	}).booklet;
	expect(source).toContain("全部数据");
	expect((await render(source)).pages).toBe(2);
});

it("retains the pinned upstream template and all eight original font files byte for byte", () => {
	expect(createHash("sha256").update(upstream).digest("hex")).toBe(
		"c130ad6e5b30c4315e5373ffec1bd95d7058dc731954611d3a6e56f945d8759f",
	);
	for (const [index, hash] of Object.values(fontHashes).entries())
		expect(createHash("sha256").update(fonts[index]).digest("hex")).toBe(hash);
});

it.each([
	{ language: "zh", titlePage: true, problemList: true, headerFooter: true },
	{ language: "en", titlePage: true, problemList: true, headerFooter: true },
	{ language: "zh", titlePage: false, problemList: true, headerFooter: true },
	{ language: "en", titlePage: true, problemList: false, headerFooter: false },
] as const)(
	"matches upstream cover/statement/sample PDF bytes with automatic limit headers excluded: %j",
	async (options) => {
		const first = pdfFixture.problems[0];
		const document: ContestPdfDocument = {
			...pdfFixture,
			options: { ...pdfFixture.options, ...options, coverNotes: "" },
			problems: [
				{ ...first, samples: [...first.samples, { input: "10 20\n30 40", output: "30\n70" }] },
				{
					...first,
					label: "B",
					title: "Long statement / 多页题面",
					statementSections: {
						...first.statementSections!,
						description: Array.from(
							{ length: 50 },
							() => "A paragraph with **bold**, *emphasis*, $x^2$ and 中文。",
						).join("\n\n"),
					},
				},
			],
		};
		const sources = buildContestPdfSources(document);
		for (const generated of [sources.booklet, ...sources.problems.values()]) {
			// Automatic headers follow the upstream demo's LaTeX tabular, checked separately above.
			const source = generated.replace(/^ {2}limits:.*$/gmu, "  limits: (),");
			const baseline = source
				.replace('"/xcpc/lib.typ"', '"/xcpc/original-local.typ"')
				.replace(/^ {2}cover-notes:.*\n/mu, "");
			const expected = await render(baseline);
			const actual = await render(source);
			expect(actual.pages).toBe(expected.pages);
			expect(Buffer.from(actual.pdf).equals(Buffer.from(expected.pdf))).toBe(true);
		}
	},
	60_000,
);

it.each([
	'<!--raw-typst #panic("RAW_COMMENT_EXECUTED") -->',
	'```typst\n#panic("RAW_TYPST_EXECUTED")\n```',
	'`#panic("INLINE_TYPST_EXECUTED")`{=typst}',
	'#read("/xcpc/LICENSE")',
])("does not execute embedded Typst: %s", async (description) => {
	const first = pdfFixture.problems[0];
	const source = buildContestPdfSources({
		...pdfFixture,
		problems: [{ ...first, statementSections: { ...first.statementSections!, description } }],
	}).booklet;
	expect((await render(source)).pages).toBe(2);
});

it.each([
	'<img src="/xcpc/LICENSE">',
	'<img src="https://example.com/private.svg">',
	'<img src="/images/../xcpc/LICENSE">',
])("blocks HTML images outside the attachment allowlist: %s", async (description) => {
	const first = pdfFixture.problems[0];
	const source = buildContestPdfSources({
		...pdfFixture,
		problems: [{ ...first, statementSections: { ...first.statementSections!, description } }],
	}).booklet;
	await expect(render(source)).rejects.toThrow("已上传");
});

it("never loads remote fonts, packages, or host files outside its virtual filesystem", async () => {
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network request"));
	try {
		const isolated = await createContestPdfCompiler();
		try {
			await renderContestPdf(isolated, buildContestPdfSources(pdfFixture).booklet);
			for (const source of [
				'#read("/etc/passwd")',
				'#read("/job.json")',
				'#read("/xcpc/fonts/FZSSK.ttf")',
				'#import "@preview/numbly:0.1.0": *',
			])
				await expect(renderContestPdf(isolated, source)).rejects.toThrow("PDF 排版失败");
		} finally {
			await isolated.reset();
		}
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		fetch.mockRestore();
	}
});

it("limits physical pages even when page numbering is reset", async () => {
	await expect(
		render(
			'#set text(font: "CMU Sans Serif")\n#for index in range(1001) { counter(page).update(1); [Page]; pagebreak(weak: true) }',
		),
	).rejects.toThrow("1000 页");
}, 30_000);

it("renders communication protocols and long ordered messages across pages without losing legacy examples", async () => {
	const first = pdfFixture.problems[0];
	const source = buildContestPdfSources({
		...pdfFixture,
		problems: [
			{
				...first,
				problemType: "communication",
				judgingMode: "interactive",
				statementSections: {
					...first.statementSections!,
					communication: "Start twice.",
					firstRound: "Encode the private challenge.",
					secondRound: "Decode the message.",
				},
				samples: [{ input: "legacy jury", output: "legacy contestant" }],
				protocolSamples: [
					{
						rounds: [
							{
								round: 1,
								messages: [
									{
										sender: "judge",
										text: Array.from({ length: 150 }, (_, index) => `first-${index} private challenge`).join(
											"\n",
										),
									},
									{ sender: "contestant", text: "encoded" },
								],
							},
							{
								round: 2,
								messages: [
									{ sender: "judge", text: "second handoff" },
									{ sender: "contestant", text: "decoded" },
								],
							},
						],
					},
				],
			},
		],
	}).problems.get("A")!;
	const result = await render(source);
	expect(result.pages).toBeGreaterThan(3);
	const spans = await layoutSpans(source);
	for (const label of [
		"通信说明",
		"第一轮协议",
		"第二轮协议",
		"旧双栏样例（消息顺序未整理）",
		"协议样例",
		"first-149 private challenge",
		"second handoff",
		"decoded",
	])
		expect(
			spans.some((entry) => entry.text.includes(label)),
			label,
		).toBe(true);
	expect(span(spans, "decoded").position.page).toBeGreaterThan(1);
}, 60000);
