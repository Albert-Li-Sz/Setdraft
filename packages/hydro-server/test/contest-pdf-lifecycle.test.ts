import * as childProcess from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { compileContestPdfs } from "../src/contest-pdf.ts";
import * as pdfSources from "../src/contest-pdf-document.ts";
import { pdfFixture } from "./fixtures/contest-pdf.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof childProcess>();
	return { ...original, spawn: vi.fn(original.spawn) };
});

let root: string;
beforeEach(async () => {
	vi.clearAllMocks();
	root = await mkdtemp(join(tmpdir(), "setdraft-pdf-lifecycle-"));
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

it("rejects path traversal, duplicate labels and oversized documents before creating job files", async () => {
	for (const label of ["../escape", "A/B", "booklet", "A\n", "AAAA"])
		await expect(
			compileContestPdfs(root, { ...pdfFixture, problems: [{ ...pdfFixture.problems[0], label }] }),
		).rejects.toMatchObject({ statusCode: 422 });
	await expect(
		compileContestPdfs(root, { ...pdfFixture, problems: [pdfFixture.problems[0], pdfFixture.problems[0]] }),
	).rejects.toMatchObject({ statusCode: 422 });
	await expect(compileContestPdfs(root, { ...pdfFixture, problems: [] })).rejects.toMatchObject({ statusCode: 422 });
	await expect(compileContestPdfs(root, { ...pdfFixture, title: "x".repeat(20 * 1024 * 1024) })).rejects.toMatchObject(
		{ statusCode: 422 },
	);
	expect(await readdir(root)).toEqual([]);
});

it("kills in-flight workers, cleans both stages, and reclaims compiler slots after cancellation", async () => {
	const spawn = vi.mocked(childProcess.spawn);
	const buildSources = vi.spyOn(pdfSources, "buildContestPdfSources");
	const firstController = new AbortController();
	const secondController = new AbortController();
	const document = {
		...pdfFixture,
		problems: [
			{
				...pdfFixture.problems[0],
				statementSections: {
					description: "**nested text** ".repeat(50_000),
					input: "",
					output: "",
					interaction: "",
					notes: "",
				},
			},
		],
	};
	const pending = Promise.allSettled([
		compileContestPdfs(root, document, firstController.signal),
		compileContestPdfs(root, document, secondController.signal),
	]);
	await expect(compileContestPdfs(root, pdfFixture)).rejects.toMatchObject({ statusCode: 429 });
	await vi.waitFor(
		() => {
			expect(spawn).toHaveBeenCalledTimes(2);
			for (const result of spawn.mock.results) {
				expect(result.type).toBe("return");
				if (result.type === "return") expect(result.value.pid).toBeGreaterThan(0);
			}
		},
		{ timeout: 5000, interval: 10 },
	);
	firstController.abort();
	secondController.abort();
	const outcomes = await pending;
	for (const outcome of outcomes) {
		expect(outcome.status).toBe("rejected");
		if (outcome.status === "rejected") expect(outcome.reason.message).toContain("取消");
	}
	expect(await readdir(root)).toEqual([]);
	for (const result of spawn.mock.results)
		if (result.type === "return") expect(result.value.signalCode).toBe("SIGKILL");
	expect(buildSources).not.toHaveBeenCalled();
	const recovered = await compileContestPdfs(
		root,
		{ ...pdfFixture, problems: [pdfFixture.problems[0]] },
		undefined,
		true,
	);
	expect(recovered.problems.size).toBe(0);
	expect((await readFile(recovered.booklet)).subarray(0, 5).toString()).toBe("%PDF-");
	expect(buildSources).not.toHaveBeenCalled();
	await recovered.cleanup();
	expect(await readdir(root)).toEqual([]);
}, 90_000);

it("rejects oversized attachments and decompression dimensions inside the worker and removes failed stages", async () => {
	const oversizedPng = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(oversizedPng);
	oversizedPng.writeUInt32BE(100_000, 16);
	oversizedPng.writeUInt32BE(100_000, 20);
	for (const [bytes, message] of [
		[Buffer.alloc(1024 * 1024 + 1), "1 MiB"],
		[oversizedPng, "1600 万像素"],
	] as const) {
		const document = {
			...pdfFixture,
			problems: [
				{
					...pdfFixture.problems[0],
					attachments: [{ name: "input.png", contentBase64: bytes.toString("base64") }],
				},
			],
		};
		await expect(compileContestPdfs(root, document)).rejects.toThrow(message);
		expect(await readdir(root)).toEqual([]);
	}
}, 30_000);

it("accepts basic SVG with local gradients and rejects complex or externally referenced SVG", async () => {
	const supported =
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><defs><linearGradient id="shade"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="120" height="40" fill="url(#shade)"/><text x="8" y="24">Safe SVG</text></svg>';
	const withSvg = (svg: string) => ({
		...pdfFixture,
		problems: [
			{
				...pdfFixture.problems[0],
				statementSections: {
					description: "![diagram](file://diagram.svg)",
					input: "",
					output: "",
					interaction: "",
					notes: "",
				},
				attachments: [{ name: "diagram.svg", contentBase64: Buffer.from(svg).toString("base64") }],
			},
		],
	});
	const result = await compileContestPdfs(root, withSvg(supported), undefined, true);
	expect((await readFile(result.booklet)).subarray(0, 5).toString()).toBe("%PDF-");
	await result.cleanup();
	for (const svg of [
		'<svg><image href="file:///etc/passwd"/></svg>',
		'<svg><image href="https://example.com/a.png"/></svg>',
		"<svg><foreignObject/></svg>",
		"<svg><filter/></svg>",
		"<svg><script/></svg>",
		"<svg><style/></svg>",
		"<svg><use/></svg>",
		'<svg><path fill="url(&#x68;ttps://example.com/a.svg)"/></svg>',
		'<!DOCTYPE svg [<!ENTITY external SYSTEM "file:///etc/passwd">]><svg>&external;</svg>',
		'<?xml-stylesheet href="https://example.com/a.css"?><svg/>',
		`<svg>${"<g/>".repeat(5000)}</svg>`,
		`<svg>${"<g>".repeat(33)}${"</g>".repeat(33)}</svg>`,
	]) {
		await expect(compileContestPdfs(root, withSvg(svg), undefined, true)).rejects.toThrow("SVG");
		expect(await readdir(root)).toEqual([]);
	}
}, 60_000);
