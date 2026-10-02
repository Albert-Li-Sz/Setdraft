import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	aggregateScore,
	evaluateSolution,
	interactorTemplate,
	type MatrixCell,
	projectSolutions,
	type Solution,
} from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { readVerificationOptions } from "../src/verification-runs.ts";
import { sandboxIt } from "./sandbox-test.ts";

let root: string;
let store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-solutions-"));
	store = new ManualProjectStore({ root });
});
afterEach(async () => {
	store.database.sql.close();
	await rm(root, { recursive: true, force: true });
});
const solution = (
	id: string,
	code: string,
	expectation: Solution["expectation"] = { kind: "AC" },
	required = false,
): Solution => ({ id, name: id, language: "python3", code, purpose: "accepted", required, expectation });
const good = solution("reference", "print(sum(map(int,input().split())))", { kind: "AC" }, true);
const bad = solution("wrong", "print(0)", { kind: "WA" });
const partialChecker =
	'#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);int a=ans.readInt(),b=ouf.readInt();if(a==b)quitf(_ok,"ok");quitp(0.5,"partial");}';
const cell = (id: string, verdict: MatrixCell["verdict"], score = verdict === "AC" ? 100 : 0): MatrixCell => ({
	solutionId: "wrong",
	caseId: id,
	verdict,
	score,
	durationMs: 1,
	message: "",
});
async function fixture() {
	const project = await store.create("acm");
	await store.update(project.id, {
		title: "Sum",
		slug: "sum",
		statement: "Add integers.",
		checkerMode: "text",
		solutions: [good, bad],
		referenceSolutionId: "reference",
		generatorSource: '#include <iostream>\nint main(int argc,char**argv){std::cout << argv[1] << " 2\\n";}',
	});
	await store.addTextCase(project.id, { name: "1.in", input: "1 2\n", output: "3\n" });
	return store.get(project.id);
}
it("migrates both legacy programs, synchronizes edits and switches the primary without losing source", async () => {
	const project = await store.create("acm");
	await store.update(project.id, {
		reference: { language: "python3", code: "print(1)" },
		oracle: { language: "python3", code: "print(2)" },
	});
	const current = await store.get(project.id);
	expect(projectSolutions(current).map(({ id, required, expectation }) => ({ id, required, expectation }))).toEqual([
		{ id: "reference", required: true, expectation: { kind: "AC" } },
		{ id: "oracle", required: true, expectation: { kind: "AC" } },
	]);
	await store.update(project.id, { solutions: current.solutions, referenceSolutionId: "oracle" });
	expect((await store.get(project.id)).reference.code).toBe("print(2)");
	await store.update(project.id, { reference: { language: "python3", code: "print(3)" } });
	expect((await store.get(project.id)).solutions?.find((item) => item.id === "oracle")?.code).toBe("print(3)");
	await store.update(project.id, { oracle: null });
	expect((await store.get(project.id)).reference.code).toBe("print(3)");
	await store.update(project.id, { oracle: { language: "python3", code: "print(4)" } });
	expect((await store.get(project.id)).reference.code).toBe("print(3)");
	expect((await store.get(project.id)).oracle?.code).toBe("print(4)");
	await expect(store.update(project.id, { solutions: [good, { ...bad, id: good.id }] })).rejects.toThrow("重复");
	await expect(store.update(project.id, { solutions: [good, bad], referenceSolutionId: "wrong" })).rejects.toThrow(
		"必检 AC",
	);
});
it("matches exact expectations, excluding CE, system errors, incomplete and sampled partial scores", () => {
	expect(evaluateSolution(bad, [cell("1", "WA"), cell("2", "AC")], 2, 50, true).matches).toBe(true);
	for (const verdict of ["RE", "TLE", "CE", "SYSTEM_ERROR"] as const)
		expect(evaluateSolution(bad, [cell("1", "WA"), cell("2", verdict)], 2, 0, true).matches).toBe(false);
	expect(evaluateSolution(bad, [cell("1", "AC")], 1, 100, true).matches).toBe(false);
	expect(evaluateSolution({ ...bad, expectation: { kind: "TLE" } }, [cell("1", "TLE")], 1, 0, true).matches).toBe(
		true,
	);
	const partial = { ...bad, expectation: { kind: "score" as const, min: 25, max: 50 } };
	expect(evaluateSolution(partial, [cell("1", "WA", 50)], 1, 50, true).matches).toBe(true);
	expect(evaluateSolution(partial, [cell("1", "WA", 50)], 1, 50, false).matches).toBe(false);
	expect(evaluateSolution(partial, [cell("1", "WA", 50)], 2, 50, true).matches).toBe(false);
});
it("uses Hydro final-case remainder allocation and sum/min/max aggregation", () => {
	const cases = [1, 2, 3].map((id) => ({
		id: String(id),
		origin: "manual" as const,
		inputFile: `${id}.in`,
		inputBytes: 1,
		subtaskId: 1,
	}));
	const cells = [cell("manual:1", "AC"), cell("manual:2", "WA", 50), cell("manual:3", "WA", 0)];
	expect(aggregateScore([{ id: 1, score: 100, type: "sum" }], cases, cells)).toBe(49);
	expect(
		aggregateScore(
			[{ id: 1, score: 99, type: "sum" }],
			[cases[0]],
			[{ ...cell("manual:1", "WA", 1), scoreRatio: 0.0199 }],
		),
	).toBe(1);
	expect(aggregateScore([{ id: 1, score: 100, type: "sum" }], cases, [cell("manual:3", "AC")])).toBe(34);
	expect(aggregateScore([{ id: 1, score: 100, type: "min" }], cases, cells)).toBe(0);
	expect(aggregateScore([{ id: 1, score: 100, type: "max" }], cases, cells)).toBe(100);
	expect(
		aggregateScore(
			[
				{ id: 1, score: 70, type: "min" },
				{ id: 2, score: 30, type: "max" },
			],
			[...cases, { ...cases[0], id: "4", subtaskId: 2 }],
			[...cells, cell("manual:4", "WA", 50)],
		),
	).toBe(15);
});
it("validates stress bounds, literal arguments and defaults without shell execution", () => {
	expect(
		readVerificationOptions({
			kind: "stress",
			baselineId: "reference",
			solutionIds: ["wrong"],
			command: "gen {seed}",
		}),
	).toMatchObject({ seed: 1, rounds: 100, budgetMs: 60000 });
	for (const value of [
		{ rounds: 1001 },
		{ seed: -1 },
		{ budgetMs: 0 },
		{ solutionIds: ["reference"] },
		{ command: "gen 1" },
		{ command: "gen {seed}; rm -rf x" },
	])
		expect(() =>
			readVerificationOptions({
				kind: "stress",
				baselineId: "reference",
				solutionIds: ["wrong"],
				command: "gen {seed}",
				...value,
			}),
		).toThrow();
});
sandboxIt(
	"runs a complete matrix with CE isolation, exact expectations, and observation-only failures",
	async () => {
		const project = await fixture();
		await store.update(project.id, {
			solutions: [good, bad, solution("broken", "this is bad code", { kind: "WA" })],
		});
		const run = await store.runs.execute(project.id, { kind: "matrix" });
		expect(run.matrix?.cells.map((item) => item.verdict)).toEqual(["AC", "WA", "CE"]);
		expect(run.matrix?.solutions.map((item) => item.matches)).toEqual([true, true, false]);
		expect(run.matrix?.requiredPassed).toBe(true);
		expect((await store.runs.list(project.id))[0].id).toBe(run.id);
		expect((await store.runs.get(project.id, run.id)).matrix?.cells).toHaveLength(3);
		const observedFailure = await store.pipeline.finalize(project.id);
		expect(observedFailure.report.success).toBe(true);
		expect(observedFailure.release).toBeDefined();
		const required = [good, { ...bad, expectation: { kind: "AC" as const }, required: true }];
		await store.update(project.id, { solutions: required });
		const failed = await store.pipeline.finalize(project.id);
		expect(failed.report.success).toBe(false);
		expect(failed.release).toBeUndefined();
		await store.update(project.id, { solutions: [good, { ...bad, required: true }] });
		const passed = await store.pipeline.finalize(project.id);
		expect(passed.report.success, JSON.stringify(passed.report)).toBe(true);
		expect(passed.report.matrixRunId).toBeTruthy();
		expect(passed.release).toBeDefined();
	},
	120000,
);
sandboxIt(
	"finds the first deterministic counterexample, preserves and replays its snapshot, and imports once",
	async () => {
		const project = await fixture();
		const options = readVerificationOptions({
			kind: "stress",
			baselineId: "reference",
			solutionIds: ["wrong"],
			command: "gen {seed}",
			seed: 7,
			rounds: 100,
			budgetMs: 60000,
		});
		const run = await store.runs.execute(project.id, options);
		expect(run.stress, run.error).toMatchObject({
			reason: "counterexample",
			seed: 7,
			args: ["7"],
			completedRounds: 1,
			inputPreview: "7 2\n",
			outputPreview: "9\n",
		});
		const archive = await store.runs.archive(project.id, run.id);
		expect((await readFile(archive)).subarray(0, 2).toString()).toBe("PK");
		const extracted = join(root, "reproduction");
		await promisify(execFile)("unzip", ["-q", archive, "-d", extracted]);
		const bundle = join(extracted, "setdraft-reproduction");
		await promisify(execFile)("sh", [join(bundle, "reproduce.sh")], { timeout: 60000 });
		expect(JSON.parse(await readFile(join(bundle, "matrix-result.json"), "utf8")).stress).toMatchObject({
			reason: "counterexample",
			seed: 7,
			args: ["7"],
		});
		await store.update(project.id, { solutions: [good, { ...bad, code: good.code }] });
		const replay = await store.runs.execute(project.id, options, undefined, run.id);
		expect(replay.stress?.reason).toBe("counterexample");
		expect(replay.revision).toBe(run.revision);
		const current = await store.get(project.id);
		await expect(
			store.runs.importCase(project.id, run.id, {
				expectedRevision: current.revision - 1,
				subtaskId: 1,
				name: "new.in",
			}),
		).rejects.toThrow("版本");
		await expect(
			store.runs.importCase(project.id, run.id, { expectedRevision: current.revision, subtaskId: 1, name: "1.in" }),
		).rejects.toThrow("已存在");
		const imported = await store.runs.importCase(project.id, run.id, {
			expectedRevision: current.revision,
			subtaskId: 1,
			name: "new.in",
		});
		expect(imported.cases).toHaveLength(2);
		expect(imported.lastReport).toBeUndefined();
		expect(await readFile(await store.dataFile(project.id, "manual", "new.in"), "utf8")).toBe("7 2\n");
		await expect(
			store.runs.importCase(project.id, run.id, {
				expectedRevision: imported.revision,
				subtaskId: 1,
				name: "other.in",
			}),
		).rejects.toThrow("已加入");
		const second = await store.create("acm");
		await expect(store.runs.get(second.id, run.id)).rejects.toThrow("不存在");
	},
	120000,
);
sandboxIt.each([
	["acm", "provided"],
	["acm", "empty"],
	["oi", "provided"],
	["oi", "empty"],
] as const)(
	"runs independent %s %s-input interactive candidates",
	async (scoring, mode) => {
		const project = await store.create(scoring);
		const primary = { ...good, code: "print(int(input())*2,flush=True)" };
		await store.update(project.id, {
			judgingMode: "interactive",
			interactionInputMode: mode,
			interactorSource: interactorTemplate(mode),
			solutions: [primary, { ...bad, code: "print(0,flush=True)" }, solution("broken", "invalid syntax!")],
			referenceSolutionId: "reference",
		});
		if (mode === "provided") await store.addTextCase(project.id, { name: "1.in", input: "21\n" });
		const run = await store.runs.execute(project.id, { kind: "matrix" });
		expect(
			run.matrix?.cells.map((item) => item.verdict),
			JSON.stringify(run),
		).toEqual(["AC", "WA", "CE"]);
		expect(run.matrix?.requiredPassed).toBe(true);
	},
	120000,
);
sandboxIt(
	"cleans the running container and descendants before cancellation returns",
	async () => {
		const project = await fixture();
		await store.update(project.id, {
			reference: {
				language: "python3",
				code: "import subprocess,time\nsubprocess.Popen(['sleep','60'])\ntime.sleep(60)",
			},
			timeLimit: "10000ms",
		});
		const controller = new AbortController(),
			id = randomUUID();
		const exec = promisify(execFile);
		const work = Promise.allSettled([
			store.runs.execute(project.id, { kind: "matrix" }, { id, signal: controller.signal, emit() {} }),
		]);
		try {
			await vi.waitFor(
				async () =>
					expect((await exec("docker", ["top", `setdraft-task-${id}`, "-eo", "pid,args"])).stdout).toContain(
						"sleep 60",
					),
				{ timeout: 12000, interval: 150 },
			);
			controller.abort();
			expect((await work)[0].status).toBe("rejected");
			await expect(exec("docker", ["inspect", `setdraft-task-${id}`])).rejects.toMatchObject({ code: 1 });
			expect((await store.runs.list(project.id))[0].state).toBe("cancelled");
		} finally {
			controller.abort();
			await work;
		}
	},
	30000,
);

