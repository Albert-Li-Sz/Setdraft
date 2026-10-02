import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { validateGeneratedModelData } from "../scripts/model-data.ts";
import { normalizeModelCost } from "../scripts/model-pricing.ts";
import { calculateCost } from "../src/models.ts";
import type { Api, Model, Usage } from "../src/types.ts";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const usage = (): Usage => ({
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { ...zero, total: 0 },
});

it("regenerates every dynamic OpenRouter alias as unknown while preserving known zero pricing", () => {
	const root = mkdtempSync(join(tmpdir(), "setdraft-pricing-generator-"));
	const source = fileURLToPath(new URL("..", import.meta.url));
	try {
		for (const directory of ["scripts", "src"])
			cpSync(join(source, directory), join(root, directory), { recursive: true });
		writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
		const path = join(root, "src/providers/data/openrouter.json");
		const catalog = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, Model<Api>>>;
		const models = Object.values(catalog).flatMap((group) => Object.values(group));
		const aliases = ["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/fusion"];
		for (const id of aliases) {
			const model = models.find((model) => model.id === id)!;
			model.cost = { ...zero, tiers: [{ ...zero, inputTokensAbove: 50 }] };
		}
		const known = models.find((model) => !aliases.includes(model.id))!;
		known.cost = { ...zero };
		writeFileSync(path, JSON.stringify(catalog));
		execFileSync(
			process.execPath,
			[
				"--import",
				fileURLToPath(new URL("../../../scripts/offline-network.mjs", import.meta.url)),
				join(root, "scripts/generate-models.ts"),
				"--normalize-stored-pricing",
			],
			{ timeout: 30_000, stdio: "pipe" },
		);
		expect(() => validateGeneratedModelData(root)).not.toThrow();
		const generated = JSON.parse(readFileSync(path, "utf8")) as typeof catalog;
		const output = Object.values(generated).flatMap((group) => Object.values(group));
		for (const id of aliases) {
			const model = output.find((model) => model.id === id)!;
			expect(model.cost.unknown, id).toBe(true);
			expect(calculateCost(model, usage())).toMatchObject({ total: 0, unknown: true });
		}
		const free = output.find((model) => model.id === known.id)!;
		expect(free.cost.unknown).toBeUndefined();
		expect(calculateCost(free, usage())).toEqual({ ...zero, total: 0 });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("preserves unknown tier sentinels through normalization and runtime cost calculation", () => {
	const cost = normalizeModelCost({ ...zero, tiers: [{ ...zero, input: -1, inputTokensAbove: 50 }] });
	const model = { cost };
	const current = usage();
	expect(calculateCost(model, current)).toMatchObject({ total: 0, unknown: true });
	current.input = 10;
	expect(calculateCost(model, current)).toEqual({ ...zero, total: 0 });
});
