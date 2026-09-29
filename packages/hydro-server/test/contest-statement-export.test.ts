import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultContestPdfOptions } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as contestPdf from "../src/contest-pdf.ts";
import { ContestStore } from "../src/contests.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";

let root: string;
let projects: ManualProjectStore;
let contests: ContestStore;
let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-contest-statement-"));
	projects = new ManualProjectStore({ root });
	contests = new ContestStore(projects);
});
afterEach(async () => {
	vi.restoreAllMocks();
	projects.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

it("defaults legacy contests to disabled PDF and validates configurations without mutating drafts", async () => {
	const draft = await contests.create({ title: "Contest", slug: "contest" });
	const { pdf: _pdf, ...legacy } = draft;
	await projects.database.put("contest", draft.id, legacy);
	expect((await contests.get(draft.id)).pdf).toEqual(defaultContestPdfOptions);
	for (const pdf of [
		null,
		{},
		{ ...defaultContestPdfOptions, enabled: "true" },
		{ ...defaultContestPdfOptions, coverNotes: "x".repeat(20_001) },
	]) {
		await expect(contests.update(draft.id, { ...legacy, pdf })).rejects.toThrow();
		expect((await contests.get(draft.id)).revision).toBe(draft.revision);
	}
	const configured = await contests.update(draft.id, {
		...legacy,
		pdf: { ...defaultContestPdfOptions, enabled: true, author: "Authors", coverNotes: "Read all problems." },
	});
	expect(configured.pdf).toMatchObject({ enabled: true, author: "Authors", coverNotes: "Read all problems." });
	await expect(contests.previewPdf(draft.id, draft.revision)).rejects.toMatchObject({ statusCode: 409 });
	await expect(contests.previewPdf(draft.id, configured.revision)).rejects.toMatchObject({ statusCode: 422 });
});

it.skipIf(!dockerAvailable)(
	"binds PDFs to published snapshots and replaces nested DOMjudge statements without rewriting old archives",
	async () => {
		const created = await projects.create("acm");
		const statementSections = {
			description: "Published description.",
			input: "Two integers.",
			output: "Their sum.",
			interaction: "Hidden protocol.",
			notes: "Published notes.",
		};
		await projects.update(created.id, {
			title: "Published title",
			slug: "published",
			statementSections,
			samples: [{ input: "1 2\n", output: "3\n" }],
			reference: { language: "python3", code: "print(sum(map(int, input().split())))" },
		});
		await projects.addTextCase(created.id, { input: "2 3\n", output: "5\n" });
		const oldPdf = Buffer.from("%PDF-1.4 historical uploaded statement");
		const project = await projects.load(created.id);
		project.domjudgePdf = { size: oldPdf.length, sha256: createHash("sha256").update(oldPdf).digest("hex") };
		await projects.database.commitFiles(
			[{ ownerKind: "pdf", ownerId: created.id, name: "problem.pdf", source: { bytes: oldPdf } }],
			async () => await projects.save(project),
		);
		const published = await projects.pipeline.finalize(created.id);
		expect(published.report.success, JSON.stringify(published.report.checks)).toBe(true);
		if (!published.release) throw new Error("Expected a release");
		const cached = await projects.releases.exportDomjudge(published.release.id);
		const originalArchive = await readFile(cached.path);
		expect(execFileSync("unzip", ["-p", cached.path, "problem.pdf"])).toEqual(oldPdf);
		await projects.update(created.id, {
			title: "Unpublished title",
			statementSections: { ...statementSections, description: "Unpublished description." },
		});
		const draft = await contests.create({ title: "Contest booklet", slug: "contest-booklet" });
		const configured = await contests.update(draft.id, {
			...draft,
			releaseIds: [published.release.id],
			pdf: {
				...defaultContestPdfOptions,
				enabled: true,
				author: "Problem authors",
				coverNotes: "Cover instructions.",
			},
		});
		const compile = vi.spyOn(contestPdf, "compileContestPdfs");
		const exported = await contests.export(draft.id, "domjudge");
		expect(compile).toHaveBeenCalledTimes(1);
		expect(compile.mock.calls[0][1]).toMatchObject({
			title: draft.title,
			options: configured.pdf,
			problems: [{ label: "A", title: "Published title", statementSections }],
		});
		const bundle = await contests.releaseFile(exported.id);
		const entries = execFileSync("unzip", ["-Z1", bundle.path], { encoding: "utf8" });
		expect(entries).toContain("contest-booklet/booklet.pdf");
		expect(entries).toContain("contest-booklet/statements/A.pdf");
		const singlePdf = execFileSync("unzip", ["-p", bundle.path, "contest-booklet/statements/A.pdf"]);
		expect(singlePdf.subarray(0, 5).toString()).toBe("%PDF-");
		const nestedPath = join(root, "nested-problem.zip");
		await writeFile(nestedPath, execFileSync("unzip", ["-p", bundle.path, "contest-booklet/problems/A.zip"]));
		expect(execFileSync("unzip", ["-p", nestedPath, "problem.pdf"])).toEqual(singlePdf);
		expect(await readFile(cached.path)).toEqual(originalArchive);
		expect((await projects.releases.release(published.release.id)).domjudgePdf).toBe(true);
		const downloadablePdf = await contests.releaseFile(exported.id, "pdf");
		expect(await readFile(downloadablePdf.path)).toEqual(
			execFileSync("unzip", ["-p", bundle.path, "contest-booklet/booklet.pdf"]),
		);
		await contests.update(draft.id, {
			...configured,
			title: "Changed contest",
			pdf: { ...defaultContestPdfOptions },
		});
		expect((await contests.release(exported.id)).pdf).toEqual(configured.pdf);
		const disabled = await contests.export(draft.id, "hydro");
		expect(disabled.pdf).toBeUndefined();
		await expect(contests.releaseFile(disabled.id, "pdf")).rejects.toMatchObject({ statusCode: 404 });
		expect(
			execFileSync("unzip", ["-Z1", (await contests.releaseFile(disabled.id)).path], { encoding: "utf8" }),
		).not.toContain(".pdf");
		const sourcePath = join(projects.releaseDirectory(published.release.id), "source", "project.json");
		const source: Record<string, unknown> = JSON.parse(await readFile(sourcePath, "utf8"));
		await writeFile(
			sourcePath,
			JSON.stringify({ ...source, statementSections: { ...statementSections, description: "Tampered snapshot." } }),
		);
		const latest = await contests.get(draft.id);
		await expect(contests.previewPdf(draft.id, latest.revision)).rejects.toMatchObject({ statusCode: 422 });
	},
	120_000,
);
