import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManualRelease } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { writeLegacyProblemExport } from "../src/legacy-exports.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { sandboxPolicy } from "../src/sandbox-policy.ts";
import { TaskQueue } from "../src/tasks.ts";

let root: string;
let projects: ManualProjectStore;
const queues: TaskQueue[] = [];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-ownership-"));
	projects = new ManualProjectStore({ root });
});
afterEach(async () => {
	for (const q of queues) q.close();
	await Promise.all(queues.splice(0).map((q) => q.idle()));
	await rm(root, { recursive: true, force: true });
});
async function releaseFixture() {
	const project = await projects.create("acm");
	const id = randomUUID();
	const release: ManualRelease = {
		id,
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
	await projects.database.put("release", id, release);
	return release;
}
it.each(["fps.xml", "qduoj.zip", "domjudge.zip"])(
	"rejects a staged %s export committed after project deletion",
	async (name) => {
		const release = await releaseFixture();
		const file = join(root, "staged");
		await writeFile(file, "export");
		let staged!: () => void;
		let resume!: () => void;
		const barrier = new Promise<void>((resolve) => {
			staged = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const transaction = projects.database.transaction.bind(projects.database);
		let intercepted = false;
		const spy = vi.spyOn(projects.database, "transaction").mockImplementation(async (callback) => {
			if (!intercepted) {
				intercepted = true;
				staged();
				await gate;
			}
			return transaction(callback);
		});
		const flight = projects.database.indexFile("release-file", release.id, name, file);
		const rejected = expect(flight).rejects.toThrow("已删除");
		try {
			await barrier;
			await projects.delete(release.projectId);
			resume();
			await rejected;
			expect(await projects.database.fileEntries("release-file", release.id)).toEqual([]);
			expect(await projects.database.get("release", release.id)).toBeUndefined();
		} finally {
			resume();
			spy.mockRestore();
		}
	},
);
it("rejects a staged export after release deletion and repairs historical orphan indexes for GC", async () => {
	const release = await releaseFixture();
	await projects.database.storeBuffer("release-file", release.id, "old.zip", Buffer.from("orphan"));
	const path = await projects.database.filePath("release-file", release.id, "old.zip");
	// Reproduce an index left by an older version whose owning document vanished.
	await projects.database.delete("release", release.id);
	await expect(
		projects.database.storeBuffer("release-file", release.id, "late.zip", Buffer.from("late")),
	).rejects.toThrow("已删除");
	expect((await projects.database.pruneBlobs()).removed).toBe(1);
	expect(await projects.database.fileEntries("release-file", release.id)).toEqual([]);
	await expect(stat(path!)).rejects.toMatchObject({ code: "ENOENT" });
});
it.each(["rename", "content", "delete"])(
	"distinguishes queued release display rename from %s changes",
	async (change) => {
		const release = await releaseFixture();
		const policy = sandboxPolicy({});
		const scheduler = new ExecutionScheduler(1, policy);
		const unblock = await scheduler.acquire("other", "blocker", new AbortController().signal);
		const queue = new TaskQueue(projects, new ContestStore(projects), {
			scheduler,
			policy,
			userId: "alice",
			enabled: async () => true,
		});
		queues.push(queue);
		await queue.ready;
		const run = vi
			.spyOn(projects.releases, "exportDomjudge")
			.mockResolvedValue({ path: "unused", size: 0, name: "export.zip" });
		try {
			const task = await queue.submit("release-export", release.id, "domjudge");
			await expect(projects.delete(release.projectId)).rejects.toMatchObject({ statusCode: 409 });
			if (change === "rename") await projects.releases.rename(release.id, "v2");
			else if (change === "content")
				await projects.database.put("release", release.id, { ...release, projectHash: "changed" });
			else await projects.database.delete("release", release.id);
			unblock();
			const state = change === "rename" ? "succeeded" : change === "content" ? "stale" : "failed";
			await vi.waitFor(async () => expect((await queue.get(task.id)).state).toBe(state), { timeout: 4000 });
			await queue.idle();
			expect(run).toHaveBeenCalledTimes(change === "rename" ? 1 : 0);
			if (change === "rename") {
				await projects.delete(release.projectId);
				expect(await projects.database.get("release", release.id)).toBeUndefined();
			}
		} finally {
			unblock();
		}
	},
);

it.each(["fps", "qduoj"] as const)(
	"validates resolved attachments while allowing ordinary protocol examples in %s exports",
	async (format) => {
		const release = await releaseFixture();
		const project = await projects.get(release.projectId);
		const directory = join(root, release.id);
		await mkdir(join(directory, "source"), { recursive: true });
		const data = join(directory, "hydro", release.slug, "testdata");
		await mkdir(data, { recursive: true });
		await writeFile(join(data, "1.in"), "1");
		await writeFile(join(data, "1.out"), "1");
		await writeFile(
			join(directory, "source", "manifest.json"),
			JSON.stringify({ cases: [{ inputFile: "1.in", outputFile: "1.out" }] }),
		);
		for (const statement of [
			"protocol file://diagram.svg",
			"`file://diagram.svg`",
			"```\nfile://diagram.svg\n```",
			"[unused]: file://diagram.svg",
		]) {
			await writeFile(
				join(directory, "source", "project.json"),
				JSON.stringify({
					...project,
					statement,
					statementSections: { description: statement, input: "", output: "", interaction: "", notes: "" },
				}),
			);
			expect((await stat(await writeLegacyProblemExport(directory, release, format))).size).toBeGreaterThan(0);
		}
		for (const statement of [
			"![image](file&#58;//diagram.svg)",
			"[download][attachment]\n\n> [attachment]: file://diagram.svg",
			"![image][attachment]\n\n[attachment]: file://diagram.svg\n[attachment]: https://example.com/image.svg",
		]) {
			await writeFile(
				join(directory, "source", "project.json"),
				JSON.stringify({
					...project,
					statement,
					statementSections: { description: statement, input: "", output: "", interaction: "", notes: "" },
				}),
			);
			await expect(writeLegacyProblemExport(directory, release, format)).rejects.toThrow("附件引用");
		}
	},
);
