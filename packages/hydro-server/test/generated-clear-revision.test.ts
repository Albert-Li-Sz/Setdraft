import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { IdentityStore } from "../src/identity.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { createHydroServer } from "../src/server.ts";

/** Clearing generated data must validate revision headers before making a destructive change. */
let baseRoot: string;
let identity: IdentityStore;
let projects: ManualProjectStore;
let server: Awaited<ReturnType<typeof createHydroServer>>;
let origin: string;
let cookie: string;
let csrf: string;

beforeEach(async () => {
	baseRoot = await mkdtemp(join(tmpdir(), "setdraft-clear-revision-"));
	identity = new IdentityStore(baseRoot);
	const user = await identity.setup(
		{ setupToken: await identity.rotateSetupToken(), username: "test-admin", password: "a long test password" },
		"test",
	);
	const root = join(baseRoot, "users", user.id);
	projects = new ManualProjectStore({ root });
	const chat = new ChatService({ root, configPath: join(root, "ai-config.json") });
	const session = await identity.createSession(user.id);
	cookie = `setdraft-session=${session.token}`;
	csrf = session.access.csrfToken;
	server = await createHydroServer({ projects, chat, identity, staticRoot: join(root, "web") });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await server.closeWorkspaces();
	identity.close();
	await rm(baseRoot, { recursive: true, force: true });
});

const clearGenerated = (projectId: string, revision: string) =>
	fetch(`${origin}/api/projects/${projectId}/generated`, {
		method: "DELETE",
		headers: { origin, cookie, "x-csrf-token": csrf, "x-expected-revision": revision },
	});

it("rejects a stale expected revision on clear-generated, so the concurrency check is real", async () => {
	const project = await projects.create("acm");
	await projects.update(project.id, { title: "changed" });
	expect((await projects.load(project.id)).revision).toBe(1);
	expect((await clearGenerated(project.id, "0")).status).toBe(409);
});

it.each(["not-a-number", "-1", "1.5", "01", "1e0", "9007199254740992"])(
	"rejects malformed x-expected-revision %s without changing the project",
	async (revision) => {
		const project = await projects.create("acm");
		expect((await clearGenerated(project.id, revision)).status).toBe(422);
		expect((await projects.load(project.id)).revision).toBe(project.revision);
	},
);

it("accepts the current expected revision when clearing generated data", async () => {
	const project = await projects.create("acm");
	expect((await clearGenerated(project.id, String(project.revision))).status).toBe(200);
});
