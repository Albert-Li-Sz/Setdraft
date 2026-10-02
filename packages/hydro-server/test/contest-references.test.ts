import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ManualRelease, verificationContractVersion } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";

let root: string;
let projects: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-references-"));
	projects = new ManualProjectStore({ root });
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});
async function releaseFixture(): Promise<ManualRelease> {
	const project = await projects.create("acm");
	const release: ManualRelease = {
		id: randomUUID(),
		projectId: project.id,
		name: "v1",
		revision: 1,
		scoringMode: "acm",
		checkerMode: "text",
		projectHash: "hash",
		title: "Test",
		slug: "test",
		createdAt: new Date().toISOString(),
		report: {
			mode: "finalize",
			success: true,
			verificationContractVersion,
			checks: [{ stage: "reference", passed: true, message: "ok" }],
			caseCount: 1,
			generatedCount: 0,
			oracleCount: 0,
			checkerUsed: true,
			validatorUsed: false,
			issues: [],
			projectHash: "hash",
			revision: 1,
			verifiedAt: new Date().toISOString(),
		},
	};
	await projects.database.put("release", release.id, release);
	return release;
}
it("rechecks selections after a competing store deletes a release before the contest commit", async () => {
	const contests = new ContestStore(projects);
	const draft = await contests.create({ title: "Contest", slug: "contest" });
	const release = await releaseFixture();
	const competing = new ManualProjectStore({ root });
	let enter!: () => void;
	let resume!: () => void;
	const reached = new Promise<void>((resolve) => {
		enter = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const transaction = projects.database.transaction.bind(projects.database);
	let intercepted = false;
	vi.spyOn(projects.database, "transaction").mockImplementation(async (callback) => {
		if (!intercepted) {
			intercepted = true;
			enter();
			await gate;
		}
		return transaction(callback);
	});
	const saving = contests.update(draft.id, { ...draft, releaseIds: [release.id] });
	const rejected = expect(saving).rejects.toMatchObject({ statusCode: 404 });
	await reached;
	await competing.releases.deleteRelease(release.id);
	resume();
	await rejected;
	expect((await contests.get(draft.id)).releaseIds).toEqual([]);
});
it.each(["release", "project"])("atomically prevents %s deletion after a contest selects its release", async (kind) => {
	const release = await releaseFixture();
	const contests = new ContestStore(projects);
	const draft = await contests.create({ title: "Contest", slug: "contest" });
	await contests.update(draft.id, { ...draft, releaseIds: [release.id] });
	const competing = new ManualProjectStore({ root });
	await expect(
		kind === "project" ? competing.delete(release.projectId) : competing.releases.deleteRelease(release.id),
	).rejects.toMatchObject({ statusCode: 409 });
	expect(await projects.releases.release(release.id)).toMatchObject({ id: release.id });
});
