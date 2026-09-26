import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-workspace-db-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("workspace SQLite migration", () => {
	it("upgrades an unversioned SQLite workspace once without dropping task history", () => {
		const legacy = new DatabaseSync(join(root, "workspace.sqlite"));
		legacy.exec(`CREATE TABLE tasks (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource TEXT NOT NULL, format TEXT,
			state TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			result TEXT, error TEXT, owner_pid INTEGER
		); INSERT INTO tasks (id,kind,resource,state,fingerprint,created_at,updated_at) VALUES ('old','generate','project:old','succeeded','hash','','');`);
		legacy.close();
		for (let pass = 0; pass < 2; pass++) {
			const database = new WorkspaceDatabase(root);
			try {
				expect(database.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
				expect(database.db.prepare("SELECT state,cancel_requested FROM tasks WHERE id='old'").get()).toMatchObject({
					state: "succeeded",
					cancel_requested: 0,
				});
			} finally {
				database.db.close();
			}
		}
	});

	it("keeps reused and newly written blobs intact while another connection prunes", async () => {
		const writer = new WorkspaceDatabase(root);
		const cleaner = new WorkspaceDatabase(root);
		try {
			for (let index = 0; index < 10; index++) {
				const bytes = Buffer.from(`concurrent blob ${index}`);
				await writer.storeBuffer("chat-image", "old", "image", bytes);
				writer.removeOwnerFiles("chat-image", "old");
				await Promise.all([
					cleaner.pruneBlobs(),
					writer.storeBuffer("chat-image", "new", "image", bytes),
					writer.storeBuffer("manual", "project", "1.in", Buffer.from(`new ${index}`)),
				]);
				expect(await writer.readBuffer("chat-image", "new", "image")).toEqual(bytes);
				expect(await writer.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from(`new ${index}`));
			}
		} finally {
			writer.db.close();
			cleaner.db.close();
		}
	});

	it("rolls back a batch of file references with a conflicting document revision", async () => {
		const database = new WorkspaceDatabase(root);
		try {
			database.put("project", "project", { revision: 1 }, -1);
			await database.storeBuffer("manual", "project", "1.in", Buffer.from("old"));
			await expect(
				database.commitFiles(
					[
						{ ownerKind: "manual", ownerId: "project", name: "1.in", source: { bytes: Buffer.from("new") } },
						{ ownerKind: "manual", ownerId: "project", name: "1.out", source: { bytes: Buffer.from("answer") } },
					],
					() => database.put("project", "project", { revision: 2 }, 9),
				),
			).rejects.toThrow("VERSION_CONFLICT");
			expect(await database.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from("old"));
			expect(database.filePath("manual", "project", "1.out")).toBeUndefined();
			expect(database.get("project", "project")).toEqual({ revision: 1 });
			await database.pruneBlobs();
			expect(await database.readBuffer("manual", "project", "1.in")).toEqual(Buffer.from("old"));
		} finally {
			database.db.close();
		}
	});

	it("migrates legacy documents and file hashes once while preserving IDs", async () => {
		const projectId = randomUUID();
		const releaseId = randomUUID();
		const chatId = randomUUID();
		await mkdir(join(root, "projects", projectId, "manual"), { recursive: true });
		await mkdir(join(root, "releases", releaseId), { recursive: true });
		await mkdir(join(root, "chats", chatId), { recursive: true });
		await writeFile(
			join(root, "projects", projectId, "project.json"),
			JSON.stringify({ id: projectId, revision: 7, title: "迁移题目" }),
		);
		await writeFile(join(root, "projects", projectId, "manual", "1.in"), "1 2\n");
		await writeFile(join(root, "releases", releaseId, "release.json"), JSON.stringify({ id: releaseId }));
		await writeFile(join(root, "releases", releaseId, "hydro.zip"), "test archive");
		await writeFile(join(root, "chats", `${chatId}.json`), JSON.stringify({ id: chatId, messages: [] }));
		await writeFile(join(root, "chats", chatId, "image-id"), "image bytes");

		const database = new WorkspaceDatabase(root);
		expect(database.migrationError).toBeUndefined();
		expect(database.get<{ title: string }>("project", projectId)?.title).toBe("迁移题目");
		expect(database.list("release")).toHaveLength(1);
		expect(database.list("chat")).toHaveLength(1);
		expect(await database.readBuffer("manual", projectId, "1.in")).toEqual(Buffer.from("1 2\n"));
		expect(await database.readBuffer("release-file", releaseId, "hydro.zip")).toEqual(Buffer.from("test archive"));
		expect(await database.readBuffer("chat-image", chatId, "image-id")).toEqual(Buffer.from("image bytes"));
		const hash = database.fileEntries("manual", projectId)[0].hash;
		expect(await readFile(join(root, "blobs", hash.slice(0, 2), hash))).toEqual(Buffer.from("1 2\n"));
		database.db.close();

		const restarted = new WorkspaceDatabase(root);
		expect(restarted.list("project")).toHaveLength(1);
		expect(restarted.fileEntries("manual", projectId)).toHaveLength(1);
		expect(restarted.db.prepare("SELECT value FROM metadata WHERE key='legacy-migrated'").get()).toMatchObject({
			value: "1",
		});
		restarted.db.close();
	});

	it("rolls back a failed migration and retries after the source is repaired", async () => {
		const goodId = randomUUID();
		const badId = randomUUID();
		await mkdir(join(root, "projects", goodId), { recursive: true });
		await mkdir(join(root, "projects", badId), { recursive: true });
		await writeFile(join(root, "projects", goodId, "project.json"), JSON.stringify({ id: goodId }));
		await writeFile(join(root, "projects", badId, "project.json"), "{broken");
		const failed = new WorkspaceDatabase(root);
		expect(failed.migrationError).toBeDefined();
		expect(failed.db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toMatchObject({ count: 0 });
		expect(failed.get<{ id: string }>("project", goodId)?.id).toBe(goodId);
		expect(() => failed.put("project", randomUUID(), {})).toThrow("只读");
		failed.db.close();

		await writeFile(join(root, "projects", badId, "project.json"), JSON.stringify({ id: badId }));
		const repaired = new WorkspaceDatabase(root);
		expect(repaired.migrationError).toBeUndefined();
		expect(repaired.list("project")).toHaveLength(2);
		repaired.db.close();
	});

	it("reads legacy files while migration is read-only, including a missing blob", async () => {
		const projectId = randomUUID();
		await mkdir(join(root, "projects", projectId, "manual"), { recursive: true });
		await writeFile(join(root, "projects", projectId, "project.json"), "{broken");
		await writeFile(join(root, "projects", projectId, "manual", "1.in"), "legacy input\n");

		const database = new WorkspaceDatabase(root);
		expect(database.migrationError).toBeDefined();
		expect(await database.readBuffer("manual", projectId, "1.in")).toEqual(Buffer.from("legacy input\n"));
		database.db
			.prepare("INSERT INTO files (owner_kind,owner_id,name,hash,size) VALUES (?,?,?,?,?)")
			.run("manual", projectId, "1.in", "0".repeat(64), 13);
		expect(await database.readBuffer("manual", projectId, "1.in")).toEqual(Buffer.from("legacy input\n"));
		database.db.close();
	});

	it("applies version comparisons atomically and prunes only unreferenced blobs", async () => {
		const database = new WorkspaceDatabase(root);
		const id = randomUUID();
		database.put("project", id, { title: "first" }, -1);
		expect(() => database.put("project", id, { title: "duplicate" }, -1)).toThrow("VERSION_CONFLICT");
		database.put("project", id, { title: "second" }, 0);
		expect(() => database.put("project", id, { title: "stale" }, 0)).toThrow("VERSION_CONFLICT");
		expect(database.get("project", id)).toEqual({ title: "second" });

		const bytes = Buffer.from("shared blob");
		await database.storeBuffer("chat-image", "first", "image", bytes);
		await database.storeBuffer("chat-image", "second", "image", bytes);
		const path = database.filePath("chat-image", "first", "image");
		expect(path).toBeDefined();
		database.removeOwnerFiles("chat-image", "first");
		expect((await database.pruneBlobs()).removed).toBe(0);
		expect(await readFile(path!)).toEqual(bytes);
		database.removeOwnerFiles("chat-image", "second");
		expect((await database.pruneBlobs()).removed).toBe(1);
		await expect(readFile(path!)).rejects.toThrow();
		database.db.close();
	});
});
