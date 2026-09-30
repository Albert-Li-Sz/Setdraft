import { describe, expect, it } from "vitest";
import { preparePdfMarkdown } from "../src/markdown-typst.ts";

describe("PDF reference definitions", () => {
	it("finds document definitions nested in quotes and lists", () => {
		const images = new Map([["file://figure.svg", "images/figure.svg"]]);
		for (const definition of ["> [figure]: file://figure.svg", "- [figure]: file://figure.svg"])
			expect(preparePdfMarkdown(`![示意图][figure]\n\n${definition}`, images)).toContain(
				"![示意图](images/figure.svg)",
			);
	});
	it("uses the first definition in document order", () => {
		expect(
			preparePdfMarkdown(
				"![图][figure]\n\n> [figure]: file://first.svg\n\n[figure]: file://second.svg",
				new Map([["file://first.svg", "images/first.svg"]]),
			),
		).toContain("![图](images/first.svg)");
	});
});
