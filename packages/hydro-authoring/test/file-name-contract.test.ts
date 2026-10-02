import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildHydroDirectoryArchive, buildHydroProblemArchive } from "../src/archive.ts";
import { writeHydroDirectoryArchive } from "../src/archive-stream.ts";
import { writeHydroProblemDirectory } from "../src/builder.ts";
import { validateHydroDirectory } from "../src/directory-validator.ts";
import type { HydroProblemSpec } from "../src/types.ts";
import { validateHydroProblemSpec } from "../src/validation.ts";

const base: HydroProblemSpec = {
	slug: "filenames",
	title: "Filenames",
	tags: [],
	language: "en",
	statement: "# Example\n",
	timeLimit: "1s",
	memoryLimit: "256m",
	subtasks: [
		{
			id: 1,
			type: "sum",
			score: 100,
			cases: [{ inputFile: "1.in", input: "1\n", outputFile: "1.out", output: "1\n" }],
		},
	],
};

it.each([
	["1.in", "1.out", true],
	["test-1.in", "answer.ans", true],
	["1-input.txt", "1-output.txt", false],
	["1.IN", "1.out", false],
	["1.in", "1.OUT", false],
	["1.out", "1.in", false],
] as const)(
	"uses the same %s / %s filename contract in every authoring entry",
	async (inputFile, outputFile, valid) => {
		const spec = {
			...base,
			subtasks: [{ ...base.subtasks[0], cases: [{ ...base.subtasks[0].cases[0], inputFile, outputFile }] }],
		};
		expect(validateHydroProblemSpec(spec).valid).toBe(valid);
		if (valid) expect(buildHydroProblemArchive(spec).byteLength).toBeGreaterThan(0);
		else expect(() => buildHydroProblemArchive(spec)).toThrow(/filenames must end with/);
		const root = await mkdtemp(join(tmpdir(), "setdraft-file-contract-"));
		try {
			const directory = await writeHydroProblemDirectory(base, root);
			const config = join(directory, "testdata/config.yaml");
			await writeFile(
				config,
				(await readFile(config, "utf8"))
					.replace("input: 1.in", `input: ${inputFile}`)
					.replace("output: 1.out", `output: ${outputFile}`),
			);
			// Temporary names also cover swapping input and output extensions without losing either fixture.
			await rename(join(directory, "testdata/1.in"), join(directory, "testdata/input.tmp"));
			await rename(join(directory, "testdata/1.out"), join(directory, "testdata/output.tmp"));
			await rename(join(directory, "testdata/input.tmp"), join(directory, "testdata", inputFile));
			await rename(join(directory, "testdata/output.tmp"), join(directory, "testdata", outputFile));
			expect((await validateHydroDirectory(directory)).valid).toBe(valid);
			if (valid) {
				expect((await buildHydroDirectoryArchive(directory)).byteLength).toBeGreaterThan(0);
				await writeHydroDirectoryArchive(directory, join(root, "problem.zip"));
				expect((await readFile(join(root, "problem.zip"))).byteLength).toBeGreaterThan(0);
			} else {
				await expect(buildHydroDirectoryArchive(directory)).rejects.toThrow("validation");
				await expect(writeHydroDirectoryArchive(directory, join(root, "problem.zip"))).rejects.toThrow(
					"validation",
				);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
