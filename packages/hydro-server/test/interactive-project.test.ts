import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContestReadyRelease, isProjectSnapshot } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { runInteractiveSandbox } from "../src/interactive-sandbox.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { restoreProject } from "../src/project-history.ts";

let root: string;
let projects: ManualProjectStore;
let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}
const sandboxIt = it.skipIf(!dockerAvailable);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-interactive-project-"));
	projects = new ManualProjectStore({ root, image: "setdraft/sandbox:local" });
});

sandboxIt.each(["acm", "oi"] as const)(
	"publishes one strictly empty %s interactive case and restores inactive original data",
	async (scoringMode) => {
		const created = await projects.create(scoringMode);
		await projects.addTextCase(created.id, { input: "secret original\n", output: "old answer\n" });
		await projects.update(created.id, {
			title: "Interactive doubling",
			slug: "interactive-doubling",
			statement: "Read a challenge and return twice its value.",
			judgingMode: "interactive",
			interactionInputMode: "empty",
			checkerMode: "custom",
			checkerSource: "",
			interactorSource:
				'#include "testlib.h"\n#include <iostream>\nint main(int argc, char* argv[]) { registerInteraction(argc, argv); if (!inf.eof()) quitf(_fail, "input must be empty"); std::cout << 21 << std::endl; if (ouf.readInt() != 42) quitf(_wa, "wrong"); quitf(_ok, "correct"); }',
			interactorStandard: "cpp20",
			reference: { language: "python3", code: "print(int(input()) * 2, flush=True)" },
			generatorScript: "inactive and deliberately invalid",
			validatorSource: "inactive validator",
		});
		const result = await projects.pipeline.finalize(created.id);
		expect(result.report).toMatchObject({
			success: true,
			interactorUsed: true,
			checkerUsed: false,
			caseCount: 1,
			validatorUsed: false,
		});
		if (!result.release) throw new Error("Expected a release");
		expect(isContestReadyRelease(result.release)).toBe(true);
		const contests = new ContestStore(projects);
		const contest = await contests.create({ title: "Interaction", slug: "interaction" });
		await contests.update(contest.id, {
			title: contest.title,
			slug: contest.slug,
			releaseIds: [result.release.id],
			colors: {},
		});
		expect((await contests.export(contest.id, "hydro")).problems).toHaveLength(1);
		if (scoringMode === "oi") await expect(projects.releases.exportDomjudge(result.release.id)).rejects.toThrow();
		const released = projects.releaseDirectory(result.release.id);
		const config = await readFile(join(released, "hydro", "interactive-doubling", "testdata", "config.yaml"), "utf8");
		expect(config).toContain("type: interactive");
		expect(config).toContain("lang: cc.cc20");
		expect(config).not.toContain("multi_pass");
		expect(
			await readFile(join(released, "hydro", "interactive-doubling", "testdata", "interactive-empty.in")),
		).toHaveLength(0);
		expect(
			await readFile(join(released, "hydro", "interactive-doubling", "testdata", "interactive-empty.out")),
		).toHaveLength(0);
		const edited = await projects.update(created.id, {
			interactionInputMode: "provided",
			interactorSource: "changed",
		});
		expect(edited.lastReport).toBeUndefined();
		const restored = await restoreProject(projects, created.id, result.release.id, edited.revision);
		expect(restored).toMatchObject({
			judgingMode: "interactive",
			interactionInputMode: "empty",
			interactorStandard: "cpp20",
		});
		expect(await readFile(await projects.dataFile(created.id, "manual", "1.in"), "utf8")).toBe("secret original\n");
	},
	90_000,
);

