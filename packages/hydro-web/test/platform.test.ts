import { describe, expect, it } from "vitest";
import { apiUrl, normalizeApiOrigin, pageFromHash, readAiConfiguration } from "../src/platform.ts";

describe("manual authoring navigation", () => {
	it("maps the workspace, AI chat, records and settings", () => {
		expect(pageFromHash("#workspace")).toBe("workspace");
		expect(pageFromHash("#chat")).toBe("chat");
		expect(pageFromHash("#records")).toBe("records");
		expect(pageFromHash("#settings")).toBe("settings");
		expect(pageFromHash("#unknown")).toBe("workspace");
	});

	it("builds same-origin and explicit API URLs", () => {
		expect(apiUrl("", "/projects")).toBe("/api/projects");
		expect(apiUrl("http://127.0.0.1:4321/", "/releases")).toBe("http://127.0.0.1:4321/api/releases");
		expect(normalizeApiOrigin(" https://api.example.com/ ")).toBe("https://api.example.com");
		expect(() => normalizeApiOrigin("https://user:secret@example.com")).toThrow();
	});

	it("accepts protocol metadata without exposing an API key", () => {
		const configuration = readAiConfiguration({
			configured: true,
			defaultProfileId: "profile-1",
			profiles: [
				{
					id: "profile-1",
					name: "主模型",
					provider: "openai-completions",
					modelId: "model-id",
					contextWindow: 128_000,
					maxTokens: 16_384,
					apiKeyConfigured: true,
				},
			],
			providers: [{ id: "openai-completions", name: "OpenAI Chat Completions", models: [] }],
		});
		expect(configuration?.profiles[0].modelId).toBe("model-id");
		expect(readAiConfiguration({ ...configuration, apiKey: "secret" })).toBeUndefined();
		expect(
			readAiConfiguration({ ...configuration, profiles: [{ ...configuration?.profiles[0], apiKey: "secret" }] }),
		).toBeUndefined();
	});
});
