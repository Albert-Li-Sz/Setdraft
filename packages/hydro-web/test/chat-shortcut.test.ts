import { describe, expect, it } from "vitest";
import { shouldSendChatMessage } from "../src/chat-shortcut.ts";

describe("AI chat keyboard shortcut", () => {
	it("sends on Enter and reserves Shift+Enter for a newline", () => {
		expect(shouldSendChatMessage({ key: "Enter", shiftKey: false, isComposing: false, repeat: false })).toBe(true);
		expect(shouldSendChatMessage({ key: "Enter", shiftKey: true, isComposing: false, repeat: false })).toBe(false);
	});

	it("ignores input composition, held keys and unrelated keys", () => {
		for (const event of [
			{ key: "Enter", shiftKey: false, isComposing: true, repeat: false },
			{ key: "Enter", shiftKey: false, isComposing: false, repeat: false, keyCode: 229 },
			{ key: "Enter", shiftKey: false, isComposing: false, repeat: true },
			{ key: "a", shiftKey: false, isComposing: false, repeat: false },
		]) {
			expect(shouldSendChatMessage(event)).toBe(false);
		}
	});
});
