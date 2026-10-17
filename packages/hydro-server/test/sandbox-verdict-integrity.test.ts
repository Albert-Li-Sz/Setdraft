import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Generator, Solution } from "@setdraft/contracts";
import { afterEach, beforeEach, expect } from "vitest";
import { defaultTextChecker } from "../src/acm-checker.ts";
import { runManualSandbox, type SandboxInput } from "../src/manual-sandbox.ts";
import { runSolutionSandbox } from "../src/solution-sandbox.ts";
import { sandboxIt as it } from "./sandbox-test.ts";

/**
 * The verification matrix is the gate that authorizes publication, so a program running inside the
 * sandbox must never be able to influence how it is judged. These tests pin that boundary: the
 * trusted harness keeps root-owned build artifacts, while generators and contestant programs run
 * as an unprivileged user that cannot rewrite the Checker, reference or verified answers.
 */
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-verdict-integrity-"));
	await writeFile(join(root, "input.in"), "21\n");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const reference = { language: "python3", code: "print(int(input()) * 2)" } as const;

function sandbox(overrides: Partial<SandboxInput> = {}): SandboxInput {
	return {
		mode: "finalize",
		stage: join(root, "stage"),
		image: "setdraft/sandbox:local",
		reference: { ...reference },
		generatorStandard: "cpp17",
		checkerStandard: "cpp17",
		validatorStandard: "cpp17",
		checker: defaultTextChecker,
		timeLimitMs: 2000,
		memoryLimitMb: 256,
		maxFileBytes: 1024 * 1024,
		cases: [{ id: "1", inputPath: join(root, "input.in"), outputName: "1.out" }],
		...overrides,
	};
}

function solution(
	id: string,
	code: string,
	purpose: Solution["purpose"],
	expectation: Solution["expectation"],
): Solution {
	return { id, name: id, code, language: "python3", purpose, expectation, required: false };
}

function generator(name: string, code: string): Generator {
	return { id: name, name, code, language: "python3", remark: "" };
}

/** Overwrites the compiled Checker with a script that always reports a full score. */
const FORGE_CHECKER = String.raw`import os, pathlib
fake = pathlib.Path('/build/checker/main')
fake.write_text('#!/bin/sh\nprintf "ok\n" >&2\nexit 0\n')
os.chmod(fake, 0o755)
print(0)
`;

/** Overwrites the Python reference source, so every "verified" answer would come from the attacker. */
const FORGE_REFERENCE = String.raw`import pathlib
fake = pathlib.Path('/build/reference/main.py')
fake.write_text('print(999)\n')
print(21)
`;

it("judges an ordinary wrong answer as WA, so the forgery test cannot pass for the wrong reason", async () => {
	const result = await runSolutionSandbox({
		...sandbox(),
		solutions: [
			solution("primary", reference.code, "accepted", { kind: "AC" }),
			solution("plain-wrong", "print(0)", "wrong", { kind: "WA" }),
		],
		primaryId: "primary",
	});
	expect(
		result.cells.map((cell) => [cell.solutionId, cell.verdict, cell.score]),
		JSON.stringify(result.checks),
	).toEqual([
		["primary", "AC", 100],
		["plain-wrong", "WA", 0],
	]);
}, 90_000);

it("refuses a candidate that replaces the Checker binary it is judged by", async () => {
	const result = await runSolutionSandbox({
		...sandbox(),
		solutions: [
			solution("primary", reference.code, "accepted", { kind: "AC" }),
			solution("forger", FORGE_CHECKER, "wrong", { kind: "WA" }),
		],
		primaryId: "primary",
	});
	const forger = result.cells.find((cell) => cell.solutionId === "forger");
	expect(forger, JSON.stringify(result.checks)).toMatchObject({ score: 0 });
	expect(forger?.verdict, JSON.stringify(forger)).not.toBe("AC");
	expect(forger?.log ?? "", JSON.stringify(forger)).toContain("Permission denied");
}, 90_000);

