import { expect, it } from "vitest";
import { readCommunicationEnvelope } from "../src/communication-adapter.ts";

it("accepts binary handoff and second-round input larger than 1 MiB within the file budget", () => {
	const original = Buffer.alloc(3_774_874, 120);
	const handoff = Buffer.alloc(3_774_874, 0);
	const secondInput = Buffer.alloc(3_774_874, 255);
	const envelope = Buffer.concat([
		Buffer.from(`SETDRAFT_COMMUNICATION_2 ${original.length} ${handoff.length} ${secondInput.length}\n`),
		original,
		handoff,
		secondInput,
	]);
	const decoded = readCommunicationEnvelope(envelope, envelope.length);
	expect(decoded.original.equals(original)).toBe(true);
	expect(decoded.handoff.equals(handoff)).toBe(true);
	expect(decoded.secondInput.equals(secondInput)).toBe(true);
	expect(() => readCommunicationEnvelope(envelope, envelope.length - 1)).toThrow("容量");
});
