import { expect, it } from "vitest";
import { clampMaxTokensToContext } from "../src/api/simple-options.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

it.each([1024, 2048, 4096, 8192])("preserves useful output under a %i-token context", (contextWindow) => {
	const model = { ...getModel("anthropic", "claude-haiku-4-5"), contextWindow };
	const context = normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] });
	expect(clampMaxTokensToContext(model, context, 512)).toBe(512);
});