it("terminates a sleeping unprivileged candidate and continues judging", async () => {
	const result = await runSolutionSandbox({
		...sandbox({ timeLimitMs: 250 }),
		solutions: [
			solution("primary", reference.code, "accepted", { kind: "AC" }),
			solution("sleeper", "import time\ntime.sleep(60)", "wrong", { kind: "TLE" }),
			solution("after-timeout", "print(0)", "wrong", { kind: "WA" }),
		],
		primaryId: "primary",
	});
	expect(
		result.cells.map((cell) => [cell.solutionId, cell.verdict, cell.score]),
		JSON.stringify(result.checks),
	).toEqual([
		["primary", "AC", 100],
		["sleeper", "TLE", 0],
		["after-timeout", "WA", 0],
	]);
}, 90_000);

it.each(["/private/work/answers/0.out", "/private/work/payload.json", "/build/reference/main.py"])(
	"refuses a candidate that reads trusted judge data from %s",
	async (path) => {
		const result = await runSolutionSandbox({
			...sandbox(),
			solutions: [
				solution("primary", reference.code, "accepted", { kind: "AC" }),
				solution("reader", `from pathlib import Path\nprint(Path(${JSON.stringify(path)}).read_text())`, "wrong", {
					kind: "WA",
				}),
			],
			primaryId: "primary",
		});
		const reader = result.cells.find((cell) => cell.solutionId === "reader");
		expect(reader, JSON.stringify(result.checks)).toMatchObject({ verdict: "RE", score: 0 });
		expect(reader?.log ?? "", JSON.stringify(reader)).toContain("Permission denied");
	},
	90_000,
);

it("compiles ordinary C++ and Java without giving the compiler access to private judge data", async () => {
	const result = await runSolutionSandbox({
		...sandbox(),
		solutions: [
			solution("primary", reference.code, "accepted", { kind: "AC" }),
			{
				...solution("cpp", '#include <cstdio>\nint main() { std::puts("42"); }', "accepted", { kind: "AC" }),
				language: "cpp17",
			},
			{
				...solution(
					"java",
					"public class Main { public static void main(String[] args) { System.out.println(42); } }",
					"accepted",
					{ kind: "AC" },
				),
				language: "java",
			},
			{
				...solution("private-include", '#include "/private/work/payload.json"\nint main() {}', "wrong", {
					kind: "WA",
				}),
				language: "cpp17",
			},
		],
		primaryId: "primary",
	});
	expect(
		result.cells.map((cell) => [cell.solutionId, cell.verdict]),
		JSON.stringify(result.checks),
	).toEqual([
		["primary", "AC"],
		["cpp", "AC"],
		["java", "AC"],
		["private-include", "CE"],
	]);
	expect(result.cells.find((cell) => cell.solutionId === "private-include")?.log).toContain("Permission denied");
}, 90_000);

it("derives verified answers from the real reference program for a benign generator", async () => {
	const stage = join(root, "stage");
	const report = await runManualSandbox({
		...sandbox({ stage, mode: "generate", cases: undefined }),
		generators: [generator("gen", "print(21)")],
		commands: [{ generator: "gen", args: [], line: 1 }],
		startNumber: 1,
	});
	expect(report.success, JSON.stringify(report.checks)).toBe(true);
	expect(await readFile(join(stage, "verified", "1.out"), "utf8")).toBe("42\n");
}, 90_000);

it("refuses a generator that replaces the reference program producing verified answers", async () => {
	const stage = join(root, "stage");
	const report = await runManualSandbox({
		...sandbox({ stage, mode: "generate", cases: undefined }),
		generators: [generator("gen", FORGE_REFERENCE)],
		commands: [{ generator: "gen", args: [], line: 1 }],
		startNumber: 1,
	});
	expect(report.success, JSON.stringify(report.checks)).toBe(false);
	const generatorCheck = report.checks.find((check) => check.stage === "generator");
	expect(generatorCheck, JSON.stringify(report.checks)).toMatchObject({ passed: false });
	expect(generatorCheck?.message ?? "", JSON.stringify(report.checks)).toContain("Permission denied");
	await expect(readFile(join(stage, "verified", "1.out"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}, 90_000);
