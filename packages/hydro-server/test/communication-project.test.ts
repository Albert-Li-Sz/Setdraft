import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	communicationJudgeTemplate,
	communicationReferenceTemplate,
	isContestReadyRelease,
	type Solution,
	verificationContractVersion,
} from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { restoreProject } from "../src/project-history.ts";
import { sandboxIt } from "./sandbox-test.ts";

let root: string;
let store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-communication-project-"));
	store = new ManualProjectStore({ root, image: "setdraft/sandbox:local" });
});
afterEach(async () => {
	store.database.sql.close();
	await rm(root, { recursive: true, force: true });
});
const primary: Solution = {
	id: "reference",
	name: "Primary",
	language: "python3",
	code: communicationReferenceTemplate("python3"),
	purpose: "accepted",
	required: true,
	expectation: { kind: "AC" },
};
const wrong: Solution = {
	...primary,
	id: "wrong",
	name: "Wrong second round",
	code: primary.code.replace("value // 2", "0"),
	purpose: "wrong",
	expectation: { kind: "WA" },
};

sandboxIt.each(["interactive", "text", "custom"] as const)(
	"publishes, restores and verifies both platform adapters with %s round two",
	async (secondRound) => {
		const project = await store.create("acm", "communication");
		await store.update(project.id, {
			title: `Two-round ${secondRound}`,
			slug: `two-round-${secondRound}`,
			statementSections: {
				description: "Start the same program twice.",
				input: "hidden input",
				output: "hidden output",
				interaction: "hidden interaction",
				notes: "Flush after each message.",
				communication: "Each round starts fresh.",
				firstRound: "Read first and encode.",
				secondRound: "Read second and decode.",
			},
			communication: { judgeSource: communicationJudgeTemplate("provided"), judgeStandard: "cpp17", secondRound },
			checkerStandard: secondRound === "custom" ? "cpp20" : "cpp17",
			...(secondRound === "custom"
				? {
						checkerSource:
							'#include "testlib.h"\n#include <bit>\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);if(std::popcount(3u)!=2)quitf(_fail,"checker fault");long long expected=ans.readLong(),actual=ouf.readLong();if(actual==expected)quitf(_ok,"ok");quitf(_wa,"different");}',
					}
				: {}),
			solutions: [
				primary,
				wrong,
				{
					...wrong,
					id: "observe",
					name: "Observing compile failure",
					required: false,
					language: "cpp17",
					code: "cannot compile",
				},
			],
			referenceSolutionId: "reference",
			protocolSamples: [
				{
					rounds: [
						{
							round: 1,
							messages: [
								{ sender: "judge", text: "first\n21\n" },
								{ sender: "contestant", text: "42\n" },
							],
						},
						{
							round: 2,
							messages: [
								{ sender: "judge", text: "second\n42\n" },
								{ sender: "contestant", text: "21\n" },
							],
						},
					],
				},
			],
			samples: [{ input: "Old example", output: "Not runnable" }],
		});
		await store.addTextCase(project.id, { input: "21\n" });
		const current = await store.get(project.id);
		const pressure = await store.runs.execute(current.id, { kind: "pressure", solutionIds: ["wrong", "observe"] });
		expect(pressure.state).toBe("complete");
		expect(pressure.matrix?.solutions.find((solution) => solution.solutionId === "wrong")).toMatchObject({
			matches: true,
			complete: true,
		});
		expect(pressure.matrix?.cells.find((cell) => cell.solutionId === "wrong")).toMatchObject({
			verdict: "WA",
			failedRound: 2,
		});
		expect(pressure.matrix?.cells.find((cell) => cell.solutionId === "observe")).toMatchObject({ verdict: "CE" });
		const compiled: string[] = [];
		const result = await store.pipeline.finalize(project.id, {
			id: `communication-publication-${Date.now()}`,
			signal: new AbortController().signal,
			emit(type, message) {
				if (type === "stage" && message.startsWith("编译 ")) compiled.push(message);
			},
		});
		expect(result.report.success, JSON.stringify(result.report.checks)).toBe(true);
		expect(compiled).toEqual(["编译 reference", "编译 interactor", "编译 candidate1"]);
		if (!result.release) throw new Error("Expected release");
		expect(isContestReadyRelease(result.release)).toBe(true);
		expect(
			isContestReadyRelease({
				...result.release,
				report: { ...result.report, verificationContractVersion: verificationContractVersion - 1 },
			}),
		).toBe(false);
		expect(
			isContestReadyRelease({
				...result.release,
				report: { ...result.report, checks: result.report.checks.filter((check) => !check.rounds) },
			}),
		).toBe(false);
		const releaseRoot = store.releaseDirectory(result.release.id);
		const summary = JSON.parse(await readFile(join(releaseRoot, "source", "verification-summary.json"), "utf8"));
		expect(summary).toMatchObject({
			problemType: "communication",
			state: "complete",
			verificationContractVersion,
			matrix: { full: true, requiredPassed: true, caseCount: 1 },
		});
		expect(summary.matrix.cells).toBeUndefined();
		expect(summary.matrix.solutions.map((item: { matches: boolean }) => item.matches)).toEqual([true, true]);
		expect(JSON.parse(await readFile(join(releaseRoot, "source", "manifest.json"), "utf8")).imageDigest).toBe(
			summary.image,
		);
		const config = await readFile(join(releaseRoot, "hydro", current.slug, "testdata/config.yaml"), "utf8");
		expect(config).toContain("multi_pass: 2");
		const exportedSource = await readFile(join(releaseRoot, "hydro", current.slug, "testdata/interactor.cc"), "utf8");
		expect(exportedSource).toContain("HYDRO_MULTI_PASS");
		expect(exportedSource).not.toContain("state.txt");
		const markdown = await readFile(join(releaseRoot, "hydro", current.slug, "problem_zh.md"), "utf8");
		expect(markdown).toContain("## 通信说明");
		expect(markdown).not.toContain("hidden input");
		const exported = await store.releases.exportDomjudge(result.release.id);
		expect(
			execFileSync("unzip", ["-p", exported.path, "output_validators/interactor/build"], { encoding: "utf8" }),
		).toContain(secondRound === "custom" ? "-std=c++20" : "-std=c++17");
		const yaml = execFileSync("unzip", ["-p", exported.path, "problem.yaml"], { encoding: "utf8" });
		expect(yaml).toContain("type: pass-fail interactive multi-pass");
		expect(yaml).toContain("validation_passes: 2");
		expect(execFileSync("unzip", ["-Z1", exported.path], { encoding: "utf8" })).not.toContain("data/sample/");
		await expect(store.releases.exportLegacy(result.release.id, "fps")).rejects.toThrow("通信题暂不支持");
		const edited = await store.update(project.id, { problemType: "standard" });
		expect(edited.lastReport).toBeUndefined();
		const restored = await restoreProject(store, project.id, result.release.id, edited.revision);
		expect(restored.problemType).toBe("communication");
		expect(restored.communication).toEqual(current.communication);
		expect(restored.protocolSamples).toEqual(current.protocolSamples);
		expect(restored.lastReport).toBeUndefined();
	},
	180000,
);

