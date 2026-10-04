import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

let root: string, store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-drafts-"));
	store = new ManualProjectStore({ root });
});
afterEach(async () => {
	await store.database.sql.close();
	await rm(root, { recursive: true, force: true });
});
const access = async () => {};

it("preserves the previous file view across uploads and deletions, blob GC and restoration", async () => {
	const project = await store.create("acm");
	await store.update(project.id, {
		title: "First",
		reference: { language: "python3", code: "print(1)" },
		boundaryConditions: [{ id: "minimum", name: "n = 1", rule: { kind: "cases", caseIds: ["manual:1"] } }],
	});
	const original = (await store.addTextCase(project.id, { name: "1.in", input: "1\n", output: "1\n" })).project;
	await store.upload(
		project.id,
		"1.in",
		(async function* () {
			yield Buffer.from("2\n");
		})(),
		original.revision,
	);
	const changed = await store.snapshot(project.id);
	await store.deleteCases(project.id, ["1"], changed.revision);
	await store.database.pruneBlobs();
	const history = await store.history.get(project.id, original.revision);
	expect(history.project.cases[0].inputHash).toBe(original.cases[0].inputHash);
	expect(await store.database.readBuffer("draft-file", history.id, "manual/1.in")).toEqual(Buffer.from("1\n"));
	const before = await store.snapshot(project.id);
	const restored = await store.history.restore(project.id, original.revision, before.revision, access);
	expect(restored).toMatchObject({
		revision: before.revision + 1,
		title: "First",
		boundaryConditions: original.boundaryConditions,
		cases: original.cases,
	});
	expect(restored.lastReport).toBeUndefined();
	expect(await readFile(await store.dataFile(project.id, "manual", "1.in"), "utf8")).toBe("1\n");
	expect((await store.history.get(project.id, changed.revision)).project.cases[0].inputHash).not.toBe(
		original.cases[0].inputHash,
	);
});

it("restores hidden content, removes newer optional fields and keeps the project identity", async () => {
	const project = await store.create("acm");
	const before = await store.update(project.id, {
		reference: { language: "python3", code: "print(1)" },
		generatorSource: "old gen",
	});
	const changed = await store.update(project.id, {
		problemType: "communication",
		communication: { judgeSource: "judge", judgeStandard: "cpp17", secondRound: "interactive" },
		boundaryConditions: [{ id: "extra", name: "later", rule: { kind: "cases", caseIds: [] } }],
	});
	const restored = await store.history.restore(project.id, before.revision, changed.revision, access);
	expect(restored).toMatchObject({
		id: project.id,
		createdAt: project.createdAt,
		problemType: "standard",
		generatorSource: "old gen",
	});
	expect(restored.communication).toEqual(before.communication);
	expect(restored.boundaryConditions).toBeUndefined();
});

it("does not create a history version for same-revision verification metadata, and rejects racing restores", async () => {
	const project = await store.create("acm");
	const original = await store.update(project.id, { title: "original" });
	const loaded = await store.load(project.id);
	await store.save(loaded);
	await store.save(loaded);
	expect(await store.history.list(project.id)).toHaveLength(2);
	const current = await store.update(project.id, { title: "newer" });
	const concurrent = new ManualProjectStore({ root });
	const commit = store.database.commitFiles.bind(store.database);
	vi.spyOn(store.database, "commitFiles").mockImplementationOnce(async (files, apply, owners) => {
		await concurrent.update(project.id, { title: "winner", expectedRevision: current.revision });
		return commit(files, apply, owners);
	});
	await expect(store.history.restore(project.id, original.revision, current.revision, access)).rejects.toMatchObject({
		statusCode: 409,
	});
	expect((await store.snapshot(project.id)).title).toBe("winner");
	await expect(store.history.restore(project.id, original.revision, undefined, access)).rejects.toMatchObject({
		statusCode: 422,
	});
});

it("bounds history, isolates accounts and removes history references when deleting the project", async () => {
	const project = await store.create("acm");
	for (let index = 0; index < 43; index++) await store.update(project.id, { title: String(index) });
	const rows = await store.history.list(project.id);
	expect(rows).toHaveLength(41);
	expect(rows[0].current).toBe(true);
	expect(rows.at(-1)?.revision).toBe(3);
	const foreign = new ManualProjectStore({ root: join(root, "foreign") });
	await expect(foreign.history.get(project.id, 4)).rejects.toMatchObject({ statusCode: 404 });
	await store.delete(project.id);
	expect(await store.database.list("draft-history")).toEqual([]);
	expect(await store.database.sql.one("SELECT count(*)::int AS n FROM files WHERE owner_kind='draft-file'")).toEqual({
		n: 0,
	});
});