sandboxIt(
	"runs OI partial SPJ scoring and rejects sampled partial-score certification",
	async () => {
		const project = await store.create("oi");
		await store.update(project.id, {
			solutions: [good, { ...bad, required: true, expectation: { kind: "score", min: 49, max: 49 } }],
			referenceSolutionId: good.id,
			checkerMode: "custom",
			checkerSource: partialChecker,
			subtasks: [{ id: 1, type: "sum", score: 100 }],
		});
		for (let index = 1; index <= 3; index++)
			await store.addTextCase(project.id, { name: `${index}.in`, input: "1 2\n", output: "3\n", subtaskId: 1 });
		const run = await store.runs.execute(project.id, { kind: "matrix" });
		expect(run.matrix?.solutions.find((item) => item.solutionId === bad.id)).toMatchObject({
			score: 49,
			matches: true,
			complete: true,
		});
		expect(run.matrix?.requiredPassed).toBe(true);
		const sampled = await store.runs.execute(project.id, { kind: "matrix", caseIds: ["manual:1"] });
		expect(sampled.matrix?.cells.find((item) => item.solutionId === good.id)?.points).toBe(33);
		expect(sampled.matrix?.solutions.find((item) => item.solutionId === bad.id)?.score).toBe(16);
		expect(sampled.matrix?.full).toBe(false);
		expect(sampled.matrix?.requiredPassed).toBe(false);
		expect(sampled.matrix?.solutions.find((item) => item.solutionId === bad.id)?.matches).toBe(false);
	},
	60000,
);

