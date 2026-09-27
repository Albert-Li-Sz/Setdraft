import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";
import { IdentityStore } from "../src/identity.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { WorkspaceRegistry } from "../src/workspace-registry.ts";

it("imports legacy AI once and keeps legacy ownership after changing administrator roles", async () => {
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
		const legacy = await projects.create("acm");
		await chat.configure({
			name: "Legacy team model",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "fake-legacy-secret",
		});
		const admin = await identity.setup(
			{ setupToken: identity.rotateSetupToken(), username: "old-admin", password: "legacy admin password" },
			"local",
		);
		await registry.start();
		expect(registry.configuration.getConfiguration().profiles[0].name).toBe("Legacy team model");
		expect(JSON.stringify(registry.configuration.getConfiguration())).not.toContain("fake-legacy-secret");
		const next = await identity.createUser(admin.id, { username: "new-admin", role: "admin" });
		await identity.changePassword(next.user.id, {
			currentPassword: next.temporaryPassword,
			password: "new admin password",
		});
		identity.updateUser(next.user.id, admin.id, { role: "user" });
		expect(identity.legacyOwnerId).toBe(admin.id);
		expect((await registry.get(identity.getUser(admin.id)).projects.get(legacy.id)).id).toBe(legacy.id);
		await expect(registry.get(identity.getUser(next.user.id)).projects.get(legacy.id)).rejects.toMatchObject({
			statusCode: 404,
		});
		await registry.configuration.clearConfiguration();
		expect(projects.database.get("ai-config", "default")).toBeDefined();
		await registry.close();
		registry = new WorkspaceRegistry(identity, projects, chat);
		await registry.start();
		expect(registry.configuration.getConfiguration().profiles).toEqual([]);
	} finally {
		await registry.close();
		identity.close();
		projects.database.db.close();
		await rm(root, { recursive: true, force: true });
	}
});