sandboxIt(
	"scores only round two for OI, applies required expectations and uses strict empty input",
	async () => {
		const project = await store.create("oi", "communication");
		await store.addTextCase(project.id, { input: "preserved private data\n", output: "preserved answer\n" });
		const partial = {
			...wrong,
			id: "partial",
			name: "Partial score",
			purpose: "partial" as const,
			expectation: { kind: "score" as const, min: 50, max: 50 },
		};
		await store.update(project.id, {
			title: "Partial communication",
			slug: "partial-communication",
			statement: "Two rounds.",
			interactionInputMode: "empty",
			communication: {
				judgeSource: communicationJudgeTemplate("empty"),
				judgeStandard: "cpp17",
				secondRound: "custom",
			},
			checkerSource:
				'#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);int answer=ans.readInt(),actual=ouf.readInt();if(answer==actual)quitf(_ok,"ok");quitp(0.5,"partial");}',
			solutions: [primary, partial],
			referenceSolutionId: "reference",
			validatorSource: "invalid inactive validator",
			generatorScript: "invalid inactive generator",
		});
		const run = await store.runs.execute(project.id, { kind: "matrix" });
		expect(run.matrix?.full).toBe(true);
		expect(run.matrix?.requiredPassed, JSON.stringify(run.checks)).toBe(true);
		expect(run.matrix?.solutions.find((solution) => solution.solutionId === "partial")).toMatchObject({
			score: 50,
			matches: true,
		});
		expect(
			run.matrix?.cells.find((cell) => cell.solutionId === "partial")?.rounds?.map((round) => round.score),
		).toEqual([0, 50]);
		const result = await store.pipeline.finalize(project.id);
		expect(result.report.success, JSON.stringify(result.report.checks)).toBe(true);
		if (!result.release) throw new Error("Expected release");
		expect(
			await readFile(
				join(
					store.releaseDirectory(result.release.id),
					"hydro",
					project.slug || "partial-communication",
					"testdata/interactive-empty.in",
				),
			),
		).toHaveLength(0);
		expect(await store.database.readBuffer("manual", project.id, "1.in")).toEqual(
			Buffer.from("preserved private data\n"),
		);
		await store.update(project.id, {
			solutions: [primary, { ...partial, expectation: { kind: "score", min: 60, max: 80 } }],
		});
		const rejected = await store.pipeline.finalize(project.id);
		expect(rejected.report.success).toBe(false);
		expect(rejected.release).toBeUndefined();
	},
	150000,
);

it("invalidates reports after any communication setting change", async () => {
	const project = await store.create("acm", "communication");
	const current = await store.load(project.id);
	current.lastReport = {
		mode: "finalize",
		success: true,
		checks: [],
		caseCount: 1,
		generatedCount: 0,
		oracleCount: 0,
		validatorUsed: false,
		checkerUsed: false,
		communicationUsed: true,
		revision: 0,
		projectHash: "hash",
		issues: [],
		verifiedAt: new Date().toISOString(),
		verificationContractVersion,
	};
	await store.save(current);
	const changed = await store.update(project.id, {
		communication: { judgeSource: "changed", judgeStandard: "cpp20", secondRound: "text" },
	});
	expect(changed.lastReport).toBeUndefined();
});
