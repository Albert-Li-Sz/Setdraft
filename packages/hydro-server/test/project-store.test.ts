import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

it("rejects a racing upload with the committed file view and preserves the winner's draft", async () => {
	const root = await mkdtemp(join(tmpdir(), "hydro-project-race-"));
	const first = new ManualProjectStore({ root });
	const second = new ManualProjectStore({ root });
	try {
		const project = await first.create("oi");
		await first.addTextCase(project.id, { input: "old", subtaskId: 1 });
		let release!: () => void;
		let started!: () => void;
		const streaming = new Promise<void>((resolve) => {
			started = resolve;
		});
		const proceed = new Promise<void>((resolve) => {
			release = resolve;
		});
		async function* body() {
			started();
			await proceed;
			yield Buffer.from("replacement content");
		}
		const upload = first.upload(project.id, "1.in", body(), 1);
		await streaming;
		await second.update(project.id, { title: "winner", expectedRevision: 1 });
		const rejected = expect(upload).rejects.toMatchObject({
			statusCode: 409,
			current: { title: "winner", revision: 2, cases: [{ inputBytes: 3 }] },
		});
		release();
		await rejected;
		expect(await first.get(project.id)).toMatchObject({ title: "winner", revision: 2 });
		expect(await readFile((await first.file(project.id, "1.in")).path, "utf8")).toBe("old");
		await first.database.pruneBlobs();
		expect(await first.database.readBuffer("manual", project.id, "1.in")).toEqual(Buffer.from("old"));
	} finally {
		first.database.db.close();
		second.database.db.close();
		await rm(root, { recursive: true, force: true });
	}
});
