import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verificationContractVersion } from "@setdraft/contracts";
import { writeStoredArchiveFromFiles } from "../packages/hydro-authoring/dist/index.js";
import { ManualProjectStore } from "../packages/hydro-server/dist/index.js";
import { WorkspaceDatabase } from "../packages/hydro-server/dist/workspace-db.js";

/** Fixed repository package for download/PDF UI baselines. Full E2E creates its releases through the sandbox. */
export async function seedRelease(root, userId) {
	const workspace = join(root, "users", userId);
	const projects = new ManualProjectStore({ root: workspace, database: new WorkspaceDatabase(workspace, userId) });
	const fixture = resolve("fixtures/hydro/a-plus-b");
	const project = await projects.create("acm");
	const source = { title: "A + B", slug: "a-plus-b", statement: await readFile(join(fixture, "hydro/a-plus-b/problem_zh.md"), "utf8"), samples: [{ input: "1 2\n", output: "3\n" }], reference: { language: "cpp17", code: await readFile(join(fixture, "authoring/reference.cc"), "utf8") } };
	source.attachments = [{ name: "addition.svg", contentBase64: (await readFile(join(fixture, "hydro/a-plus-b/additional_file/addition.svg"))).toString("base64") }];
	await projects.update(project.id, source);
	const snapshot = await projects.load(project.id);
	const id = randomUUID();
	const directory = projects.releaseDirectory(id);
	await mkdir(directory, { recursive: true });
	const files = new Map();
	for (const name of await readdir(join(fixture, "hydro"), { recursive: true, withFileTypes: true }))
		if (name.isFile()) files.set(join(name.parentPath, name.name).slice(join(fixture, "hydro").length + 1).replaceAll("\\", "/"), join(name.parentPath, name.name));
	await writeStoredArchiveFromFiles(join(directory, "hydro.zip"), "", files);
	const report = { mode: "finalize", success: true, verificationContractVersion, checks: [], caseCount: 3, generatedCount: 0, oracleCount: 0, validatorUsed: false, checkerUsed: true, revision: snapshot.revision, projectHash: "fixed-contract-fixture", issues: [], verifiedAt: "2026-09-29T00:00:00.000Z" };
	const release = { id, projectId: project.id, title: snapshot.title, slug: snapshot.slug, scoringMode: "acm", judgingMode: "default", checkerMode: "text", revision: snapshot.revision, projectHash: report.projectHash, createdAt: report.verifiedAt, report };
	await projects.database.commitFiles([{ ownerKind: "release-file", ownerId: id, name: "hydro.zip", source: { path: join(directory, "hydro.zip") } }], () => projects.database.put("release", id, release));
	await mkdir(join(directory, "source"), { recursive: true });
	// PDF materialization reads the immutable authoring snapshot and attachment files.
	await writeFile(join(directory, "source/project.json"), JSON.stringify(snapshot));
	await writeFile(join(directory, "source/manifest.json"), JSON.stringify({ projectId: snapshot.id, projectHash: release.projectHash, files: { "project.json": createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") } }));
	await mkdir(join(directory, "source/additional_file"), { recursive: true });
	await writeFile(join(directory, "source/additional_file/addition.svg"), await readFile(join(fixture, "hydro/a-plus-b/additional_file/addition.svg")));
	return release;
}
