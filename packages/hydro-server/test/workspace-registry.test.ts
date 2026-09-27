import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { IdentityStore } from "../src/identity.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { WorkspaceRegistry } from "../src/workspace-registry.ts";

it("keeps personal ownership after changing administrator roles and persists shared AI settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "setdraft-migration-"));
	const identity = new IdentityStore(root);
	const projects = new ManualProjectStore({ root });
	const chat = new ChatService({
		root,
		database: projects.database,
		configPath: join(root, "ai-config.json"),
		client: async () => "faux",
	});
	let registry = new WorkspaceRegistry(identity, projects, chat);
	try {
		await registry.configuration.configure({
			name: "Legacy team model",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "fake-legacy-secret",
		});
		const admin = await identity.setup(
			{ setupToken: await identity.rotateSetupToken(), username: "old-admin", password: "legacy admin password" },
			"local",
		);
		await registry.start();
		const legacy = await (await registry.get(admin)).projects.create("acm");
		expect(registry.configuration.getConfiguration().profiles[0].name).toBe("Legacy team model");
		expect(JSON.stringify(registry.configuration.getConfiguration())).not.toContain("fake-legacy-secret");
		const next = await identity.createUser(admin.id, { username: "new-admin", role: "admin" });
		await identity.changePassword(next.user.id, {
			currentPassword: next.temporaryPassword,
			password: "new admin password",
		});
		await identity.updateUser(next.user.id, admin.id, { role: "user" });

		expect((await (await registry.get(await identity.getUser(admin.id))).projects.get(legacy.id)).id).toBe(legacy.id);
		await expect(
			(await registry.get(await identity.getUser(next.user.id))).projects.get(legacy.id),
		).rejects.toMatchObject({
			statusCode: 404,
		});
		await registry.configuration.clearConfiguration();
		expect(await identity.getSetting("ai-config")).toBeDefined();
		await registry.close();
		registry = new WorkspaceRegistry(identity, projects, chat);
		await registry.start();
		expect(registry.configuration.getConfiguration().profiles).toEqual([]);
	} finally {
		await registry.close();
		identity.close();
		projects.database.sql.close();
		await rm(root, { recursive: true, force: true });
	}
});
