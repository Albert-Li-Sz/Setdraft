import { expect, it, vi } from "vitest";
import { SourceImports } from "../src/source-import.ts";

it("ignores source reads after switching project, reauthenticating or starting a newer import", async () => {
	let resolve!: (value: string) => void;
	let scope = { projectId: "A", signal: new AbortController().signal };
	const apply = vi.fn();
	const source = new SourceImports(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
		() => scope,
	);
	for (const change of [
		() => {
			scope = { projectId: "B", signal: new AbortController().signal };
		},
		() => {
			scope = { ...scope, signal: new AbortController().signal };
		},
		() => source.cancel(),
	]) {
		const flight = source.import("reference", new File(["code"], "main.cpp"), apply);
		change();
		resolve("old code");
		await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	}
	const first = source.import("reference", new File(["first"], "first.cpp"), apply);
	const resolveFirst = resolve;
	const second = source.import("reference", new File(["second"], "second.cpp"), apply);
	resolve("new code");
	await second;
	resolveFirst("old code");
	await expect(first).rejects.toMatchObject({ name: "AbortError" });
	expect(apply).toHaveBeenCalledExactlyOnceWith("new code");
});
