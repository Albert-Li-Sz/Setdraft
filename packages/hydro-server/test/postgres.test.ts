import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { IdentityStore } from "../src/identity.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-pg-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
it("creates exactly one administrator and protects final administrator under concurrency", async () => {
	const identity = new IdentityStore(root);
	const setupToken = await identity.rotateSetupToken();
	const attempts = await Promise.allSettled(
		["alpha", "bravo"].map(
			async (username) =>
				await identity.setup({ username, password: "correct horse battery staple", setupToken }, "local"),
		),
	);
	expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const users = await identity.listUsers();
	expect(users).toHaveLength(1);
	await expect(identity.updateUser(users[0].id, users[0].id, { enabled: false })).rejects.toThrow("至少一名");
	const session = await identity.createSession(users[0].id);
	expect((await identity.session(session.token))?.user.id).toBe(users[0].id);
	await identity.logout(session.access);
	expect(await identity.session(session.token)).toBeUndefined();
});
it("enforces RLS even for raw queries and rejects foreign owner writes", async () => {
	const a = new WorkspaceDatabase(join(root, "a"), randomUUID()),
		b = new WorkspaceDatabase(join(root, "b"), randomUUID());
	await a.put("project", "shared", { title: "A" }, -1);
	await b.put("project", "shared", { title: "B" }, -1);
	expect(await a.get("project", "shared")).toEqual({ title: "A" });
	expect(await b.sql.all("SELECT body FROM documents")).toEqual([{ body: { title: "B" } }]);
	await expect(
		b.sql.execute("INSERT INTO documents(account_id,kind,id,body) VALUES($1,'project','foreign','{}')", [
			a.sql.accountId,
		]),
	).rejects.toMatchObject({ code: "42501" });
	await a.delete("project", "shared");
	expect(await b.get("project", "shared")).toEqual({ title: "B" });
});
it("rolls back files and documents together and performs compare-and-swap updates", async () => {
	const db = new WorkspaceDatabase(root, randomUUID());
	await db.put("project", "p", { revision: 0 }, -1);
	await db.storeBuffer("manual", "p", "1.in", Buffer.from("old"));
	await expect(
		db.commitFiles(
			[{ ownerKind: "manual", ownerId: "p", name: "1.in", source: { bytes: Buffer.from("new") } }],
			async () => {
				await db.put("project", "p", { revision: 1 }, 99);
			},
		),
	).rejects.toThrow("VERSION_CONFLICT");
	expect((await db.readBuffer("manual", "p", "1.in")).toString()).toBe("old");
	const updates = await Promise.allSettled(
		[1, 2].map(async (revision) => await db.put("project", "p", { revision }, 0)),
	);
	expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
});
it("creates, updates, uploads, renumbers and deletes a problem on PostgreSQL", async () => {
	const projects = new ManualProjectStore({ root });
	const p = await projects.create("acm");
	const updated = await projects.update(p.id, { title: "PostgreSQL problem", expectedRevision: p.revision });
	const withCase = await projects.addTextCase(p.id, {
		input: "1 2\n",
		output: "3\n",
		name: "4.in",
		expectedRevision: updated.revision,
	});
	const renumbered = await projects.renumberCases(p.id, withCase.project.revision);
	expect(renumbered.cases[0].inputFile).toBe("1.in");
	expect((await projects.casePreview(p.id, "manual", "1")).input).toBe("1 2\n");
	await projects.delete(p.id);
	expect(await projects.list()).toEqual([]);
});
it("grants only one in-process project lock across asynchronous task lookups", async () => {
	const projects = new ManualProjectStore({ root });
	const p = await projects.create("acm");
	const attempts = await Promise.allSettled([projects.lock(p.id), projects.lock(p.id)]);
	expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	for (const result of attempts) if (result.status === "fulfilled") result.value();
	const release = await projects.lock(p.id);
	release();
});
