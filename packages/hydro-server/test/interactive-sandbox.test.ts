import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { interactiveReferenceTemplate, interactorTemplate } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it as test, vi } from "vitest";
import { awkCheckerProtocol } from "../src/checker-protocol.ts";
import { runInteractiveSandbox } from "../src/interactive-sandbox.ts";
import { runManualSandbox, type SandboxInput } from "../src/manual-sandbox.ts";

let root: string;
const exec = promisify(execFile);
let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}
const it = test.skipIf(!dockerAvailable);

it.each([
	['quitp(0.5, "score(100). diagnostic")', "", "WA", 50],
	['quitf(_ok, "correct answer")', "exit 43", "SYSTEM_ERROR", undefined],
	['quitp(0.5, "partial")', "exit 42", "SYSTEM_ERROR", undefined],
] as const)(
	"checks the real adapted interactor's exit code against its text: %s %s",
	async (ending, forcedExit, verdict, score) => {
		const report = await runInteractiveSandbox(
			sandbox({
				interactor: { language: "cpp17", code: testInteractor.replace('quitf(_ok, "correct answer")', ending) },
			}),
			{
				build: "cd /program\ng++ -std=c++17 -O2 -I. interactor.cc -o interactor\n",
				run: `/program/interactor "$1" "$3/transcript" "$2" 2> "$3/judgemessage.txt"\nstatus=$?\ncat "$3/judgemessage.txt" >&2\n${awkCheckerProtocol}\n${forcedExit}\n`,
				testlibPath: fileURLToPath(new URL("../sandbox/testlib/testlib.h", import.meta.url)),
			},
		);
		expect(report.success).toBe(false);
		expect(report.checks).toContainEqual(
			expect.objectContaining({
				stage: "interaction:reference",
				verdict,
				...(score === undefined ? {} : { score }),
			}),
		);
	},
	90_000,
);

function sandbox(overrides: Partial<SandboxInput> = {}): SandboxInput {
	return {
		mode: "finalize",
		stage: join(root, "stage"),
		image: "setdraft/sandbox:local",
		reference: { language: "python3", code: "print(int(input()) * 2, flush=True)" },
		interactor: { language: "cpp17", code: testInteractor },
		generatorStandard: "cpp17",
		checkerStandard: "cpp17",
		validatorStandard: "cpp17",
		timeLimitMs: 1000,
		memoryLimitMb: 256,
		maxFileBytes: 1024 * 1024,
		cases: [{ id: "1", inputPath: join(root, "input.in"), outputName: "1.out" }],
		...overrides,
	};
}

const testInteractor = `#include "testlib.h"
#include <iostream>
int main(int argc, char* argv[]) {
    registerInteraction(argc, argv);
    int challenge = inf.readInt();
    std::cout << challenge << std::endl;
    int answer = ouf.readInt();
    if (answer != challenge * 2) quitf(_wa, "incorrect answer");
    quitf(_ok, "correct answer");
}
`;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-interactive-sandbox-"));
	await writeFile(join(root, "input.in"), "21\n");
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("verifies a real bidirectional interaction without generating a reference answer", async () => {
	const report = await runManualSandbox({
		mode: "finalize",
		stage: join(root, "stage"),
		image: "setdraft/sandbox:local",
		reference: {
			language: "cpp17",
			code: "#include <iostream>\nint main() { int challenge; if (!(std::cin >> challenge)) return 1; std::cout << challenge * 2 << std::endl; }",
		},
		interactor: { language: "cpp17", code: testInteractor },
		generatorStandard: "cpp17",
		checkerStandard: "cpp17",
		validatorStandard: "cpp17",
		timeLimitMs: 1000,
		memoryLimitMb: 256,
		maxFileBytes: 1024 * 1024,
		cases: [{ id: "1", inputPath: join(root, "input.in"), outputName: "1.out" }],
		samples: [{ input: "not a test input", output: "not an answer" }],
	});
	expect(report).toMatchObject({ success: true, checkerUsed: false, interactorUsed: true, caseCount: 1 });
	expect(report.checks).toContainEqual(expect.objectContaining({ stage: "interaction:reference", verdict: "AC" }));
	expect(await readFile(join(root, "stage", "verified", "1.out"))).toHaveLength(0);
}, 90_000);

it.each([
	["wrong answer", "print(int(input()) + 1, flush=True)", "WA"],
	["missing flush", "import sys\ninput()\nsys.stdout.write('42\\n')\nsys.stdin.readline()", "TLE"],
	["unexpected EOF", "input()", "WA"],
	["runtime failure", "raise RuntimeError('contestant failure')", "RE"],
	["output limit", "print('x' * 2000000, flush=True)", "RE"],
] as const)(
	"reports %s without passing verification",
	async (_label, code, verdict) => {
		const report = await runManualSandbox(sandbox({ reference: { language: "python3", code } }));
		expect(report.success).toBe(false);
		expect(report.checks).toContainEqual(expect.objectContaining({ stage: "interaction:reference", verdict }));
	},
	90_000,
);

