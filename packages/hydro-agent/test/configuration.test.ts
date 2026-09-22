import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { HydroAiConfiguration } from "../src/configuration.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("HydroAiConfiguration", () => {
	it("persists a web-provided Pi model configuration without exposing its API key", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hydro-ai-config-"));
		temporaryDirectories.push(directory);
		const configPath = join(directory, "ai-config.json");
		const modelRuntimeFactory = () =>
			ModelRuntime.create({
				refreshOnCreate: false,
				modelsPath: null,
				authPath: join(directory, "unused-auth.json"),
				allowModelNetwork: false,
			});
		const options = {
			workspaceRoot: join(directory, "workspace"),
			agentDir: join(directory, "agent"),
			skillPath: join(directory, "SKILL.md"),
			configPath,
			modelRuntimeFactory,
		};
		const configuration = await HydroAiConfiguration.create(options);
		expect(configuration.getSnapshot().providers.map((item) => item.id)).toEqual([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
		]);
		expect(configuration.getSnapshot().providers.every((item) => item.models.length === 0)).toBe(true);
		const modelId = "my-custom-model-not-in-any-catalog";

		const saved = await configuration.configure({
			provider: "openai-completions",
			modelId,
			apiKey: "test-api-key",
			baseUrl: "http://127.0.0.1:11434/v1/",
			contextWindow: 200_000,
			maxTokens: 32_768,
		});
		expect(saved).toMatchObject({
			configured: true,
			provider: "openai-completions",
			modelId,
			baseUrl: "http://127.0.0.1:11434/v1",
			contextWindow: 200_000,
			maxTokens: 32_768,
			apiKeyConfigured: true,
		});
		expect(JSON.stringify(saved)).not.toContain("test-api-key");
		expect(configuration.readiness).toEqual({ available: true, models: [`openai-completions/${modelId}`] });

		const persisted = await readFile(configPath, "utf8");
		expect(JSON.parse(persisted)).toEqual({
			provider: "openai-completions",
			modelId,
			apiKey: "test-api-key",
			baseUrl: "http://127.0.0.1:11434/v1",
			contextWindow: 200_000,
			maxTokens: 32_768,
		});
		expect((await stat(configPath)).mode & 0o777).toBe(0o600);

		const restored = await HydroAiConfiguration.create(options);
		expect(restored.getSnapshot()).toMatchObject({
			configured: true,
			provider: "openai-completions",
			modelId,
			contextWindow: 200_000,
			maxTokens: 32_768,
			apiKeyConfigured: true,
		});
		for (const provider of ["openai-responses", "anthropic-messages"]) {
			expect(await restored.configure({ provider, modelId: "arbitrary/model-v2" })).toMatchObject({
				configured: true,
				provider,
				modelId: "arbitrary/model-v2",
				apiKeyConfigured: true,
			});
		}
		await expect(restored.configure({ provider: "unknown-protocol", modelId })).rejects.toThrow("协议");
		await expect(restored.configure({ provider: "openai-completions", modelId: "  " })).rejects.toThrow("模型名称");
		await expect(
			restored.configure({ provider: "openai-completions", modelId, contextWindow: 1_000 }),
		).rejects.toThrow("上下文长度");
		await expect(
			restored.configure({ provider: "openai-completions", modelId, contextWindow: 8_192, maxTokens: 16_384 }),
		).rejects.toThrow("不能超过上下文长度");
		expect(restored.getSnapshot()).toMatchObject({
			configured: true,
			provider: "anthropic-messages",
			modelId: "arbitrary/model-v2",
		});
		// Existing provider configurations migrate without asking the user to re-enter a key.
		const legacyModel = (await modelRuntimeFactory()).getModels("deepseek")[0];
		await writeFile(
			configPath,
			JSON.stringify({
				provider: "deepseek",
				modelId: legacyModel.id,
				apiKey: "legacy-test-key",
				baseUrl: "http://127.0.0.1:11434/v1",
			}),
		);
		const migrated = await HydroAiConfiguration.create(options);
		expect(migrated.getSnapshot()).toMatchObject({
			configured: true,
			provider: "openai-completions",
			modelId: legacyModel.id,
			apiKeyConfigured: true,
			baseUrl: "http://127.0.0.1:11434/v1",
		});
		expect(JSON.stringify(migrated.getSnapshot())).not.toContain("legacy-test-key");
		expect(await restored.clear()).toMatchObject({ configured: false, apiKeyConfigured: false });
		await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("exposes an explicitly enabled environment model under its protocol", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hydro-ai-ambient-"));
		temporaryDirectories.push(directory);
		const runtime = await ModelRuntime.create({
			refreshOnCreate: false,
			allowModelNetwork: false,
			modelsPath: null,
			authPath: join(directory, "auth.json"),
		});
		await runtime.setRuntimeApiKey("deepseek", "ambient-test-key");
		const selected = runtime.getModels("deepseek")[0];
		const configuration = await HydroAiConfiguration.create({
			workspaceRoot: join(directory, "workspace"),
			agentDir: join(directory, "agent"),
			skillPath: join(directory, "SKILL.md"),
			configPath: join(directory, "ai-config.json"),
			modelRuntimeFactory: async () => runtime,
			enableAmbientCredentials: true,
			provider: "deepseek",
			modelId: selected.id,
		});
		expect(configuration.getSnapshot()).toMatchObject({
			configured: true,
			provider: "openai-completions",
			modelId: selected.id,
			baseUrl: selected.baseUrl,
			contextWindow: selected.contextWindow,
			maxTokens: selected.maxTokens,
		});
		expect(JSON.stringify(configuration.getSnapshot())).not.toContain("ambient-test-key");
	});

	it.each([
		{
			protocol: "openai-completions",
			basePath: "/v1",
			endpoint: "/v1/chat/completions",
			outputField: "max_tokens",
		},
		{ protocol: "openai-responses", basePath: "/v1", endpoint: "/v1/responses", outputField: "max_output_tokens" },
		{ protocol: "anthropic-messages", basePath: "", endpoint: "/v1/messages", outputField: "max_tokens" },
	])(
		"sends arbitrary model names using the selected $protocol protocol",
		async ({ protocol, basePath, endpoint, outputField }) => {
			const directory = await mkdtemp(join(tmpdir(), "hydro-ai-protocol-"));
			temporaryDirectories.push(directory);
			const requests: { url?: string; method?: string; headers: IncomingHttpHeaders; body: string }[] = [];
			const server = createServer((request, response) => {
				const chunks: Buffer[] = [];
				request.on("data", (chunk: Buffer) => chunks.push(chunk));
				request.on("end", () => {
					requests.push({
						url: request.url,
						method: request.method,
						headers: request.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
					response.writeHead(400, { "content-type": "application/json" });
					response.end(
						JSON.stringify({ error: { type: "invalid_request_error", message: "local-protocol-test" } }),
					);
				});
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const address = server.address();
				if (address === null || typeof address === "string") throw new Error("Missing test server address");
				const configuration = await HydroAiConfiguration.create({
					workspaceRoot: join(directory, "workspace"),
					agentDir: join(directory, "agent"),
					skillPath: fileURLToPath(
						new URL("../../../.pi/skills/hydro-problem-authoring/SKILL.md", import.meta.url),
					),
					configPath: join(directory, "ai-config.json"),
					modelRuntimeFactory: () =>
						ModelRuntime.create({
							refreshOnCreate: false,
							allowModelNetwork: false,
							modelsPath: null,
							authPath: join(directory, "auth.json"),
						}),
				});
				const modelId = "custom-vendor/arbitrary-model-2026";
				await configuration.configure({
					provider: protocol,
					modelId,
					apiKey: "local-test-key",
					baseUrl: `http://127.0.0.1:${address.port}${basePath}`,
					contextWindow: 65_536,
					maxTokens: 2_048,
				});
				const outcome = await configuration.execute({
					runId: "protocol-request",
					source: "输出 42。",
					signal: AbortSignal.timeout(10000),
					onEvent: () => {},
				});
				expect(outcome.status).toBe("failed");
				expect(outcome.assistantText).toContain("local-protocol-test");
				expect(requests).toHaveLength(1);
				expect(requests[0].method).toBe("POST");
				expect(new URL(requests[0].url ?? "", "http://127.0.0.1").pathname).toBe(endpoint);
				const requestBody = JSON.parse(requests[0].body) as Record<string, unknown>;
				expect(requestBody).toMatchObject({ model: modelId, stream: true, [outputField]: 2_048 });
				if (protocol === "anthropic-messages") expect(requests[0].headers["x-api-key"]).toBe("local-test-key");
				else expect(requests[0].headers.authorization).toBe("Bearer local-test-key");
			} finally {
				server.closeAllConnections();
				await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			}
		},
	);
});
