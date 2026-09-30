import { expect, it } from "vitest";
import { extractAttachmentReferences } from "../src/validation.ts";

it.each([
	"![figure](file://diagram.svg)",
	"![figure](file&#58;//diagram.svg)",
	"![figure][fig]\n\n> [fig]: file://diagram.svg\n\n[fig]: file://other.svg",
	"[download][fig]\n\n- [fig]: file://diagram.svg",
])("extracts actual resolved attachment destinations: %s", (text) => {
	expect(extractAttachmentReferences(text)).toEqual(["diagram.svg"]);
});
it.each([
	"file://",
	"protocol file://diagram.svg",
	"`file://diagram.svg`",
	"```\nfile://diagram.svg\n```",
	"[unused]: file://diagram.svg",
])("ignores non-link protocol text: %s", (text) => {
	expect(extractAttachmentReferences(text)).toEqual([]);
});
