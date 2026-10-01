import { describe, expect, it } from "vitest";
import { complete, getModel } from "../src/compat.ts";
import type { Context } from "../src/types.ts";
import { resolveApiKey } from "./oauth.ts";

const codexToken = await resolveApiKey("openai-codex");

describe("openai-codex cache affinity e2e", () => {
	it.skipIf(!codexToken)("handles SSE requests with aligned cache-affinity identifiers", async () => {
		const model = getModel("openai-codex", "gpt-5.5");
		const sessionId = "0195d6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
		const context: Context = {
			systemPrompt: "You are a helpful assistant. Reply exactly as requested.",
			messages: [
				{
					role: "user",
					content: "Reply with exactly: cache affinity e2e success",
					timestamp: Date.now(),
				},
			],
		};

		let capturedHeaders: Headers | undefined;
		let capturedPayload: Record<string, unknown> | undefined;
		let requests = 0;
		const response = await complete(model, context, {
			apiKey: codexToken,
			sessionId,
			transport: "sse",
			onPayload: (payload) => {
				capturedPayload = payload as Record<string, unknown>;
			},
			fetch: async (input, init) => {
				requests++;
				capturedHeaders = new Headers(input instanceof Request ? input.headers : init?.headers);
				return fetch(input, init);
			},
		});

		expect(model.api).toBe("openai-codex-responses");
		expect(model.provider).toBe("openai-codex");
		expect(requests).toBe(1);
		expect(capturedPayload?.prompt_cache_key).toBe(sessionId);
		expect(capturedHeaders?.get("session-id")).toBe(sessionId);
		expect(capturedHeaders?.get("x-client-request-id")).toBe(sessionId);
		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(response.errorMessage).toBeUndefined();
		expect(response.content.map((block) => (block.type === "text" ? block.text : "")).join("")).toContain(
			"cache affinity e2e success",
		);
	});
});
