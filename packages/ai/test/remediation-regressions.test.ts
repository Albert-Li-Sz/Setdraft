import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeModelCost } from "../scripts/model-pricing.ts";
import { streamSimple as anthropicStream } from "../src/api/anthropic-messages.ts";
import { stream as bedrockStream } from "../src/api/bedrock-converse-stream.ts";
import { stream as codexStream } from "../src/api/openai-codex-responses.ts";
import { streamSimple as responsesSimple, stream as responsesStream } from "../src/api/openai-responses.ts";
import { loadOAuthCredentials, saveOAuthCredentials } from "../src/auth/file-credentials.ts";
import { anthropicOAuth } from "../src/auth/oauth/anthropic.ts";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";
import type { AuthPrompt } from "../src/auth/types.ts";
import { getModel } from "../src/compat.ts";
import { calculateCost, createModels, createProvider } from "../src/models.ts";
import type { Usage } from "../src/types.ts";
import { decodeJwtPayload } from "../src/utils/jwt.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

afterEach(() => vi.unstubAllGlobals());
const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });

it.each([995, 1024, 1536, 2047, 2048])(
	"sends valid Anthropic thinking parameters with a %i token cap",
	async (maxTokens) => {
		let payload: Record<string, unknown> | undefined;
		let calls = 0;
		const result = await anthropicStream(getModel("anthropic", "claude-sonnet-4-5"), context, {
			apiKey: "faux",
			reasoning: "high",
			maxTokens,
			fetch: async (_input, init) => {
				++calls;
				payload = JSON.parse(String(init?.body));
				return new Response(
					'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":0}}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		}).result();
		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(calls).toBe(1);
		expect(payload).toBeDefined();
		const thinking = payload?.thinking as { type: string; budget_tokens?: number } | undefined;
		if (thinking?.type === "enabled") {
			expect(thinking.budget_tokens).toBeGreaterThanOrEqual(1024);
			expect(thinking.budget_tokens).toBeLessThan(Number(payload?.max_tokens));
		} else expect(thinking?.type).toBe("disabled");
	},
);

it("ends a Bedrock stream when proxy initialization fails", async () => {
	const result = await bedrockStream(getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8"), context, {
		env: { HTTPS_PROXY: "invalid://proxy", AWS_BEDROCK_SKIP_AUTH: "1" },
	}).result();
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toBeTruthy();
});

it("decodes unpadded base64url UTF-8 JWT payloads", () => {
	const payload = { name: "用户😀??", "https://api.openai.com/auth": { chatgpt_account_id: "account" } };
	const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
	expect(decodeJwtPayload(`x.${encoded}.y`)).toEqual(payload);
	expect(() => decodeJwtPayload("x.W10.y")).toThrow();
});

it("reads CRLF Codex events fragmented across every byte", async () => {
	const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" }, name: "用户😀" })).toString("base64url")}.y`;
	const events = [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "m", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", delta: "你好" },
		{
			type: "response.completed",
			response: {
				status: "completed",
				output: [{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "你好" }] }],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	const bytes = new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
	const result = await codexStream(getModel("openai-codex", "gpt-5.5"), context, {
		apiKey: token,
		transport: "sse",
		fetch: async () =>
			new Response(
				new ReadableStream({
					start(controller) {
						for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	}).result();
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "你好" }));
});

it.each([anthropicOAuth, openaiCodexOAuth])("cancels an unanswered browser login prompt for $name", async (oauth) => {
	const controller = new AbortController();
	let prompted: (() => void) | undefined;
	let promptSignal: AbortSignal | undefined;
	const ready = new Promise<void>((resolve) => {
		prompted = resolve;
	});
	const fetcher = vi.fn(async () => {
		throw new Error("No token exchange expected");
	});
	vi.stubGlobal("fetch", fetcher);
	const login = oauth.login({
		signal: controller.signal,
		notify: () => {},
		prompt: async (prompt: AuthPrompt) => {
			if (prompt.type === "select") return "browser";
			promptSignal = prompt.signal;
			prompted?.();
			return new Promise<string>(() => {});
		},
	});
	const rejected = expect(login).rejects.toBeDefined();
	await ready;
	controller.abort();
	await rejected;
	expect(promptSignal?.aborted).toBe(true);
	expect(fetcher).not.toHaveBeenCalled();
});

it("does not refill removed model headers in the actual Responses SDK", async () => {
	const model = { ...getModel("openai", "gpt-4o-mini"), headers: { "x-private-default": "private" } };
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "openai",
			models: [model],
			auth: { apiKey: { name: "faux", resolve: async () => ({ auth: { apiKey: "faux" } }) } },
			api: { stream: responsesStream, streamSimple: responsesSimple },
		}),
	);
	let headers: Headers | undefined;
	let calls = 0;
	const result = await models.complete(model, context, {
		transformHeaders: async () => ({}),
		fetch: async (input, init) => {
			calls++;
			headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			return new Response(
				'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(calls).toBe(1);
	expect(headers?.has("x-private-default")).toBe(false);
});

it("marks unknown pricing and never reports negative cost", () => {
	const model = getModel("openrouter", "openrouter/auto");
	const usage: Usage = {
		input: 100,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 120,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	expect(model.cost.unknown).toBe(true);
	expect(calculateCost(model, usage)).toMatchObject({ total: 0, unknown: true });
	expect(calculateCost({ cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }, usage)).toMatchObject({
		total: 0,
		unknown: true,
	});
	expect(normalizeModelCost({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 })).toMatchObject({
		input: 0,
		unknown: true,
	});
	expect(
		calculateCost({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, usage).unknown,
	).toBeUndefined();
});

it("writes OAuth credentials privately and preserves corrupt files and symlink targets", () => {
	const root = mkdtempSync(join(tmpdir(), "oauth-private-"));
	const path = join(root, "auth.json");
	const auth = { p: { type: "oauth" as const, access: "faux", refresh: "faux", expires: 100 } };
	try {
		saveOAuthCredentials(path, auth);
		chmodSync(path, 0o644);
		saveOAuthCredentials(path, auth);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(loadOAuthCredentials(path)).toEqual(auth);
		writeFileSync(path, "bad json");
		expect(() => saveOAuthCredentials(path, auth)).toThrow();
		expect(readFileSync(path, "utf8")).toBe("bad json");
		rmSync(path);
		const target = join(root, "target");
		writeFileSync(target, "protected");
		symlinkSync(target, path);
		expect(() => saveOAuthCredentials(path, auth)).toThrow();
		expect(readFileSync(target, "utf8")).toBe("protected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