sandboxIt(
	"exports private-input interaction as a DOMjudge executable without public sample cases",
	async () => {
		const created = await projects.create("acm");
		await projects.addTextCase(created.id, { input: "21\n" });
		await projects.update(created.id, {
			title: "Private input",
			slug: "private-input",
			statement: "Double the challenge.",
			judgingMode: "interactive",
			interactionInputMode: "provided",
			interactorSource:
				'#include "testlib.h"\n#include <iostream>\nint main(int argc, char* argv[]) { registerInteraction(argc, argv); int challenge = inf.readInt(); std::cout << challenge << std::endl; if (ouf.readInt() != challenge * 2) quitf(_wa, "wrong"); quitf(_ok, "correct"); }',
			reference: {
				language: "java",
				code: "import java.util.Scanner; public class Main { public static void main(String[] args) { Scanner scanner = new Scanner(System.in); System.out.println(scanner.nextInt() * 2); System.out.flush(); } }",
			},
			samples: [{ input: "explanatory transcript", output: "not an answer" }],
		});
		const result = await projects.pipeline.finalize(created.id);
		expect(result.report.success, JSON.stringify(result.report.checks)).toBe(true);
		if (!result.release) throw new Error("Expected a release");
		const exported = await projects.releases.exportDomjudge(result.release.id);
		const entries = execFileSync("unzip", ["-Z1", exported.path], { encoding: "utf8" });
		expect(entries).toContain("output_validators/interactor/build");
		expect(entries).toContain("output_validators/interactor/run");
		expect(entries).not.toContain("data/sample/");
		expect(execFileSync("unzip", ["-p", exported.path, "problem.yaml"], { encoding: "utf8" })).toContain(
			"validation: custom interactive",
		);
		expect(execFileSync("unzip", ["-p", exported.path, "data/secret/001.in"], { encoding: "utf8" })).toBe("21\n");
		expect(execFileSync("unzip", ["-p", exported.path, "data/secret/001.ans"])).toHaveLength(0);
		await expect(projects.releases.exportLegacy(result.release.id, "fps")).rejects.toThrow();
		const adapter = {
			build: execFileSync("unzip", ["-p", exported.path, "output_validators/interactor/build"], {
				encoding: "utf8",
			}),
			run: execFileSync("unzip", ["-p", exported.path, "output_validators/interactor/run"], { encoding: "utf8" }),
			testlibPath: join(projects.releaseDirectory(result.release.id), "source", "testlib", "testlib.h"),
		};
		const current = await projects.get(created.id);
		for (const [label, code, verdict] of [
			["wrong", current.interactorSource ?? "", "WA"],
			[
				"jury-error",
				(current.interactorSource ?? "").replace('quitf(_wa, "wrong")', 'quitf(_fail, "jury exception")'),
				"SYSTEM_ERROR",
			],
		] as const) {
			const check = await runInteractiveSandbox(
				{
					mode: "finalize",
					stage: join(root, label),
					image: "setdraft/sandbox:local",
					reference: { language: "python3", code: "input(); print(0, flush=True)" },
					interactor: { language: "cpp17", code },
					generatorStandard: "cpp17",
					checkerStandard: "cpp17",
					validatorStandard: "cpp17",
					timeLimitMs: 1000,
					memoryLimitMb: 256,
					maxFileBytes: 1024 * 1024,
					cases: [
						{ id: "1", inputPath: await projects.dataFile(created.id, "manual", "1.in"), outputName: "1.out" },
					],
				},
				adapter,
			);
			expect(check.checks).toContainEqual(expect.objectContaining({ stage: "interaction:reference", verdict }));
		}
	},
	90_000,
);

afterEach(async () => {
	projects.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

it("persists interactive settings and preserves uploaded data when switching input modes", async () => {
	const created = await projects.create("acm");
	await projects.addTextCase(created.id, { input: "7\n", output: "old answer\n" });
	const configured = await projects.update(created.id, {
		judgingMode: "interactive",
		interactionInputMode: "empty",
		interactorSource: "registerInteraction(argc, argv);",
		interactorStandard: "cpp20",
	});
	expect(configured).toMatchObject({
		judgingMode: "interactive",
		interactionInputMode: "empty",
		interactorSource: "registerInteraction(argc, argv);",
		interactorStandard: "cpp20",
	});
	expect(isProjectSnapshot(configured)).toBe(true);
	const restored = await projects.update(created.id, { interactionInputMode: "provided" });
	expect(restored.cases).toMatchObject([{ inputFile: "1.in", outputFile: "1.out" }]);
	expect(await projects.database.readBuffer("manual", created.id, "1.in")).toEqual(Buffer.from("7\n"));
});
