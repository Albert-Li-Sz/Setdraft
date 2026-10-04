import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type CommunicationConfig,
	communicationJudgeTemplate,
	communicationReferenceTemplate,
	type ProgramLanguage,
	type Solution,
} from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it as test, vi } from "vitest";
import { defaultTextChecker } from "../src/acm-checker.ts";
import { communicationAdapter } from "../src/communication-adapter.ts";
import { runInteractiveSandbox } from "../src/interactive-sandbox.ts";
import { runManualSandbox, type SandboxInput } from "../src/manual-sandbox.ts";
import { runSolutionSandbox } from "../src/solution-sandbox.ts";

let available = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	available = true;
} catch {}
const it = test.skipIf(!available);
let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-communication-"));
	await writeFile(join(root, "input.in"), "21\n");
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});
function sandbox(
	secondRound: CommunicationConfig["secondRound"],
	language: ProgramLanguage = "python3",
	overrides: Partial<SandboxInput> = {},
): SandboxInput {
	return {
		mode: "finalize",
		stage: join(root, "stage"),
		image: "setdraft/sandbox:local",
		reference: { language, code: communicationReferenceTemplate(language) },
		communication: { judgeSource: communicationJudgeTemplate("provided"), judgeStandard: "cpp17", secondRound },
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
it.each(
	["interactive", "text", "custom"].flatMap((mode) =>
		["cpp17", "python3", "java"].map((language) => ({
			mode: mode as CommunicationConfig["secondRound"],
			language: language as ProgramLanguage,
		})),
	),
)(
	"completes both rounds with $language and $mode final judging",
	async ({ mode, language }) => {
		const report = await runManualSandbox(sandbox(mode, language));
		expect(report.success, JSON.stringify(report.checks)).toBe(true);
		const result = report.checks.find((check) => check.stage === "interaction:reference");
		expect(result?.rounds?.map((round) => round.verdict)).toEqual(["AC", "AC"]);
		expect(result?.durationMs).toBe(Math.max(...result!.rounds!.map((round) => round.durationMs ?? 0)));
		expect(await readFile(join(root, "stage", "verified", "1.out"), "utf8")).toBe(
			mode === "interactive" ? "" : "21\n",
		);
	},
	90000,
);

const candidate = (id: string, code: string, language: ProgramLanguage = "python3"): Solution => ({
	id,
	name: id,
	code,
	language,
	purpose: "wrong",
	expectation: { kind: "WA" },
	required: false,
});
it("reuses a verified supplied final answer for every candidate", async () => {
	await writeFile(join(root, "answer.out"), "21\n");
	const input = sandbox("text", "python3", {
		cases: [
			{ id: "1", inputPath: join(root, "input.in"), outputPath: join(root, "answer.out"), outputName: "1.out" },
		],
	});
	const result = await runSolutionSandbox({
		...input,
		solutions: [candidate("primary", input.reference.code), candidate("auxiliary", input.reference.code)],
		primaryId: "primary",
	});
	expect(
		result.cells.map((cell) => cell.verdict),
		JSON.stringify(result.checks),
	).toEqual(["AC", "AC"]);
	expect(await readFile(join(input.stage, "verified", "1.out"), "utf8")).toBe("21\n");
}, 90000);

it.each(["interactive", "text", "custom"] as const)(
	"executes the exported Hydro adapter locally with %s round two",
	async (secondRound) => {
		await writeFile(join(root, "answer.out"), "21\n");
		const input = sandbox(secondRound, "python3", {
			cases: [
				{ id: "1", inputPath: join(root, "input.in"), outputPath: join(root, "answer.out"), outputName: "1.out" },
			],
		});
		const report = await runInteractiveSandbox(input, {
			source: communicationAdapter(input.communication!, input.checker!, "hydro", input.maxFileBytes),
			build: "#!/bin/sh\nset -eu\ng++ -std=c++17 -O2 -I/program /program/interactor.cc -o /program/judge\n",
			// Emulate Hydro's private next-pass input and jury environment, without state.txt.
			run: '#!/bin/sh\nset -u\ncd /jury\nif head -c 25 "$1" | /bin/grep -q \'^SETDRAFT_COMMUNICATION_2 \'; then export HYDRO_MULTI_PASS=2; else export HYDRO_MULTI_PASS=1; fi\n/program/judge "$1" /jury/transcript "$2"\nstatus=$?\ncase "$status" in 0) exit 42;; 1|2) exit 43;; *) exit "$status";; esac\n',
			testlibPath: fileURLToPath(new URL("../sandbox/testlib/testlib.h", import.meta.url)),
		});
		expect(report.success, JSON.stringify(report.checks)).toBe(true);
		expect(
			report.checks.find((check) => check.stage === "interaction:reference")?.rounds?.map((round) => round.verdict),
		).toEqual(["AC", "AC"]);
		expect(await readFile(join(input.stage, "verified", "1.out"), "utf8")).toBe(
			secondRound === "interactive" ? "" : "21\n",
		);
	},
	90000,
);
it("isolates compilation and reports WA/TLE/MLE/RE in either round, retaining valid first-round failures", async () => {
	const solutions = [candidate("primary", communicationReferenceTemplate("python3"))];
	for (const round of ["first", "second"]) {
		for (const [verdict, failure] of [
			["WA", "print(0, flush=True)"],
			["TLE", "while True: pass"],
			["MLE", "a = [bytearray(16 * 1024 * 1024) for _ in range(32)]\nprint(0, flush=True)"],
			["RE", "raise RuntimeError('failure')"],
		]) {
			solutions.push(
				candidate(
					`${round}-${verdict}`,
					`phase=input().strip()\nvalue=int(input())\nif phase == '${round}':\n${failure
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")}\nelse:\n    print(value * 2 if phase == 'first' else value // 2, flush=True)\n`,
				),
			);
		}
	}
	solutions.push(candidate("compile-failed", "this will not compile", "cpp17"));
	const result = await runSolutionSandbox({
		...sandbox("interactive", "python3", { timeLimitMs: 400, memoryLimitMb: 64 }),
		solutions,
		primaryId: "primary",
	});
	expect(result.cells).toHaveLength(solutions.length);
	expect(result.cells.find((cell) => cell.solutionId === "primary")).toMatchObject({ verdict: "AC", score: 100 });
	expect(result.checks.filter((check) => check.stage.startsWith("compile:candidate"))).toHaveLength(solutions.length);
	for (const round of ["first", "second"])
		for (const verdict of ["WA", "TLE", "MLE", "RE"]) {
			const cell = result.cells.find((cell) => cell.solutionId === `${round}-${verdict}`);
			expect(cell, JSON.stringify(result.checks)).toMatchObject({
				verdict,
				failedRound: round === "first" ? 1 : 2,
				score: 0,
			});
			expect(cell?.rounds?.[1].state).toBe(round === "first" ? "skipped" : "complete");
		}
	expect(result.cells.find((cell) => cell.solutionId === "compile-failed")).toMatchObject({ verdict: "CE" });
}, 120000);

it.each(["first", "second"] as const)(
	"retains %s-round RE when Docker attachment closes after the time limit",
	async (round) => {
		const dockerPath = execFileSync("/bin/sh", ["-c", "command -v docker"], { encoding: "utf8" }).trim();
		const bin = join(root, "bin");
		await mkdir(bin);
		const wrapper = join(bin, "docker");
		// Delay only the client exit, after the real contestant container has stopped.
		await writeFile(
			wrapper,
			`#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const args = process.argv.slice(2);
const child = spawn(${JSON.stringify(dockerPath)}, args, { stdio: 'inherit' });
const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
});
if (args[0] === 'start' && args.includes('--interactive') && args.at(-1)?.endsWith('-candidate1') && code !== 0) {
    writeFileSync(${JSON.stringify(join(root, "attachment-delayed"))}, 'delayed');
    await setTimeout(650);
}
process.exitCode = code ?? 125;
`,
		);
		await chmod(wrapper, 0o755);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
		try {
			const code = communicationReferenceTemplate("python3").replace(
				"print(",
				`if phase == '${round}': raise RuntimeError('failure')\nprint(`,
			);
			const result = await runSolutionSandbox({
				...sandbox("interactive", "python3", { timeLimitMs: 400, memoryLimitMb: 64 }),
				solutions: [candidate("primary", communicationReferenceTemplate("python3")), candidate("broken", code)],
				primaryId: "primary",
			});
			expect(await readFile(join(root, "attachment-delayed"), "utf8")).toBe("delayed");
			expect(
				result.cells.find((cell) => cell.solutionId === "broken"),
				JSON.stringify(result.checks),
			).toMatchObject({
				verdict: "RE",
				failedRound: round === "first" ? 1 : 2,
				score: 0,
			});
		} finally {
			vi.unstubAllEnvs();
		}
	},
	90000,
);

it.each(['quitf(_ok, "accepted");', 'quit(_ok, "accepted");', 'quitp(1.0, "accepted");'])(
	"rejects missing handoff through %s",
	async (exit) => {
		const judgeSource = `#include "testlib.h"\nint main(int argc,char**argv){registerInteraction(argc,argv);${exit}}`;
		const report = await runManualSandbox(
			sandbox("interactive", "python3", {
				reference: { language: "python3", code: "pass" },
				communication: { judgeSource, judgeStandard: "cpp17", secondRound: "interactive" },
			}),
		);
		expect(report.checks.find((check) => check.stage === "interaction:reference")).toMatchObject({
			verdict: "SYSTEM_ERROR",
			rounds: [
				{ round: 1, state: "complete", verdict: "SYSTEM_ERROR" },
				{ round: 2, state: "skipped" },
			],
		});
	},
	90000,
);

it("uses a fresh contestant process and filesystem for round two, and keeps jury input/source/handoff private", async () => {
	const code = `import os\nphase=input().strip()\nvalue=int(input())\nassert not os.path.exists('/jury')\nassert not os.path.exists('/program/jury.cc')\nif phase == 'first':\n    open('round-one-marker','w').write('secret')\nelse:\n    assert not os.path.exists('round-one-marker')\nprint(value * 2 if phase == 'first' else value // 2, flush=True)\n`;
	const report = await runManualSandbox(sandbox("text", "python3", { reference: { language: "python3", code } }));
	expect(report.success, JSON.stringify(report.checks)).toBe(true);
}, 90000);

it("rejects requesting a third round as a judge fault", async () => {
	const judgeSource = communicationJudgeTemplate("provided").replace(
		'quitf(_ok, "Both rounds accepted");',
		'saveCommunicationHandoff("third"); quitf(_ok, "Both rounds accepted");',
	);
	const report = await runManualSandbox(
		sandbox("interactive", "python3", {
			communication: { judgeSource, judgeStandard: "cpp17", secondRound: "interactive" },
		}),
	);
	expect(report.checks.find((check) => check.stage === "interaction:reference")).toMatchObject({
		verdict: "SYSTEM_ERROR",
		failedRound: 2,
	});
}, 90000);

it("reports a judge that hangs after the contestant exits as a system fault", async () => {
	const judgeSource =
		'#include "testlib.h"\nint main(int argc,char**argv){registerInteraction(argc,argv);while(true){}}';
	const report = await runManualSandbox(
		sandbox("interactive", "python3", {
			timeLimitMs: 500,
			reference: { language: "python3", code: "pass" },
			communication: { judgeSource, judgeStandard: "cpp17", secondRound: "interactive" },
		}),
	);
	expect(
		report.checks.find((check) => check.stage === "interaction:reference"),
		JSON.stringify(report.checks),
	).toMatchObject({ verdict: "SYSTEM_ERROR", failedRound: 1 });
}, 90000);

it("cancels an active communication round and removes every task container", async () => {
	const controller = new AbortController();
	const id = `communication-cancel-${Date.now()}`;
	const timeout = setTimeout(() => controller.abort(new Error("cancelled")), 8000);
	try {
		await expect(
			runManualSandbox(
				sandbox("interactive", "python3", {
					timeLimitMs: 30000,
					reference: { language: "python3", code: "input(); input();\nwhile True: pass" },
					context: {
						id,
						signal: controller.signal,
						emit(type) {
							if (type === "interaction-start") controller.abort(new Error("cancelled"));
						},
					},
				}),
			),
		).rejects.toThrow();
		expect(
			execFileSync("docker", ["ps", "-aq", "--filter", `name=setdraft-task-${id}`], { encoding: "utf8" }).trim(),
		).toBe("");
	} finally {
		clearTimeout(timeout);
	}
}, 30000);
