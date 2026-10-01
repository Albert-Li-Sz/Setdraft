import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { awkCheckerProtocol, checkerScore, pythonCheckerProtocol } from "../src/checker-protocol.ts";

const fixtures: Array<[number, string, number | undefined]> = [
	[0, "ok accepted", 100],
	[0, "ok score(0) wrong value", 0],
	[0, "ok score(80) partial", 80],
	[7, "points 1.0 exact match", 100],
	...[0.995, 0.996, 0.9999].map((value): [number, string, number] => [7, `points ${value} partial`, 99]),
	[7, "points 99.6 partial", 99],
	[7, "points 0.0 wrong", 0],
	[1, "wrong answer value", 0],
	[2, "wrong output format token", 0],
	[3, "FAIL internal", undefined],
	[7, "points 101 invalid", undefined],
	[0, "ok score(101) invalid", undefined],
	[0, "ok score(-1) invalid", undefined],
	[1, "wrong answer score(100) inconsistent", undefined],
	[0, "points 1.0 inconsistent", undefined],
	[40, "partially correct (40) partial", 40],
	[7, "points 0.5 rescore(100) is only a diagnostic label", 50],
	[7, "points 0.5 score(100). diagnostic", 50],
	[7, "points 0.5 score(100)中文", 50],
	[7, "points NaN invalid", undefined],
	[7, "points 0..5 invalid", undefined],
	[7, "points 0.5\nscore(25)\nscore(100)", 25],
	[7, "points 0.5 final_score(100)", 50],
	[0, "ok rescore(0)", 100],
	[0, "ok 中文score(0)", 100],
	[0, "ok score(0)中文", 100],
	[0, "ok score(0).", 100],
	[0, "ok\nscore(80)\r\nscore(0)", 80],
	[0, "ok\tscore(0)\t", 0],
	[0, "ok accepted\u00a0score(0)", 100],
	[0, "ok\u00a0score(0)", undefined],
	[0, "ok score(０)", 100],
];

it("local and exported score parsers agree with independent verdict fixtures", async () => {
	const directory = await mkdtemp(join(tmpdir(), "setdraft-score-"));
	try {
		const python = `import json,re,math,sys\n${pythonCheckerProtocol}\nprint(json.dumps([normalized_checker_score(*x) for x in json.load(sys.stdin)]))`;
		const parsed: unknown = JSON.parse(
			execFileSync("python3", ["-c", python], {
				input: JSON.stringify(fixtures.map(([code, message]) => [code, message])),
				encoding: "utf8",
			}),
		);
		expect(parsed).toEqual(fixtures.map(([, , score]) => score ?? null));
		for (const [code, message, expected] of fixtures) {
			expect(checkerScore(code, message)).toBe(expected);
			await writeFile(join(directory, "judgemessage.txt"), `${message}\n`);
			let actual = 0;
			try {
				execFileSync("sh", ["-c", `status=${code}\n${awkCheckerProtocol}`, "sh", "input", "answer", directory]);
			} catch (error) {
				actual = (error as { status: number }).status;
			}
			expect(actual, message).toBe(expected === undefined ? 1 : expected === 100 ? 42 : 43);
			expect(checkerScore(actual, message, true), `adapted: ${message}`).toBe(expected);
			if (expected !== undefined)
				expect(
					checkerScore(actual === 42 ? 43 : 42, message, true),
					`contradictory adapter: ${message}`,
				).toBeUndefined();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

let sandboxAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	sandboxAvailable = true;
} catch {}

it.skipIf(!sandboxAvailable)(
	"real testlib full, zero, partial, malformed and judge-fault results preserve verdicts",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "setdraft-real-score-"));
		try {
			await copyFile(
				fileURLToPath(new URL("../sandbox/testlib/testlib.h", import.meta.url)),
				join(directory, "testlib.h"),
			);
			await writeFile(
				join(directory, "checker.cc"),
				`#include "testlib.h"
#include <cstdlib>
#include <cstring>
int main(int argc,char**argv){registerTestlibCmd(argc,argv);const char* mode=std::getenv("MODE");
if(mode && !std::strcmp(mode,"fault"))quitf(_fail,"judge fault");
int expected=ans.readInt(),actual=ouf.readInt();
if(mode && !std::strcmp(mode,"diagnostic")){if(actual==expected)quitf(_ok,"exact match");quitp(0.5,"rescore(100) is only a diagnostic label");}
if(mode && !std::strcmp(mode,"points"))quitp(actual==expected?std::atof(std::getenv("FRACTION")):0.0,"fraction");
quitf(_ok,"score(%d) value",actual==expected?100:0);}
`,
			);
			await writeFile(join(directory, "run"), `#!/bin/sh\nstatus=$CHECKER_STATUS\n${awkCheckerProtocol}\n`);
			await writeFile(join(directory, "input"), "1 2\n");
			await writeFile(join(directory, "answer"), "5\n");
			const cases: Array<[string, string, string, number | undefined]> = [
				["score", "1", "5\n", 100],
				["score", "1", "6\n", 0],
				["points", "1", "5\n", 100],
				["points", "0", "5\n", 0],
				...["0.995", "0.996", "0.9999"].map((fraction): [string, string, string, number] => [
					"points",
					fraction,
					"5\n",
					99,
				]),
				["score", "1", "bad\n", 0],
				["fault", "1", "5\n", undefined],
				["diagnostic", "1", "5\n", 100],
				["diagnostic", "1", "bad\n", 0],
				["diagnostic", "1", "6\n", 50],
			];
			await writeFile(join(directory, "cases.json"), JSON.stringify(cases));
			await writeFile(
				join(directory, "check.py"),
				`import json,subprocess,os,re,math
${pythonCheckerProtocol}
rows=[]
for mode,fraction,output,expected in json.load(open('cases.json')):
 open('actual','w').write(output)
 result=subprocess.run(['./checker','input','actual','answer'],capture_output=True,text=True,env={**os.environ,'MODE':mode,'FRACTION':fraction})
 open('judgemessage.txt','w').write(result.stderr)
 # The shared awk adapter reads status from the shell and the real checker message from the feedback directory.
 adapter=subprocess.run(['sh','run','input','answer','.'],capture_output=True,env={**os.environ,'CHECKER_STATUS':str(result.returncode)}).returncode
 rows.append({'code':result.returncode,'message':result.stderr,'score':normalized_checker_score(result.returncode,result.stderr),'adapter':adapter,'expected':expected})
print(json.dumps(rows))
`,
			);
			const output = execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--network",
					"none",
					"--mount",
					`type=bind,source=${directory},target=/work`,
					"--workdir",
					"/work",
					"setdraft/sandbox:local",
					"sh",
					"-c",
					"g++ -std=c++17 -I. checker.cc -o checker && python3 check.py",
				],
				{ encoding: "utf8", timeout: 60_000 },
			);
			const rows = JSON.parse(output) as Array<{
				code: number;
				message: string;
				score: number | null;
				adapter: number;
				expected: number | null;
			}>;
			expect(rows).toHaveLength(cases.length);
			for (const row of rows) {
				expect(checkerScore(row.code, row.message), row.message).toBe(row.expected ?? undefined);
				expect(row.score, row.message).toBe(row.expected);
				expect(row.adapter, row.message).toBe(row.expected === null ? 1 : row.expected === 100 ? 42 : 43);
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	90_000,
);
