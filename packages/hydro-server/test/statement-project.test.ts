import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHydroStatement } from "@setdraft/authoring/statement";
import { isProjectSnapshot, type ManualVerificationReport } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

let root: string;
let projects: ManualProjectStore;
const sections = {
	description: "Sum two integers.",
	input: "Two integers.",
	output: "Their sum.",
	interaction: "Inactive protocol.",
	notes: "Use integers.",
	communication: "",
	firstRound: "",
	secondRound: "",
};
let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-statement-project-"));
	projects = new ManualProjectStore({ root });
});
afterEach(async () => {
	projects.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

it("persists sections, serializes active Markdown, and preserves inactive fields across mode changes", async () => {
	const created = await projects.create("acm");
	expect(created.statementSections).toEqual({
		description: "",
		input: "",
		output: "",
		interaction: "",
		notes: "",
		communication: "",
		firstRound: "",
		secondRound: "",
	});
	const ordinary = await projects.update(created.id, {
		statementSections: sections,
		samples: [{ input: "1 2", output: "3" }],
	});
	expect(ordinary.statement).toBe(formatHydroStatement(ordinary));
	expect(ordinary.statement).toContain("Two integers.");
	expect(ordinary.statement).not.toContain("Inactive protocol.");
	expect(isProjectSnapshot(ordinary)).toBe(true);
	const interactive = await projects.update(created.id, { judgingMode: "interactive", interactionInputMode: "empty" });
	expect(interactive.statementSections).toEqual(sections);
	expect(interactive.statement).toContain("Inactive protocol.");
	expect(interactive.statement).not.toContain("Two integers.");
	const restored = await projects.update(created.id, { judgingMode: "default" });
	expect(restored.statement).toBe(ordinary.statement);
	expect((await projects.snapshot(created.id)).statementSections).toEqual(sections);
});

it("rejects malformed or oversized structured statements atomically", async () => {
	const created = await projects.create("acm");
	for (const invalid of [
		null,
		[],
		{},
		{ ...sections, notes: 1 },
		{ ...sections, description: "x".repeat(1_000_001) },
		{ ...sections, description: "x".repeat(600_000), input: "x".repeat(400_001) },
	]) {
		await expect(projects.update(created.id, { statementSections: invalid })).rejects.toThrow();
		expect(await projects.snapshot(created.id)).toEqual(created);
	}
	expect(isProjectSnapshot({ ...created, statementSections: { ...sections, notes: 1 } })).toBe(false);
});

it("recomputes redundant legacy text for structured autosave even when combined samples exceed its old limit", async () => {
	const created = await projects.create("acm");
	const updated = await projects.update(created.id, {
		statementSections: { ...sections, description: "x".repeat(900_000) },
		samples: [{ input: "x".repeat(100_000), output: "0" }],
	});
	expect(updated.statement.length).toBeGreaterThan(1_000_000);
	const saved = await projects.update(created.id, {
		statement: updated.statement,
		statementSections: updated.statementSections,
		samples: updated.samples,
		expectedRevision: updated.revision,
	});
	expect(saved.statement).toBe(updated.statement);
});

it("invalidates old verification for section and legacy edits, and honors optimistic revisions", async () => {
	const created = await projects.create("acm");
	const project = await projects.load(created.id);
	const report: ManualVerificationReport = {
		mode: "finalize",
		success: true,
		checks: [],
		caseCount: 1,
		generatedCount: 0,
		oracleCount: 0,
		validatorUsed: false,
		checkerUsed: true,
		revision: project.revision,
		projectHash: "old-hash",
		issues: [],
		verifiedAt: new Date().toISOString(),
	};
	project.lastReport = report;
	await projects.save(project);
	const updated = await projects.update(created.id, {
		statementSections: sections,
		expectedRevision: created.revision,
	});
	expect(updated.lastReport).toBeUndefined();
	expect(updated.revision).toBe(created.revision + 1);
	await expect(
		projects.update(created.id, { statementSections: sections, expectedRevision: created.revision }),
	).rejects.toMatchObject({ statusCode: 409 });
	const current = await projects.load(created.id);
	current.lastReport = { ...report, revision: current.revision };
	await projects.save(current);
	const legacy = await projects.update(created.id, { statement: "# Legacy full statement\n\nKeep this text." });
	expect(legacy.statementSections).toBeUndefined();
	expect(legacy.statement).toBe("# Legacy full statement\n\nKeep this text.");
	expect(legacy.lastReport).toBeUndefined();
});

it.skipIf(!dockerAvailable)(
	"publishes the active structured statement and includes inactive fields in the content fingerprint",
	async () => {
		const created = await projects.create("acm");
		await projects.update(created.id, {
			title: "Sum",
			slug: "sum",
			statementSections: sections,
			samples: [{ input: "1 2\n", output: "3\n" }],
			reference: { language: "python3", code: "print(sum(map(int, input().split())))" },
		});
		await projects.addTextCase(created.id, { input: "2 3\n", output: "5\n" });
		const first = await projects.pipeline.finalize(created.id);
		expect(first.report.success, JSON.stringify(first.report.checks)).toBe(true);
		if (!first.release) throw new Error("Expected a release");
		const statement = await readFile(
			join(projects.releaseDirectory(first.release.id), "hydro", "sum", "problem_zh.md"),
			"utf8",
		);
		expect(statement).toBe(formatHydroStatement(await projects.snapshot(created.id)));
		expect(statement).toContain("```input1");
		expect(statement).not.toContain(sections.interaction);
		await projects.update(created.id, {
			statementSections: { ...sections, interaction: "Different inactive protocol." },
		});
		const second = await projects.pipeline.finalize(created.id);
		expect(second.report.success, JSON.stringify(second.report.checks)).toBe(true);
		expect(second.report.projectHash).not.toBe(first.report.projectHash);
		expect(second.report.revision).toBe(first.report.revision + 1);
	},
	90_000,
);
