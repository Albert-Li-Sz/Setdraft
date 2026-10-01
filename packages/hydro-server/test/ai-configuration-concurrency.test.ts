import { expect, it } from "vitest";
import { AiConfigurationStore, type StoredCatalog } from "../src/ai-configuration.ts";

it("serializes profile mutations and does not expose failed writes", async () => {
	let stored: StoredCatalog = { version: 2, profiles: [] };
	let reject = false;
	const store = new AiConfigurationStore(
		{
			read: () => stored,
			write: async (value) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				if (reject) throw new Error("storage unavailable");
				stored = value;
			},
		},
		"/unused",
	);
	const profile = {
		provider: "openai-completions",
		modelId: "faux",
		apiKey: "test",
		contextWindow: 8192,
		maxTokens: 1024,
	};
	await Promise.all([store.configure({ ...profile, name: "A" }), store.configure({ ...profile, name: "B" })]);
	expect(store.getConfiguration().profiles.map((item) => item.name)).toEqual(["A", "B"]);
	const [a, b] = store.getConfiguration().profiles;
	await Promise.all([store.setDefaultProfile(b.id), store.configure({ ...profile, id: a.id, name: "A revised" })]);
	expect(stored.defaultProfileId).toBe(b.id);
	expect(stored.profiles[0].name).toBe("A revised");
	reject = true;
	await expect(store.clearConfiguration()).rejects.toThrow("storage unavailable");
	expect(store.getConfiguration().profiles).toHaveLength(2);
});
