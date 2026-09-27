import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { copyText, createClientId } from "../src/browser-capabilities.ts";

afterEach(() => vi.unstubAllGlobals());

it("creates valid independent request IDs on HTTP without crypto.randomUUID", () => {
	vi.stubGlobal("crypto", { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
	const values = Array.from({ length: 100 }, () => createClientId());
	expect(new Set(values).size).toBe(100);
	for (const value of values)
		expect(value).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

it("uses the async clipboard on HTTPS and preserves source whitespace", async () => {
	const writeText = vi.fn().mockResolvedValue(undefined);
	vi.stubGlobal("navigator", { clipboard: { writeText } });
	await copyText("  code\n\n");
	expect(writeText).toHaveBeenCalledWith("  code\n\n");
});

it.each([true, false])(
	"uses HTTP clipboard fallback and restores focus even if copying returns %s",
	async (success) => {
		class Element {
			focus = vi.fn();
		}
		const active = new Element();
		const textarea = {
			value: "",
			readOnly: false,
			tabIndex: 0,
			style: { cssText: "" },
			focus: vi.fn(),
			select: vi.fn(),
			remove: vi.fn(),
		};
		const execCommand = vi.fn(() => success);
		vi.stubGlobal("HTMLElement", Element);
		vi.stubGlobal("navigator", {});
		vi.stubGlobal("document", {
			activeElement: active,
			getSelection: () => null,
			createElement: () => textarea,
			body: { append: vi.fn() },
			execCommand,
		});
		const copy = copyText("  code\n\n");
		if (success) await expect(copy).resolves.toBeUndefined();
		else await expect(copy).rejects.toThrow("Clipboard copy failed");
		expect(textarea.value).toBe("  code\n\n");
		expect(execCommand).toHaveBeenCalledWith("copy");
		expect(textarea.remove).toHaveBeenCalledOnce();
		expect(active.focus).toHaveBeenCalledWith({ preventScroll: true });
	},
);
