import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatService } from "../src/chat.ts";

const model = vi.hoisted(() => ({
	delta: "suffix",
	text: "Initial suffix",
	stopReason: "stop",
	rawStopReason: "stop",
	refusal: undefined as string | undefined,
}));
vi.mock("@earendil-works/pi-ai/compat", () => ({
	streamSimple: () => ({
		async *[Symbol.asyncIterator]() {
			yield { type: "text_delta", delta: model.delta };
		},
		async result() {
			return {
				content: [{ type: "text", text: model.text }],
				stopReason: model.stopReason,
				rawStopReason: model.rawStopReason,
				refusal: model.refusal,
			};
		},
	}),
}));
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-final-body-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
it.each(["stop", "length", "refusal"])("persists the authoritative final body and %s completeness", async (reason) => {
	model.stopReason = reason === "length" ? "length" : "stop";
	model.rawStopReason = reason;
	model.refusal = reason === "refusal" ? "Initial suffix" : undefined;
	const service = new ChatService({ root, configPath: join(root, "config.json") });
	await service.configure({
		provider: "openai-completions",
		modelId: "faux",
		apiKey: "test",
		contextWindow: 8192,
		maxTokens: 1024,
	});
	const conversation = await service.create();
	const deltas: string[] = [];
	const completed = await service.send(conversation.id, "question", undefined, {
		onStart() {},
		onDelta(delta) {
			deltas.push(delta);
		},
	});
	expect(deltas.join("")).toBe("suffix");
	expect(completed.messages.at(-1)).toMatchObject({
		content: "Initial suffix",
		finishReason: reason,
		complete: reason !== "length",
	});
	expect((await service.get(conversation.id)).messages).toEqual(completed.messages);
});
