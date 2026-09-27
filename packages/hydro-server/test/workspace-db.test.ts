import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-workspace-db-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("PostgreSQL immutable blob storage", () => {
	it("keeps reused and newly written blobs intact while another connection prunes", async () => {
		const writer = new WorkspaceDatabase(root);
		const cleaner = new WorkspaceDatabase(root);
		try {
			for (let index = 0; index < 10; index++) {
				const bytes = Buffer.from(`concurrent blob ${index}`);
				await writer.storeBuffer("chat-image", "old", "image", bytes);
				await writer.removeOwnerFiles("chat-image", "old");
				await Promise.all([
					cleaner.pruneBlobs(),
					writer.storeBuffer("chat-image", "new", "image", bytes),
					writer.storeBuffer("manual", "project", "1.in", Buffer.from(`new ${index}`)),
				]);
				expect(await writer.readBuffer("chat-image", "new", "image")).toEqual(bytes);
				expect(await writer.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from(`new ${index}`));
			}
		} finally {
			writer.sql.close();
			cleaner.sql.close();
		}
	});

	it("rolls back a batch of file references with a conflicting document revision", async () => {
		const database = new WorkspaceDatabase(root);
		try {
			await database.put("project", "project", { revision: 1 }, -1);
			await database.storeBuffer("manual", "project", "1.in", Buffer.from("old"));
			await expect(
				database.commitFiles(
					[
						{ ownerKind: "manual", ownerId: "project", name: "1.in", source: { bytes: Buffer.from("new") } },
						{ ownerKind: "manual", ownerId: "project", name: "1.out", source: { bytes: Buffer.from("answer") } },
					],
					async () => await database.put("project", "project", { revision: 2 }, 9),
				),
			).rejects.toThrow("VERSION_CONFLICT");
			expect(await database.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from("old"));
			expect(await database.filePath("manual", "project", "1.out")).toBeUndefined();
			expect(await database.get("project", "project")).toEqual({ revision: 1 });
			await database.pruneBlobs();
			expect(await database.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from("old"));
		} finally {
			database.sql.close();
		}
	});

	it("applies version comparisons atomically and prunes only unreferenced blobs", async () => {
		const database = new WorkspaceDatabase(root);
		const id = randomUUID();
		await database.put("project", id, { title: "first" }, -1);
		await expect(database.put("project", id, { title: "duplicate" }, -1)).rejects.toThrow("VERSION_CONFLICT");
		await database.put("project", id, { title: "second" }, 0);
		await expect(database.put("project", id, { title: "stale" }, 0)).rejects.toThrow("VERSION_CONFLICT");
		expect(await database.get("project", id)).toEqual({ title: "second" });

		const bytes = Buffer.from("shared blob");
		await database.storeBuffer("chat-image", "first", "image", bytes);
		await database.storeBuffer("chat-image", "second", "image", bytes);
		const path = await database.filePath("chat-image", "first", "image");
		expect(path).toBeDefined();
		await database.removeOwnerFiles("chat-image", "first");
		expect((await database.pruneBlobs()).removed).toBe(0);
		expect(await readFile(path!)).toEqual(bytes);
		await database.removeOwnerFiles("chat-image", "second");
		expect((await database.pruneBlobs()).removed).toBe(1);
		await expect(readFile(path!)).rejects.toThrow();
		database.sql.close();
	});
});
