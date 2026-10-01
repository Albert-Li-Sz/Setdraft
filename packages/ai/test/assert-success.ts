import { expect } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
export function assertStopped(message: AssistantMessage): AssistantMessage {
	expect(message.stopReason, message.errorMessage).toBe("stop");
	return message;
}
