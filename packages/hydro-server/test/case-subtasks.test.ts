import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

async function withStore(work: (store: ManualProjectStore) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "hydro-case-subtasks-"));
	const store = new ManualProjectStore({ root });
	try {
		await work(store);
	} finally {
		store.database.sql.close();
		await rm(root, { recursive: true, force: true });
	}
}

it("assigns unassigned cases to an existing subtask and reports orphaned assignments", async () => {
	await withStore(async (store) => {
		const project = await store.create("oi");
		const split = await store.update(project.id, {
			expectedRevision: project.revision,
			subtasks: [
				{ id: 2, type: "sum", score: 60 },
				{ id: 3, type: "sum", score: 40 },
			],
		});
		async function* body() {
			yield Buffer.from("1\n");
		}
		const uploaded = await store.upload(project.id, "1.in", body(), split.revision);
		expect(uploaded.cases[0].subtaskId).toBe(2);

		const orphaned = await store.update(project.id, {
			expectedRevision: uploaded.revision,
			caseSubtasks: { "manual:1": 7 },
		});
		const issues = await store.pipeline.publicationIssues(orphaned);
		expect(issues).toContainEqual(
			expect.objectContaining({ code: "INVALID_CASE_SUBTASK", message: expect.stringContaining("1") }),
		);
	});
});

it("reports a non-canonical ACM grouping during preflight like finalize does", async () => {
	await withStore(async (store) => {
		const project = await store.create("acm");
		const changed = await store.update(project.id, {
			expectedRevision: project.revision,
			subtasks: [{ id: 1, type: "sum", score: 100 }],
		});
		expect(await store.pipeline.publicationIssues(changed)).toContainEqual(
			expect.objectContaining({ code: "INVALID_CASE_SUBTASK", message: expect.stringContaining("ACM") }),
		);
	});
});

it("rejects deleting a missing file and clears the deleted input's subtask assignment", async () => {
	await withStore(async (store) => {
		const project = await store.create("oi");
		await expect(store.deleteFile(project.id, "9.in", project.revision)).rejects.toMatchObject({ statusCode: 404 });
		expect((await store.get(project.id)).revision).toBe(project.revision);

		const added = await store.addTextCase(project.id, { input: "1\n", subtaskId: 1 });
		expect(added.project.caseSubtasks).toHaveProperty("manual:1", 1);
		const deleted = await store.deleteFile(project.id, "1.in", added.project.revision);
		expect(deleted.caseSubtasks).not.toHaveProperty("manual:1");
	});
});
