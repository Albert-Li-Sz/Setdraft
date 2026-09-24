import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatService } from "../src/chat.ts";

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "hydro-chat-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("AI chat", () => {
	it("stores uploaded images separately and includes them in later model context", async () => {
		const contexts: Context[] = [];
		const service = new ChatService({
			root,
			configPath: join(root, "ai-config.json"),
			client: async ({ context }) => {
				contexts.push(context);
				return "我看到了图片";
			},
		});
		await service.configure({
			provider: "openai-completions",
			modelId: "vision-model",
			apiKey: "secret",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const chat = await service.create();
		const events = { onStart: () => {}, onDelta: () => {} };
		const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
		await service.send(chat.id, "", undefined, events, undefined, undefined, [
			{ name: "pixel.png", mimeType: "image/png", data: png },
		]);
		const saved = await service.get(chat.id);
		expect(saved.title).toBe("图片：pixel.png");
		expect(saved.messages[0].images).toMatchObject([{ name: "pixel.png", mimeType: "image/png" }]);
		expect(JSON.stringify(saved)).not.toContain(png);
		const imageId = saved.messages[0].images![0].id;
		const imagePath = (await service.image(chat.id, imageId)).path;
		expect(await readFile(imagePath)).toEqual(Buffer.from(png, "base64"));
		expect(contexts[0].messages[0]).toMatchObject({ role: "user", content: [{ type: "image", data: png }] });
		await service.send(chat.id, "上一张图片是什么？", undefined, events);
		expect(contexts[1].messages.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
		expect(contexts[1].messages[0]).toMatchObject({ content: [{ type: "image", data: png }] });
		await service.delete(chat.id);
		await expect(readFile(imagePath)).rejects.toThrow();
	});

	it("rejects invalid image formats and sizes before saving a user turn", async () => {
		const service = new ChatService({ root, configPath: join(root, "ai-config.json"), client: async () => "ok" });
		await service.configure({
			provider: "anthropic-messages",
			modelId: "fake",
			apiKey: "key",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const chat = await service.create();
		const events = { onStart: () => {}, onDelta: () => {} };
		for (const images of [
			[{ name: "bad.svg", mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
			[{ name: "bad.png", mimeType: "image/png", data: "bm90IGFuIGltYWdl" }],
			[{ name: "bad.png", mimeType: "image/png", data: "%%%" }],
			Array.from({ length: 5 }, () => ({ name: "a.png", mimeType: "image/png", data: "iVBORw0KGgo=" })),
		]) {
			await expect(service.send(chat.id, "", undefined, events, undefined, undefined, images)).rejects.toThrow();
		}
		expect((await service.get(chat.id)).messages).toEqual([]);
	});

	it("uses faux provider, saves all turns and trims only model context", async () => {
		const contexts: Context[] = [];
		const service = new ChatService({
			root,
			configPath: join(root, "ai-config.json"),
			client: async ({ context, onDelta }) => {
				contexts.push(context);
				onDelta("回复");
				return "a".repeat(1000);
			},
		});
		await service.configure({
			provider: "openai-completions",
			modelId: "fake",
			apiKey: "secret",
			contextWindow: 2048,
			maxTokens: 1024,
		});
		const chat = await service.create();
		const events = { onStart: () => {}, onDelta: () => {} };
		await service.send(chat.id, "x".repeat(1500), undefined, events);
		await service.send(chat.id, "y".repeat(1500), "只读题面", events);
		expect(contexts[0].messages).toHaveLength(1);
		expect(contexts[1].messages).toHaveLength(1);
		expect(contexts[1].messages[0]).toMatchObject({ role: "user", content: expect.stringContaining("只读题面") });
		const saved = await service.get(chat.id);
		expect(saved.messages).toHaveLength(4);
		expect(saved.messages[2].contextSnapshot).toBe("只读题面");
		expect(await readFile(join(root, "ai-config.json"), "utf8")).toContain("secret");
		expect(service.getConfiguration()).not.toHaveProperty("apiKey");
	});

	it("keeps existing AI configuration and deletes only a selected chat", async () => {
		const configPath = join(root, "ai-config.json");
		const service = new ChatService({ root, configPath, client: async () => "ok" });
		await service.configure({
			provider: "anthropic-messages",
			modelId: "fake",
			apiKey: "key",
			contextWindow: 4096,
			maxTokens: 1000,
		});
		const first = await service.create();
		const second = await service.create();
		await service.delete(first.id);
		expect((await service.list()).map((item) => item.id)).toEqual([second.id]);
		const reloaded = new ChatService({ root, configPath, client: async () => "ok" });
		await reloaded.loadConfiguration();
		expect(reloaded.getConfiguration()).toMatchObject({
			configured: true,
			profiles: [expect.objectContaining({ provider: "anthropic-messages" })],
		});
	});

	it("keeps conversation history when switching between saved API/model profiles", async () => {
		const requests: Array<{ model: string; key: string; context: Context }> = [];
		const service = new ChatService({
			root,
			configPath: join(root, "ai-config.json"),
			client: async ({ configuration, context }) => {
				requests.push({ model: configuration.modelId, key: configuration.apiKey, context });
				return configuration.modelId === "model-a" ? "记住了，答案是 42" : "答案是 42";
			},
		});
		const first = await service.configure({
			name: "主模型",
			provider: "openai-completions",
			modelId: "model-a",
			apiKey: "key-a",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const firstId = first.profiles[0].id;
		const second = await service.configure({
			name: "备用模型",
			provider: "anthropic-messages",
			modelId: "model-b",
			apiKey: "key-b",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const secondId = second.profiles[1].id;
		await service.configure({
			id: firstId,
			name: "主模型",
			provider: "openai-completions",
			modelId: "model-a",
			apiKey: "",
			contextWindow: 8192,
			maxTokens: 1024,
		});
		expect(second.defaultProfileId).toBe(firstId);
		expect(second.profiles).toHaveLength(2);
		expect(JSON.stringify(second)).not.toContain("key-a");
		expect(JSON.stringify(second)).not.toContain("key-b");
		const chat = await service.create();
		const events = { onStart: () => {}, onDelta: () => {} };
		await service.send(chat.id, "请记住答案是 42", undefined, events, undefined, firstId);
		await service.send(chat.id, "我刚才说的答案是什么？", undefined, events, undefined, secondId);
		expect(requests.map((item) => item.model)).toEqual(["model-a", "model-b"]);
		expect(requests.map((item) => item.key)).toEqual(["key-a", "key-b"]);
		expect(requests[1].context.messages.map((item) => item.role)).toEqual(["user", "assistant", "user"]);
		expect(requests[1].context.messages[0]).toMatchObject({ content: "请记住答案是 42" });
		expect(requests[1].context.messages[1]).toMatchObject({ model: "model-a" });
		const saved = await service.get(chat.id);
		expect(saved.profileId).toBe(secondId);
		expect(saved.messages[1]).toMatchObject({ modelId: "model-a", profileId: firstId });
		expect(saved.messages[3]).toMatchObject({ modelId: "model-b", profileId: secondId });
		await service.removeProfile(firstId);
		expect((await service.get(chat.id)).messages).toHaveLength(4);
		expect(service.getConfiguration().defaultProfileId).toBe(secondId);
	});

	it("migrates the existing single-model configuration without losing its key", async () => {
		const configPath = join(root, "ai-config.json");
		await writeFile(
			configPath,
			JSON.stringify({
				provider: "openai-responses",
				modelId: "existing-model",
				apiKey: "existing-secret",
				contextWindow: 4096,
				maxTokens: 1024,
			}),
		);
		const service = new ChatService({ root, configPath, client: async () => "ok" });
		await service.loadConfiguration();
		expect(service.getConfiguration()).toMatchObject({
			defaultProfileId: "legacy",
			profiles: [expect.objectContaining({ id: "legacy", modelId: "existing-model" })],
		});
		await service.configure({
			name: "第二模型",
			provider: "anthropic-messages",
			modelId: "second-model",
			apiKey: "second-secret",
			contextWindow: 4096,
			maxTokens: 1024,
		});
		const saved = JSON.parse(await readFile(configPath, "utf8")) as {
			version: number;
			profiles: Array<{ id: string; apiKey: string }>;
		};
		expect(saved.version).toBe(2);
		expect(saved.profiles).toMatchObject([{ id: "legacy", apiKey: "existing-secret" }, { apiKey: "second-secret" }]);
	});
});
