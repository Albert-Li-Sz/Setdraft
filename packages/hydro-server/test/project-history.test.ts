import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualRelease, ManualVerificationReport } from "@setdraft/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { copyProject, restoreProject } from "../src/project-history.ts";

let root: string;
let source: ManualProjectStore;
let target: ManualProjectStore;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-history-"));
	source = new ManualProjectStore({ root: join(root, "a") });
	target = new ManualProjectStore({ root: join(root, "b") });
});
afterEach(async () => {
	source.database.sql.close();
	target.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

async function fixture(structuredStatement = false) {
	const project = await source.create("acm");
	await source.update(project.id, {
		title: "Original",
		slug: "original",
		statement: "Statement",
		...(structuredStatement
			? {
					statementSections: {
						description: "Original description",
						input: "Input",
						output: "Output",
						interaction: "Hidden protocol",
						notes: "Notes",
					},
				}
			: {}),
		reference: { language: "cpp17", code: "code" },
		attachments: [{ name: "note.txt", contentBase64: Buffer.from("attachment").toString("base64") }],
	});
	await source.addTextCase(project.id, { name: "1.in", input: "1 2\n", output: "3\n" });
	await source.database.commitFiles([
		{ ownerKind: "generated", ownerId: project.id, name: "2.in", source: { bytes: Buffer.from("2 3\n") } },
		{ ownerKind: "generated", ownerId: project.id, name: "2.out", source: { bytes: Buffer.from("5\n") } },
		{ ownerKind: "pdf", ownerId: project.id, name: "problem.pdf", source: { bytes: Buffer.from("%PDF-1.4 test") } },
	]);
	const current = await source.load(project.id);
	current.domjudgePdf = { size: 13, sha256: hash(Buffer.from("%PDF-1.4 test")) };
	current.generatedFromHash = "generation-hash";
	const report: ManualVerificationReport = {
		mode: "finalize",
		success: true,
		checks: [],
		caseCount: 2,
		generatedCount: 1,
		oracleCount: 0,
		validatorUsed: false,
		checkerUsed: true,
		revision: current.revision,
		projectHash: "project-hash",
		issues: [],
		verifiedAt: new Date().toISOString(),
	};
	current.lastReport = report;
	await source.save(current);
	const release: ManualRelease = {
		id: randomUUID(),
		name: "初版",
		projectId: project.id,
		title: current.title,
		slug: current.slug,
		scoringMode: "acm",
		revision: current.revision,
		createdAt: new Date().toISOString(),
		projectHash: report.projectHash,
		report,
		checkerMode: "text",
		domjudgePdf: true,
	};
	const files: Record<string, Buffer> = {
		"project.json": Buffer.from(JSON.stringify(current)),
		"problem.pdf": Buffer.from("%PDF-1.4 test"),
	};
	for (const origin of ["manual", "generated"] as const)
		for (const file of await source.database.fileEntries(origin, project.id))
			files[`data/${origin}/${file.name}`] = await readFile(await source.dataFile(project.id, origin, file.name));
	const dir = join(source.releaseDirectory(release.id), "source");
	for (const [name, bytes] of Object.entries(files)) {
		await mkdir(join(dir, name, ".."), { recursive: true });
		await writeFile(join(dir, name), bytes);
	}
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({
			projectId: project.id,
			projectHash: report.projectHash,
			cases: (await source.snapshot(project.id)).cases,
			files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])),
		}),
	);
	await source.database.put("release", release.id, release);
	current.latestReleaseId = release.id;
	await source.save(current);
	return { project: await source.snapshot(project.id), release, dir };
}

