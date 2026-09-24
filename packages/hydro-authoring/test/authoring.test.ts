import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildHydroDirectoryArchive, buildHydroProblemArchive } from "../src/archive.ts";
import { buildHydroProblemFiles, writeHydroProblemDirectory } from "../src/builder.ts";
import { compareHydroDefaultOutput } from "../src/default-checker.ts";
import { validateHydroDirectory } from "../src/directory-validator.ts";
import type { HydroProblemSpec } from "../src/types.ts";
import { HydroProblemValidationError, validateHydroProblemSpec } from "../src/validation.ts";

const validSpec = {
	slug: "a-plus-b",
	title: "A + B",
	pid: "HPM1000",
	tags: ["入门"],
	language: "zh",
	statement: "# A + B\n\n![加法示意图](file://addition.svg)\n",
	timeLimit: "1s",
	memoryLimit: "256m",
	subtasks: [
		{
			id: 1,
			type: "sum",
			score: 100,
			cases: [
				{ inputFile: "1.in", input: "1 2\n", outputFile: "1.out", output: "3\n" },
				{ inputFile: "2.in", input: "-5 8\n", outputFile: "2.out", output: "3\n" },
			],
		},
	],
	attachments: [{ name: "addition.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>\n' }],
} satisfies HydroProblemSpec;

function readStoredZipEntries(archive: Uint8Array): Map<string, Uint8Array> {
	const bytes = Buffer.from(archive);
	const entries = new Map<string, Uint8Array>();
	let offset = 0;
	while (bytes.readUInt32LE(offset) === 0x04034b50) {
		expect(bytes.readUInt16LE(offset + 8)).toBe(0);
		const size = bytes.readUInt32LE(offset + 18);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const extraLength = bytes.readUInt16LE(offset + 28);
		const nameStart = offset + 30;
		const contentStart = nameStart + nameLength + extraLength;
		entries.set(
			bytes.toString("utf8", nameStart, nameStart + nameLength),
			bytes.subarray(contentStart, contentStart + size),
		);
		offset = contentStart + size;
	}
	return entries;
}

describe("Hydro authoring contract", () => {
	it("matches Hydro default-checker whitespace behavior", () => {
		expect(compareHydroDefaultOutput("1  2\r\n3\t\r\n", "1  2\n3\n\n")).toEqual({ equal: true });
		expect(compareHydroDefaultOutput("1 2\n", "1  2\n")).toEqual({
			equal: false,
			mismatch: { line: 1, expected: "1 2", actual: "1  2" },
		});
		expect(compareHydroDefaultOutput(" value\n", "value\n")).toEqual({
			equal: false,
			mismatch: { line: 1, expected: " value", actual: "value" },
		});
		expect(compareHydroDefaultOutput("1\n2\n", "1 2\n").equal).toBe(false);
	});

	it("materializes a validated problem directory that passes package inspection", async () => {
		const temporaryRoot = await mkdtemp(join(tmpdir(), "hydro-authoring-"));
		try {
			const outputRoot = await writeHydroProblemDirectory(validSpec, temporaryRoot);
			const report = await validateHydroDirectory(outputRoot);
			expect(report).toMatchObject({
				valid: true,
				issues: [],
				stats: { statements: 1, testCases: 2, attachments: 1 },
			});
			expect(await buildHydroDirectoryArchive(outputRoot)).toEqual(buildHydroProblemArchive(validSpec));
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	});

	it("rejects malformed global, subtask and case limits in an existing Hydro directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-bad-limits-"));
		try {
			const directory = await writeHydroProblemDirectory(validSpec, root);
			const path = join(directory, "testdata/config.yaml");
			const config = await readFile(path, "utf8");
			await writeFile(
				path,
				config
					.replace("time: 1s", "time: forever")
					.replace("memory: 256m", "memory: 256")
					.replace("score: 100", "score: 100\n    time: 2\n    memory: unlimited")
					.replace("output: 1.out", "output: 1.out\n        time: bad\n        memory: 0"),
			);
			const report = await validateHydroDirectory(directory);
			expect(report.valid).toBe(false);
			expect(report.issues.filter((issue) => issue.code === "INVALID_LIMIT").map((issue) => issue.path)).toEqual([
				"testdata/config.yaml.time",
				"testdata/config.yaml.memory",
				"testdata/config.yaml.subtasks[0].time",
				"testdata/config.yaml.subtasks[0].memory",
				"testdata/config.yaml.subtasks[0].cases[0].time",
				"testdata/config.yaml.subtasks[0].cases[0].memory",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("packages a testlib SPJ as .cc and rejects a release missing its checker source", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-spj-format-"));
		try {
			const spec: HydroProblemSpec = {
				...validSpec,
				checker: { type: "testlib", source: '#include "testlib.h"\nint main(){}\n' },
			};
			const directory = await writeHydroProblemDirectory(spec, root);
			expect((await validateHydroDirectory(directory)).valid).toBe(true);
			const archive = readStoredZipEntries(await buildHydroDirectoryArchive(directory));
			expect(archive.get("a-plus-b/testdata/config.yaml")?.toString()).toContain("checker: checker.cc");
			expect(archive.get("a-plus-b/testdata/checker.cc")?.toString()).toBe(spec.checker?.source);
			await rm(join(directory, "testdata/checker.cc"));
			expect((await validateHydroDirectory(directory)).issues.some((item) => item.code === "MISSING_CHECKER")).toBe(
				true,
			);
			await expect(buildHydroDirectoryArchive(directory)).rejects.toThrow("validation");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes and validates single/multi-pass interactive configuration", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-interactive-format-"));
		try {
			const spec: HydroProblemSpec = {
				...validSpec,
				type: "interactive",
				multiPass: 2,
				interactor: '#include "testlib.h"\nint main(int argc,char**argv){registerInteraction(argc,argv);}',
			};
			const directory = await writeHydroProblemDirectory(spec, root);
			const report = await validateHydroDirectory(directory);
			expect(report.valid, JSON.stringify(report.issues)).toBe(true);
			const archive = readStoredZipEntries(await buildHydroDirectoryArchive(directory));
			expect(archive.get("a-plus-b/testdata/config.yaml")?.toString()).toContain("multi_pass: 2");
			expect(archive.get("a-plus-b/testdata/interactor.cc")?.toString()).toBe(spec.interactor);
			await rm(join(directory, "testdata/interactor.cc"));
			expect(
				(await validateHydroDirectory(directory)).issues.some((item) => item.code === "MISSING_INTERACTOR"),
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires safe ZIP entry pointers for multi-file answer submissions", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-answer-format-"));
		try {
			const spec: HydroProblemSpec = {
				...validSpec,
				type: "submit_answer",
				answerMode: "multi",
				subtasks: [
					{
						...validSpec.subtasks[0],
						type: "max",
						cases: [
							{ inputFile: "1.in", input: "first.ans\n", outputFile: "1.out", output: "3\n" },
							{ inputFile: "2.in", input: "second.ans\n", outputFile: "2.out", output: "4\n" },
						],
					},
				],
			};
			const directory = await writeHydroProblemDirectory(spec, root);
			expect((await validateHydroDirectory(directory)).valid).toBe(true);
			const archive = readStoredZipEntries(await buildHydroDirectoryArchive(directory));
			expect(archive.get("a-plus-b/testdata/config.yaml")?.toString()).toContain("subType: multi");
			await rm(join(directory, "testdata/2.in"));
			expect((await validateHydroDirectory(directory)).valid).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("builds a deterministic Hydro import archive with one top-level problem directory", () => {
		const first = buildHydroProblemArchive(validSpec);
		const second = buildHydroProblemArchive(validSpec);
		expect(first).toEqual(second);

		const entries = readStoredZipEntries(first);
		expect([...entries.keys()]).toEqual([
			"a-plus-b/additional_file/addition.svg",
			"a-plus-b/problem.yaml",
			"a-plus-b/problem_zh.md",
			"a-plus-b/testdata/1.in",
			"a-plus-b/testdata/1.out",
			"a-plus-b/testdata/2.in",
			"a-plus-b/testdata/2.out",
			"a-plus-b/testdata/config.yaml",
		]);
		expect(entries.get("a-plus-b/problem_zh.md")?.toString()).toContain("file://addition.svg");
	});

	it("rejects ambiguous scoring and missing statement attachments before writing files", () => {
		const invalidSpec: HydroProblemSpec = {
			...validSpec,
			statement: "![missing](file://missing.png)",
			subtasks: [{ ...validSpec.subtasks[0], score: 90 }],
		};
		const report = validateHydroProblemSpec(invalidSpec);
		expect(report.valid).toBe(false);
		expect(report.issues.map((issue) => issue.code)).toEqual(
			expect.arrayContaining(["INVALID_TOTAL_SCORE", "MISSING_ATTACHMENT"]),
		);
		expect(() => buildHydroProblemFiles(invalidSpec)).toThrow(HydroProblemValidationError);
	});

	it("rejects zero-valued limits even when units are present", () => {
		const spec = { ...validSpec, timeLimit: "0.0s", memoryLimit: "0.0m" };
		const report = validateHydroProblemSpec(spec);
		expect(report.issues.filter((issue) => issue.code === "INVALID_LIMIT").map((issue) => issue.path)).toEqual([
			"timeLimit",
			"memoryLimit",
		]);
	});

	it("enforces the target judge's case count and cumulative time on specs and directories", async () => {
		const manyCases: HydroProblemSpec = {
			...validSpec,
			timeLimit: "100ms",
			subtasks: [
				{
					...validSpec.subtasks[0],
					cases: Array.from({ length: 101 }, (_, index) => ({
						inputFile: `${index}.in`,
						input: "",
						outputFile: `${index}.out`,
						output: "0\n",
					})),
				},
			],
		};
		const longCases: HydroProblemSpec = {
			...validSpec,
			subtasks: [
				{
					...validSpec.subtasks[0],
					cases: Array.from({ length: 61 }, (_, index) => ({
						inputFile: `${index}.in`,
						input: "",
						outputFile: `${index}.out`,
						output: "0\n",
					})),
				},
			],
		};
		expect(validateHydroProblemSpec(manyCases).issues.map((issue) => issue.code)).toContain("TOO_MANY_TEST_CASES");
		expect(validateHydroProblemSpec(longCases).issues.map((issue) => issue.code)).toContain(
			"TOTAL_TIME_LIMIT_EXCEEDED",
		);
		expect(validateHydroProblemSpec(manyCases, { maxTestCases: 120, totalTimeLimitMs: 120000 }).valid).toBe(true);
		const root = await mkdtemp(join(tmpdir(), "hydro-profile-"));
		try {
			const directory = await writeHydroProblemDirectory(longCases, root, {
				maxTestCases: 120,
				totalTimeLimitMs: 120000,
			});
			expect((await validateHydroDirectory(directory)).issues.map((issue) => issue.code)).toContain(
				"TOTAL_TIME_LIMIT_EXCEEDED",
			);
			await expect(buildHydroDirectoryArchive(directory)).rejects.toThrow("validation");
			expect(
				(await validateHydroDirectory(directory, { judgeLimits: { maxTestCases: 120, totalTimeLimitMs: 120000 } }))
					.valid,
			).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("validates the checked-in Hydro import fixture", async () => {
		const fixture = fileURLToPath(new URL("../../../fixtures/hydro/a-plus-b/hydro/a-plus-b", import.meta.url));
		const report = await validateHydroDirectory(fixture);
		expect(report.valid, JSON.stringify(report.issues, null, 2)).toBe(true);
		expect(report.stats).toMatchObject({ statements: 1, testCases: 3, attachments: 1 });
	});
});
