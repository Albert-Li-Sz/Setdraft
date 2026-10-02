import { BedrockRuntimeClient, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { streamSimple as bedrockSimple, stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

afterEach(() => vi.restoreAllMocks());
const caps = [995, 1024, 1025, 1536, 2047, 2048, 4096];
type Thinking = { type: string; budget_tokens?: number };

function assertBudget(thinking: Thinking | undefined, cap: number) {
	if (cap < 2048) {
		expect(thinking?.type).toBe("disabled");
	} else {
		expect(thinking?.type).toBe("enabled");
		expect(thinking?.budget_tokens).toBeGreaterThanOrEqual(1024);
		expect(cap - Number(thinking?.budget_tokens)).toBeGreaterThanOrEqual(1024);
	}
}

it.each(caps)("clamps direct Anthropic thinking within a %i token response ceiling", async (cap) => {
	let body: { max_tokens: number; thinking?: Thinking } | undefined;
	const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return new Response(
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
			{ headers: { "content-type": "text/event-stream" } },
		);
	});
	const result = await anthropicStream(
		getModel("anthropic", "claude-sonnet-4-5"),
		normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] }),
		{ apiKey: "faux", maxTokens: cap, thinkingEnabled: true, thinkingBudgetTokens: 16384, fetch: fetcher },
	).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(body?.max_tokens).toBe(cap);
	assertBudget(body?.thinking, cap);
});

it.each(caps.flatMap((cap) => ["simple", "direct"].map((entry) => ({ cap, entry }))))(
	"clamps Bedrock $entry thinking after a $cap token limit",
	async ({ cap, entry }) => {
		const send = vi.spyOn(BedrockRuntimeClient.prototype, "send").mockImplementation(async () => ({
			$metadata: { httpStatusCode: 200 },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield { messageStop: { stopReason: "end_turn" } };
			})(),
		}));
		const model = {
			...getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0"),
			contextWindow: 8192,
		};
		const context = normalizeContext({
			messages: [{ role: "user", content: "x".repeat((8192 - 410 - cap) * 4), timestamp: 1 }],
		});
		const stream = entry === "simple" ? bedrockSimple : bedrockStream;
		const result = await stream(model, context, {
			maxTokens: cap,
			reasoning: "high",
			env: { AWS_BEDROCK_SKIP_AUTH: "1" },
			cacheRetention: "none",
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(send).toHaveBeenCalledTimes(1);
		const command = send.mock.calls[0][0];
		expect(command).toBeInstanceOf(ConverseStreamCommand);
		const payload = (command as ConverseStreamCommand).input;
		expect(payload.modelId).toBe(model.id);
		expect(payload.inferenceConfig?.maxTokens).toBe(cap);
		assertBudget((payload.additionalModelRequestFields as { thinking?: Thinking } | undefined)?.thinking, cap);
	},
);