describe("problem copies and release restoration", () => {
	it("copies current content and all test origins independently, excluding releases and reports", async () => {
		const { project } = await fixture(true);
		const copied = await copyProject(source, project.id, target, project.revision);
		expect(copied.id).not.toBe(project.id);
		expect(copied).toMatchObject({
			title: project.title,
			statement: project.statement,
			statementSections: project.statementSections,
			reference: project.reference,
			attachments: project.attachments,
			cases: project.cases,
			generatedFromHash: project.generatedFromHash,
			revision: 0,
		});
		expect(copied.latestReleaseId).toBeUndefined();
		expect(copied.lastReport).toBeUndefined();
		expect(await target.releases.listReleases()).toEqual([]);
		for (const kind of ["manual", "generated", "pdf"])
			for (const file of await source.database.fileEntries(kind, project.id))
				expect(await target.database.readBuffer(kind, copied.id, file.name)).toEqual(
					await source.database.readBuffer(kind, project.id, file.name),
				);
		await target.update(copied.id, { title: "Recipient edited" });
		await source.delete(project.id);
		expect((await target.snapshot(copied.id)).title).toBe("Recipient edited");
		expect(await target.database.readBuffer("manual", copied.id, "1.in")).toEqual(Buffer.from("1 2\n"));
	});
	it("restores all content and file sets atomically, increments revision and retains every release", async () => {
		const { project, release } = await fixture();
		await source.update(project.id, {
			title: "Mistake",
			statement: "Wrong",
			statementSections: { description: "New sections", input: "", output: "", interaction: "", notes: "" },
			reference: { language: "python3", code: "wrong" },
			oracle: { language: "java", code: "unexpected" },
			attachments: [],
		});
		await source.addTextCase(project.id, { name: "3.in", input: "extra" });
		await source.deleteDomjudgePdf(project.id);
		const before = await source.snapshot(project.id);
		const restored = await restoreProject(source, project.id, release.id, before.revision);
		expect(restored).toMatchObject({
			title: project.title,
			statement: project.statement,
			reference: project.reference,
			attachments: project.attachments,
			cases: project.cases,
			domjudgePdf: project.domjudgePdf,
			revision: before.revision + 1,
			createdAt: project.createdAt,
			generatedFromHash: project.generatedFromHash,
		});
		expect(restored.oracle).toBeUndefined();
		expect(restored.statementSections).toBeUndefined();
		expect(restored.lastReport).toBeUndefined();
		expect(restored.latestReleaseId).toBe(release.id);
		expect(await source.releases.listReleases()).toHaveLength(1);
		expect(await source.database.filePath("manual", project.id, "3.in")).toBeUndefined();
		expect(await readFile((await source.domjudgePdfFile(project.id)).path, "utf8")).toBe("%PDF-1.4 test");
		await expect(
			source.update(project.id, { title: "Stale window", expectedRevision: before.revision }),
		).rejects.toMatchObject({ statusCode: 409 });
	});
	it("restores structured sections and inactive interactive text from the immutable source", async () => {
		const { project, release } = await fixture(true);
		const changed = await source.update(project.id, {
			judgingMode: "interactive",
			statementSections: {
				description: "New description",
				input: "",
				output: "",
				interaction: "New protocol",
				notes: "",
			},
		});
		const restored = await restoreProject(source, project.id, release.id, changed.revision);
		expect(restored.statementSections).toEqual(project.statementSections);
		expect(restored.statement).toBe(project.statement);
		expect(restored.judgingMode).toBe("default");
		expect(restored.lastReport).toBeUndefined();
	});
	it("rejects missing revisions, stale versions, and releases belonging to another problem", async () => {
		const { project, release } = await fixture();
		const another = await source.create("acm");
		await expect(restoreProject(source, another.id, release.id, another.revision)).rejects.toMatchObject({
			statusCode: 404,
		});
		for (const revision of [undefined, project.revision - 1]) {
			await expect(restoreProject(source, project.id, release.id, revision)).rejects.toMatchObject({
				statusCode: revision === undefined ? 422 : 409,
			});
			await expect(copyProject(source, project.id, target, revision)).rejects.toMatchObject({
				statusCode: revision === undefined ? 422 : 409,
			});
		}
		expect(await source.snapshot(project.id)).toEqual(project);
		expect(await target.list()).toEqual([]);
	});
	it("preserves current content when a release is damaged or a file is missing", async () => {
		const { project, release, dir } = await fixture();
		const edited = await source.update(project.id, { title: "Keep me" });
		await writeFile(join(dir, "data/manual/1.in"), "corruption");
		await expect(restoreProject(source, project.id, release.id, edited.revision)).rejects.toMatchObject({
			statusCode: 422,
		});
		expect(await source.snapshot(project.id)).toEqual(edited);
		await rm(join(dir, "data/manual/1.in"));
		await expect(restoreProject(source, project.id, release.id, edited.revision)).rejects.toMatchObject({
			statusCode: 422,
		});
		expect(await source.snapshot(project.id)).toEqual(edited);
	});
	it("refuses copying when access is revoked before commit, without creating partial data", async () => {
		const { project } = await fixture();
		await expect(
			copyProject(source, project.id, target, project.revision, () => {
				throw new Error("revoked");
			}),
		).rejects.toThrow("revoked");
		expect(await target.list()).toEqual([]);
		expect(await target.database.sql.one("SELECT count(*)::integer AS n FROM files", [])).toMatchObject({ n: 0 });
	});
	it("rejects an intervening database update during restoration and keeps the winning file view", async () => {
		const { project, release } = await fixture();
		const concurrent = new ManualProjectStore({ root: source.root });
		const commit = source.database.commitFiles.bind(source.database);
		vi.spyOn(source.database, "commitFiles").mockImplementationOnce(async (files, apply, owners) => {
			await concurrent.update(project.id, { title: "Concurrent winner", expectedRevision: project.revision });
			return await commit(files, apply, owners);
		});
		try {
			await expect(restoreProject(source, project.id, release.id, project.revision)).rejects.toMatchObject({
				statusCode: 409,
			});
			expect((await source.snapshot(project.id)).title).toBe("Concurrent winner");
		} finally {
			concurrent.database.sql.close();
		}
	});
	it("restores legacy snapshots with default language standards and no explicit checker mode", async () => {
		const { project, release, dir } = await fixture();
		const legacy = JSON.parse(await readFile(join(dir, "project.json"), "utf8")) as Record<string, unknown>;
		for (const field of ["scoringMode", "generatorStandard", "checkerStandard", "validatorStandard", "checkerMode"])
			delete legacy[field];
		const bytes = Buffer.from(JSON.stringify(legacy));
		await writeFile(join(dir, "project.json"), bytes);
		const manifest = JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")) as {
			files: Record<string, string>;
		};
		manifest.files["project.json"] = hash(bytes);
		await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));
		const changed = await source.update(project.id, { checkerMode: "custom", checkerSource: "new checker" });
		const restored = await restoreProject(source, project.id, release.id, changed.revision);
		expect(restored).toMatchObject({
			scoringMode: "acm",
			checkerMode: "text",
			generatorStandard: "cpp17",
			checkerStandard: "cpp17",
			validatorStandard: "cpp17",
			checkerSource: "",
		});
	});

	it("renames only release metadata and validates names", async () => {
		const { release, dir } = await fixture();
		const content = await readFile(join(dir, "project.json"));
		expect(await source.releases.rename(release.id, "  最终版  ")).toEqual({ ...release, name: "最终版" });
		expect(await readFile(join(dir, "project.json"))).toEqual(content);
		for (const name of [null, " ", "x".repeat(81)])
			await expect(source.releases.rename(release.id, name)).rejects.toMatchObject({ statusCode: 422 });
	});
});
