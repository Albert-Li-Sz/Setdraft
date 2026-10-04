import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isCompleteCommunicationResult,
	isProjectSnapshot,
	problemTypes,
	resolveProblemType,
	synchronizeProblemType,
} from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	communicationInitialInput,
	readCommunicationEnvelope,
	readCommunicationInitialInput,
} from "../src/communication-adapter.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { copyProject } from "../src/project-history.ts";

let root: string;
let source: ManualProjectStore;
let target: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-types-"));
	source = new ManualProjectStore({ root: join(root, "source") });
	target = new ManualProjectStore({ root: join(root, "target") });
});
it("makes incomplete legacy protocol samples editable without changing message order or colliding IDs", () => {
	const project = {
		protocolSamples: [
			{
				rounds: [
					{
						round: 2 as const,
						messages: [
							{ sender: "judge" as const, text: "first" },
							{ id: "message-2-0", sender: "contestant" as const, text: "second" },
						],
					},
				],
			},
			{ id: "sample-0", rounds: [] },
		],
	};
	synchronizeProblemType(project);
	expect(project.protocolSamples[0]).toEqual({
		id: "sample-0-1",
		rounds: [
			{ round: 1, messages: [] },
			{
				round: 2,
				messages: [
					{ id: "message-2-0-1", sender: "judge", text: "first" },
					{ id: "message-2-0", sender: "contestant", text: "second" },
				],
			},
		],
	});
	const previous = structuredClone(project.protocolSamples);
	synchronizeProblemType(project);
	expect(project.protocolSamples).toEqual(previous);
});
afterEach(async () => {
	source.database.sql.close();
	target.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

it.each(problemTypes)(
	"creates %s with independent fixed scoring and consistent compatibility views",
	async (problemType) => {
		const project = await source.create("oi", problemType);
		expect(project).toMatchObject({
			problemType,
			scoringMode: "oi",
			judgingMode: problemType === "interactive" || problemType === "communication" ? "interactive" : "default",
			checkerMode: problemType === "special" ? "custom" : "text",
		});
		expect(isProjectSnapshot(project)).toBe(true);
		await expect(source.update(project.id, { scoringMode: "acm" })).rejects.toMatchObject({ statusCode: 422 });
	},
);
it.each([
	{ judgingMode: "default", checkerMode: "text", problemType: "standard" },
	{ judgingMode: "default", checkerMode: "custom", problemType: "special" },
	{ judgingMode: "interactive", checkerMode: "custom", interactionInputMode: "provided", problemType: "interactive" },
	{ judgingMode: "interactive", checkerMode: "text", interactionInputMode: "empty", problemType: "interactive" },
] as const)("centrally migrates legacy $judgingMode/$checkerMode/$interactionInputMode", async (fixture) => {
	const project = await source.create("acm");
	const legacy = await source.load(project.id);
	delete legacy.problemType;
	delete legacy.communication;
	Object.assign(legacy, { ...fixture, problemType: undefined });
	await source.database.put("project", project.id, legacy);
	const migrated = await source.get(project.id);
	expect(resolveProblemType(migrated)).toBe(fixture.problemType);
	expect(isProjectSnapshot(migrated)).toBe(true);
});
it("preserves hidden sources, statement fields, samples and data when changing types or copying", async () => {
	const created = await source.create("acm", "communication");
	await source.addTextCase(created.id, { input: "21\n", output: "unused\n" });
	const configured = await source.update(created.id, {
		communication: { judgeSource: "communication code", judgeStandard: "cpp20", secondRound: "custom" },
		checkerSource: "checker code",
		interactorSource: "interactive code",
		statementSections: {
			description: "description",
			input: "input",
			output: "output",
			interaction: "interaction",
			notes: "notes",
			communication: "start twice",
			firstRound: "encode",
			secondRound: "decode",
		},
		samples: [{ input: "old judge", output: "old program" }],
		protocolSamples: [
			{
				rounds: [
					{ round: 1, messages: [{ sender: "judge", text: "first" }] },
					{ round: 2, messages: [{ sender: "contestant", text: "second" }] },
				],
			},
		],
	});
	for (const problemType of problemTypes) {
		const current = await source.update(created.id, { problemType });
		expect(current.communication).toEqual(configured.communication);
		expect(current.protocolSamples).toEqual(configured.protocolSamples);
		expect(current.statementSections).toEqual(configured.statementSections);
		expect(current.samples).toEqual(configured.samples);
		expect(current.checkerSource).toBe("checker code");
		expect(current.interactorSource).toBe("interactive code");
	}
	const current = await source.get(created.id);
	const copy = await copyProject(source, created.id, target, current.revision);
	expect(copy).toMatchObject({
		problemType: "communication",
		communication: configured.communication,
		protocolSamples: configured.protocolSamples,
		statementSections: configured.statementSections,
	});
	expect(copy.id).not.toBe(created.id);
	expect(await target.database.readBuffer("manual", copy.id, "1.in")).toEqual(Buffer.from("21\n"));
});
it("rejects contradictory fields, obsolete client writes and malformed protocols without saving", async () => {
	const created = await source.create("acm", "communication");
	for (const [input, statusCode] of [
		[{ judgingMode: "default" }, 409],
		[{ checkerMode: "text" }, 409],
		[{ problemType: "communication", judgingMode: "default" }, 422],
		[{ problemType: "standard", checkerMode: "custom" }, 422],
		[{ problemType: "unknown" }, 422],
		[{ communication: { judgeSource: "a", judgeStandard: "python3", secondRound: "interactive" } }, 422],
		[{ communication: { judgeSource: "a", judgeStandard: "cpp17", secondRound: "three" } }, 422],
		[{ statementSections: { ...created.statementSections, communication: 3 } }, 400],
		[
			{ protocolSamples: [{ rounds: [{ round: 1, messages: [{ id: "bad / id", sender: "judge", text: "" }] }] }] },
			422,
		],
		[
			{
				protocolSamples: [
					{
						rounds: [
							{ round: 1, messages: [] },
							{ round: 1, messages: [] },
						],
					},
				],
			},
			422,
		],
	] as const) {
		await expect(source.update(created.id, input)).rejects.toMatchObject({ statusCode });
		expect(await source.get(created.id)).toEqual(created);
	}
	const edited = await source.update(created.id, { title: "Allowed old client metadata" });
	expect(edited.problemType).toBe("communication");
	expect(isProjectSnapshot({ ...edited, statementSections: { ...edited.statementSections, secondRound: 2 } })).toBe(
		false,
	);
});
it("requires complete consistent round results and allows judged first-round failures", () => {
	const round1 = { round: 1 as const, state: "complete" as const, verdict: "AC" as const, score: 0, message: "ok" };
	const round2 = { round: 2 as const, state: "complete" as const, verdict: "AC" as const, score: 100, message: "ok" };
	expect(isCompleteCommunicationResult({ verdict: "AC", score: 100, rounds: [round1, round2] })).toBe(true);
	expect(
		isCompleteCommunicationResult({
			verdict: "WA",
			score: 0,
			failedRound: 1,
			rounds: [
				{ ...round1, verdict: "WA" },
				{ round: 2, state: "skipped", message: "First round failed" },
			],
		}),
	).toBe(true);
	for (const result of [
		{ verdict: "AC" as const, score: 100 },
		{ verdict: "AC" as const, score: 100, rounds: [round1] },
		{ verdict: "AC" as const, score: 100, rounds: [{ ...round1, score: 100 }, round2] },
		{
			verdict: "AC" as const,
			score: 100,
			rounds: [round1, { round: 2 as const, state: "skipped" as const, message: "incomplete" }],
		},
		{ verdict: "WA" as const, score: 0, rounds: [round1, round2] },
	])
		expect(isCompleteCommunicationResult(result)).toBe(false);
});
it("round-trips binary private inputs and rejects truncated, oversized or illegal handoffs", () => {
	const original = Buffer.from("SETDRAFT_COMMUNICATION_2 0 0 0\n\0secret");
	expect(readCommunicationInitialInput(communicationInitialInput(original))).toEqual(original);
	expect(() => readCommunicationInitialInput(Buffer.from("SETDRAFT_COMMUNICATION_1 9\na"))).toThrow();
	const data = Buffer.concat([
		Buffer.from(`SETDRAFT_COMMUNICATION_2 ${original.length} 3 2\n`),
		original,
		Buffer.from([0, 1, 2, 3, 4]),
	]);
	expect(readCommunicationEnvelope(data, 1000)).toEqual({
		original,
		handoff: Buffer.from([0, 1, 2]),
		secondInput: Buffer.from([3, 4]),
	});
	for (const invalid of [
		Buffer.from(""),
		Buffer.from("SETDRAFT_COMMUNICATION_2 0 0 0\nextra"),
		Buffer.from("SETDRAFT_COMMUNICATION_2 0 1048577 0\n"),
		Buffer.from("SETDRAFT_COMMUNICATION_2 -1 0 0\n"),
	])
		expect(() => readCommunicationEnvelope(invalid, 1000)).toThrow();
	expect(() => readCommunicationEnvelope(data, 5)).toThrow("容量");
});