sandboxIt(
	"continues other solutions when the primary cannot compile and supplied answers exist",
	async () => {
		const project = await fixture();
		await store.update(project.id, {
			solutions: [
				{ ...good, code: "invalid syntax!" },
				{ ...bad, code: good.code },
			],
		});
		const run = await store.runs.execute(project.id, { kind: "matrix" });
		expect(run.matrix?.cells.map((item) => item.verdict)).toEqual(["CE", "AC"]);
		expect(run.matrix?.requiredPassed).toBe(false);
	},
	60000,
);

sandboxIt.each(["nondeterministic", "baseline", "checker", "validator", "rounds", "budget"] as const)(
	"distinguishes stress outcome %s",
	async (scenario) => {
		const project = await fixture();
		if (scenario === "nondeterministic")
			await store.update(project.id, {
				generatorSource:
					"#include <iostream>\n#include <chrono>\nint main(){std::cout << std::chrono::high_resolution_clock::now().time_since_epoch().count();}",
			});
		if (scenario === "baseline")
			await store.update(project.id, {
				reference: { language: "python3", code: 'raise RuntimeError("faux failure")' },
			});
		if (scenario === "checker")
			await store.update(project.id, {
				checkerMode: "custom",
				checkerSource:
					'#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);quitf(_fail,"faux checker failure");}',
			});
		if (scenario === "validator")
			await store.update(project.id, {
				validatorSource:
					'#include "testlib.h"\nint main(int argc,char**argv){registerValidation(argc,argv);inf.readInt(100,200);}',
			});
		if (scenario === "rounds") await store.update(project.id, { solutions: [good, { ...bad, code: good.code }] });
		if (scenario === "budget")
			await store.update(project.id, {
				solutions: [good, { ...bad, code: "import time; time.sleep(10)" }],
				timeLimit: "10000ms",
			});
		const run = await store.runs.execute(
			project.id,
			readVerificationOptions({
				kind: "stress",
				baselineId: good.id,
				solutionIds: [bad.id],
				command: "gen {seed}",
				rounds: 2,
				budgetMs: scenario === "budget" ? 1000 : 60000,
			}),
		);
		expect(run.stress?.reason, JSON.stringify(run)).toBe(
			["rounds", "budget"].includes(scenario) ? scenario : "error",
		);
		if (scenario === "rounds") expect(run.stress?.completedRounds).toBe(2);
		if (scenario === "nondeterministic") expect(run.error).toContain("不一致");
		if (scenario === "baseline") expect(run.error).toContain("基准");
	},
	60000,
);

sandboxIt.each(["RE", "TLE"] as const)(
	"preserves the first %s counterexample and its actual output",
	async (verdict) => {
		const project = await fixture();
		await store.update(project.id, {
			solutions: [
				good,
				{
					...bad,
					code:
						verdict === "RE"
							? "print('partial',flush=True)\nraise RuntimeError('faux')"
							: "import time\nprint('partial',flush=True)\ntime.sleep(3)",
				},
			],
		});
		const run = await store.runs.execute(
			project.id,
			readVerificationOptions({ kind: "stress", baselineId: good.id, solutionIds: [bad.id], command: "gen {seed}" }),
		);
		expect(run.stress).toMatchObject({
			reason: "counterexample",
			completedRounds: 1,
			seed: 1,
			cells: [expect.objectContaining({ verdict })],
		});
		expect(
			(await store.database.readBuffer("verification-file", run.id, "outputs/candidate0-stress.out")).toString(),
		).toBe("partial\n");
	},
	60000,
);
