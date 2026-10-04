import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ManualProjectSnapshot,
	type MatrixCell,
	projectSolutions,
	type VerificationRun,
	verificationContractVersion,
} from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { activeQualityCases, inspectAuthoring } from "../src/authoring-insights.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";

let root: string, store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-quality-"));
	store = new ManualProjectStore({ root });
});
afterEach(async () => {
	await store.database.sql.close();
	await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const created = await store.create("oi");
	await store.update(created.id, {
		title: "Sum",
		slug: "sum",
		statement: "Add two integers.",
		solutions: [
			{
				id: "reference",
				name: "Primary",
				purpose: "accepted",
				language: "python3",
				code: "print(sum(map(int,input().split())))",
				required: true,
				expectation: { kind: "AC" },
			},
			{
				id: "wrong",
				name: "Wrong",
				purpose: "wrong",
				language: "python3",
				code: "print(0)",
				required: false,
				expectation: { kind: "WA" },
			},
			{
				id: "slow",
				name: "Slow",
				purpose: "slow",
				language: "python3",
				code: "while True: pass",
				required: true,
				expectation: { kind: "TLE" },
			},
		],
		referenceSolutionId: "reference",
	});
	await store.addTextCase(created.id, { name: "1.in", input: "0 0\n", output: "0\n" });
	await store.addTextCase(created.id, { name: "2.in", input: "1 2\n", output: "3\n" });
	return store.snapshot(created.id);
}
async function runFixture(
	project: ManualProjectSnapshot,
	options: Partial<VerificationRun> = {},
	overrides: Partial<MatrixCell>[] = [],
) {
	const id = randomUUID();
	const cases = activeQualityCases(project);
	const cells: MatrixCell[] = projectSolutions(project).flatMap((solution) =>
		cases.map((item, index) => ({
			solutionId: solution.id,
			caseId: `${item.origin}:${item.id}`,
			verdict: solution.id === "slow" && index === 1 ? "TLE" : "AC",
			score: solution.id === "slow" && index === 1 ? 0 : 100,
			durationMs: 1,
			message: "fixture",
		})),
	);
	for (const override of overrides)
		Object.assign(
			cells.find((cell) => cell.solutionId === override.solutionId && cell.caseId === override.caseId)!,
			override,
		);
	const run: VerificationRun = {
		id,
		projectId: project.id,
		revision: project.revision,
		fingerprint: "bound",
		image: `sha256:${"a".repeat(64)}`,
		createdAt: new Date().toISOString(),
		state: "complete",
		verificationContractVersion,
		options: { kind: "matrix" },
		solutions: projectSolutions(project),
		matrix: { cases, cells, solutions: [], full: true, requiredPassed: false },
		...options,
	};
	await store.database.put("verification-run", id, run);
	await store.database.commitFiles([
		{
			ownerKind: "verification-file",
			ownerId: id,
			name: "project.json",
			source: { bytes: Buffer.from(JSON.stringify(project)) },
		},
	]);
	for (const [index, item] of cases.entries()) {
		await store.database.storeBuffer(
			"verification-file",
			id,
			`cases/${index}.in`,
			await store.database.readBuffer(item.origin, project.id, item.inputFile),
		);
		if (item.outputFile)
			await store.database.storeBuffer(
				"verification-file",
				id,
				`cases/${index}.out`,
				await store.database.readBuffer(item.origin, project.id, item.outputFile),
			);
	}
	return run;
}
it("detects exact duplicates, empty data, invalid assignments, score distribution and declared boundaries", async () => {
	const project = await fixture();
	await store.addTextCase(project.id, { name: "3.in", input: "1 2\n", output: "3\n" });
	await store.addTextCase(project.id, { name: "4.in", input: "", output: "" });
	await store.update(project.id, {
		subtasks: [
			{ id: 1, type: "sum", score: 1 },
			{ id: 2, type: "min", score: 98 },
		],
		caseSubtasks: { "manual:4": 9, "manual:removed": 1 },
		boundaryConditions: [
			{ id: "minimum", name: "n = 0", rule: { kind: "integer", token: 1, min: "0", max: "0" } },
			{ id: "max", name: "maximum", rule: { kind: "integer", token: 1, min: "999999999999999999999999" } },
			{ id: "manual", name: "Declared", rule: { kind: "cases", caseIds: ["manual:2", "manual:deleted"] } },
		],
	});
	const { quality, readiness } = await inspectAuthoring(store, project.id);
	expect(quality.duplicates).toEqual([["manual:2", "manual:3"]]);
	expect(quality.issues.map((item) => item.code)).toEqual(
		expect.arrayContaining([
			"EMPTY_INPUT",
			"EMPTY_OUTPUT",
			"UNASSIGNED_CASE",
			"TOTAL_SCORE",
			"EMPTY_SUBTASK",
			"ZERO_POINT_CASES",
			"STALE_ASSIGNMENT",
			"UNCOVERED_BOUNDARY",
			"MISSING_BOUNDARY_CASE",
		]),
	);
	expect(quality.boundaries[0].caseIds).toEqual(["manual:1"]);
	expect(quality.boundaries[1].caseIds).toEqual([]);
	expect(quality.boundaries[2]).toMatchObject({ caseIds: ["manual:2"], missingCaseIds: ["manual:deleted"] });
	expect(readiness.checks.find((check) => check.id === "full-verification")?.state).toBe("pending");
});
it("highlights all-AC faulty solutions, detects cases and preserves advisory versus required checks", async () => {
	const project = await fixture();
	const run = await runFixture(project);
	const { quality, readiness } = await inspectAuthoring(store, project.id);
	expect(quality.faults).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ solutionId: "wrong", state: "all-ac", matches: false, caseIds: [], runId: run.id }),
			expect.objectContaining({ solutionId: "slow", state: "detected", matches: true, caseIds: ["manual:2"] }),
		]),
	);
	expect(quality.undistinguishedCaseIds).toEqual(["manual:1"]);
	expect(readiness.checks.find((check) => check.id === "solution:wrong")?.state).toBe("warning");
	expect(readiness.checks.find((check) => check.id === "solution:slow")?.state).toBe("ready");
	expect(readiness.verified).toBe(false);
	await store.update(project.id, { title: "New revision" });
	expect((await inspectAuthoring(store, project.id)).quality.faults.every((item) => item.state === "pending")).toBe(
		true,
	);
});
it("checks declared integer ranges across streamed chunks without truncating token positions", async () => {
	const project = await fixture();
	await store.addTextCase(project.id, {
		name: "large.in",
		input: `${"9".repeat(65539)}\u2003-9007199254740993\n`,
		output: "0\n",
	});
	await store.update(project.id, {
		boundaryConditions: [
			{ id: "large", name: "Invalid long token", rule: { kind: "integer", token: 1, min: "0" } },
			{ id: "negative", name: "Large negative", rule: { kind: "integer", token: 2, max: "-9007199254740993" } },
		],
	});
	const { quality } = await inspectAuthoring(store, project.id);
	expect(quality.boundaries[0].caseIds).not.toContain("manual:large");
	expect(quality.boundaries[1].caseIds).toEqual(["manual:large"]);
	const invalidRules = [
		{ kind: "integer", token: 0, min: "0" },
		{ kind: "integer", token: 10001, min: "0" },
		{ kind: "integer", token: 1, min: "2", max: "1" },
		{ kind: "integer", token: 1, min: "1.5" },
		{ kind: "cases", caseIds: ["manual:1", "manual:1"] },
	];
	for (const rule of invalidRules)
		await expect(
			store.update(project.id, { boundaryConditions: [{ id: "invalid", name: "Invalid", rule }] }),
		).rejects.toMatchObject({ statusCode: 422 });
	expect((await store.snapshot(project.id)).boundaryConditions).toHaveLength(2);
});
it.each(["cancelled", "sampled", "old-contract", "changed-file", "missing-source"])(
	"does not use %s evidence",
	async (kind) => {
		const project = await fixture();
		const run = await runFixture(
			project,
			kind === "cancelled"
				? { state: "cancelled" }
				: kind === "old-contract"
					? { verificationContractVersion: verificationContractVersion - 1 }
					: {},
		);
		if (kind === "sampled") {
			run.matrix!.full = false;
			await store.database.put("verification-run", run.id, run);
		}
		if (kind === "changed-file")
			await store.database.storeBuffer("verification-file", run.id, "cases/0.in", Buffer.from("different input"));
		if (kind === "missing-source") await store.database.removeFile("verification-file", run.id, "project.json");
		const { quality } = await inspectAuthoring(store, project.id);
		expect(quality.faults.every((item) => item.state === "pending")).toBe(true);
		expect(quality.discriminationComplete).toBe(false);
		expect(quality.undistinguishedCaseIds).toEqual([]);
	},
);
it("does not label compilation or system errors as detection coverage", async () => {
	const project = await fixture();
	await runFixture(project, {}, [{ solutionId: "wrong", caseId: "manual:1", verdict: "CE", score: 0 }]);
	const { quality } = await inspectAuthoring(store, project.id);
	expect(quality.faults.find((item) => item.solutionId === "wrong")?.state).toBe("incomplete");
	expect(quality.discriminationComplete).toBe(false);
});
it("treats no-input protocol data as intentional and keeps platform compatibility honest", async () => {
	const project = await fixture();
	await store.update(project.id, {
		problemType: "communication",
		interactionInputMode: "empty",
		communication: { judgeSource: "", judgeStandard: "cpp17", secondRound: "text" },
	});
	const { quality, readiness } = await inspectAuthoring(store, project.id);
	expect(quality).toMatchObject({ intentionalEmpty: true, caseCount: 1, duplicates: [] });
	expect(quality.issues.some((item) => item.code === "EMPTY_INPUT")).toBe(false);
	expect(readiness.platforms.find((item) => item.id === "domjudge")?.supported).toBe(false);
	expect(readiness.platforms.find((item) => item.id === "fps")?.supported).toBe(false);
});