it("reports a crashing interactor as a system error, not a wrong answer", async () => {
	const report = await runManualSandbox(
		sandbox({
			interactor: {
				language: "cpp17",
				code: '#include "testlib.h"\n#include <cstdlib>\nint main(int argc, char* argv[]) { registerInteraction(argc, argv); std::abort(); }',
			},
		}),
	);
	expect(report.success).toBe(false);
	expect(report.checks).toContainEqual(
		expect.objectContaining({ stage: "interaction:reference", verdict: "SYSTEM_ERROR" }),
	);
}, 90_000);

it("does not accept a partially scored reference as fully verified", async () => {
	const report = await runManualSandbox(
		sandbox({
			interactor: {
				language: "cpp17",
				code: testInteractor.replace('quitf(_ok, "correct answer")', 'quitf(_ok, "score(50)")'),
			},
		}),
	);
	expect(report.success).toBe(false);
	expect(report.checks).toContainEqual(
		expect.objectContaining({ stage: "interaction:reference", verdict: "WA", score: 50 }),
	);
}, 90_000);

it.each(["score(100). diagnostic", "中文score(100)", "score(100)中文", "rescore(100)"])(
	"keeps diagnostic %s from turning a real partial interactor into full credit",
	async (message) => {
		const report = await runManualSandbox(
			sandbox({
				interactor: {
					language: "cpp17",
					code: testInteractor.replace('quitf(_ok, "correct answer")', `quitp(0.5, "${message}")`),
				},
			}),
		);
		expect(report.success).toBe(false);
		expect(report.checks).toContainEqual(
			expect.objectContaining({ stage: "interaction:reference", verdict: "WA", score: 50 }),
		);
	},
	90_000,
);

it("keeps private input and jury sources out of the contestant filesystem", async () => {
	const report = await runManualSandbox(
		sandbox({
			reference: {
				language: "python3",
				code: "import os, pathlib\nassert os.getuid() != 0\nfor name in ['/jury/input.in', '/jury/answer.ans', '/work/payload.json', '/work/cases', '/program/interactor.cc', '/program/testlib.h', '../interactor/main.cc']:\n    assert not pathlib.Path(name).exists(), name\nprint(int(input()) * 2, flush=True)",
			},
		}),
	);
	expect(report.success, JSON.stringify(report.checks)).toBe(true);
}, 90_000);

it("does not expose private files during contestant compilation", async () => {
	const report = await runManualSandbox(
		sandbox({ reference: { language: "cpp17", code: '#include "/jury/input.in"\nint main() {}' } }),
	);
	expect(report.success).toBe(false);
	expect(report.checks).toContainEqual(expect.objectContaining({ stage: "compile:reference", verdict: "CE" }));
}, 90_000);

it.each(["provided", "empty"] as const)(
	"runs the shipped %s-input templates",
	async (mode) => {
		if (mode === "empty") await writeFile(join(root, "input.in"), "");
		const report = await runManualSandbox(
			sandbox({
				reference: { language: "cpp17", code: interactiveReferenceTemplate },
				interactor: { language: "cpp17", code: interactorTemplate(mode) },
			}),
		);
		expect(report.success, JSON.stringify(report.checks)).toBe(true);
	},
	90_000,
);

it("cleans both containers and descendants before a cancelled interaction settles", async () => {
	const controller = new AbortController();
	const id = randomUUID();
	const names = [`setdraft-task-${id}-reference`, `setdraft-task-${id}-interactor`];
	const work = Promise.allSettled([
		runManualSandbox(
			sandbox({
				context: { id, signal: controller.signal, emit() {} },
				timeLimitMs: 60_000,
				reference: {
					language: "python3",
					code: "import subprocess, time\nsubprocess.Popen(['sleep', '60'])\ntime.sleep(60)",
				},
			}),
		),
	]);
	try {
		await vi.waitFor(
			async () => {
				for (const name of names)
					expect((await exec("docker", ["inspect", "--format", "{{.State.Running}}", name])).stdout.trim()).toBe(
						"true",
					);
				expect((await exec("docker", ["top", names[0], "-eo", "pid,args"])).stdout).toContain("sleep 60");
			},
			{ timeout: 15_000, interval: 200 },
		);
		controller.abort();
		expect((await work)[0].status).toBe("rejected");
		for (const name of names) await expect(exec("docker", ["inspect", name])).rejects.toMatchObject({ code: 1 });
	} finally {
		controller.abort();
		await work;
	}
}, 90_000);

it("generates reproducible private inputs, validates them and leaves empty answers", async () => {
	const report = await runManualSandbox(
		sandbox({
			mode: "generate",
			cases: undefined,
			commands: [["21"]],
			startNumber: 1,
			generator: '#include <iostream>\nint main() { std::cout << "21\\n"; }',
			validator:
				'#include "testlib.h"\nint main(int argc, char* argv[]) { registerValidation(argc, argv); inf.readInt(1, 100); inf.readEoln(); inf.readEof(); }',
		}),
	);
	expect(report).toMatchObject({ success: true, generatedCount: 1, validatorUsed: true, interactorUsed: true });
	expect(await readFile(join(root, "stage", "generated", "1.in"), "utf8")).toBe("21\n");
	expect(await readFile(join(root, "stage", "generated", "1.out"))).toHaveLength(0);
}, 90_000);
