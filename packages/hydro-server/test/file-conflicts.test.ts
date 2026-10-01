import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

async function* bytes() {
	yield Buffer.from("1\n");
}

it("rejects answer conflicts before commit for every upload order", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-conflicts-"));
	const store = new ManualProjectStore({ root });
	try {
		for (const order of [
			["1.in", "1.out", "1.ans"],
			["1.ans", "1.out", "1.in"],
			["1.out", "1.ans", "1.in"],
		]) {
			const project = await store.create("acm");
			for (const name of order) {
				const other = name.endsWith(".out") ? "1.ans" : name.endsWith(".ans") ? "1.out" : undefined;
				const conflict = other && (await store.database.filePath("manual", project.id, other));
				const before = await store.snapshot(project.id);
				if (conflict) {
					await expect(store.upload(project.id, name, bytes(), before.revision)).rejects.toMatchObject({
						statusCode: 422,
					});
					expect(await store.snapshot(project.id)).toEqual(before);
					expect(await store.database.filePath("manual", project.id, name)).toBeUndefined();
				} else await store.upload(project.id, name, bytes(), before.revision);
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("lists a historically damaged project and allows removing its conflicting answer", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-damaged-"));
	const store = new ManualProjectStore({ root });
	try {
		const project = await store.create("acm");
		await store.addTextCase(project.id, { name: "1.in", input: "1", output: "1" });
		await store.database.storeBuffer("manual", project.id, "1.ans", Buffer.from("2"));
		expect((await store.list())[0].dataIssues).toEqual([{ code: "ANSWER_CONFLICT", files: ["1.out", "1.ans"] }]);
		const current = await store.load(project.id);
		await expect(store.caseList(current)).rejects.toMatchObject({ statusCode: 422 });
		expect((await store.deleteFile(project.id, "1.ans", current.revision)).dataIssues).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
