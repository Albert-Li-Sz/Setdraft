import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";

let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}

it.skipIf(!dockerAvailable).each([
	["numeric", "1", "ouf.readInt(1, 2000000000);"],
	[
		"text",
		"ALPHA",
		'std::string token = ouf.readToken(); if (token != "ALPHA" && token != "__hydro_invalid_output__") quitf(_wa, "not a legal word");',
	],
])(
	"publishes and exports a valid %s multi-answer checker even when an automatic probe is a valid answer",
	async (_kind, output, validation) => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-multiple-answers-"));
		const projects = new ManualProjectStore({ root, image: "setdraft/sandbox:local" });
		try {
			const project = await projects.create("acm");
			await projects.update(project.id, {
				title: "Many valid answers",
				slug: "many-answers",
				statement: "# Many valid answers\n\nOutput any legal value.",
				reference: { language: "python3", code: `print(${JSON.stringify(output)})` },
				checkerMode: "custom",
				checkerSource: `#include "testlib.h"\nint main(int argc,char**argv){registerTestlibCmd(argc,argv);${validation}ouf.skipBlanks();ouf.readEof();quitf(_ok,"valid answer");}`,
			});
			await projects.addTextCase(project.id, { input: "21\n" });
			const result = await projects.pipeline.finalize(project.id);
			expect(result.report.success, JSON.stringify(result.report.checks)).toBe(true);
			expect(result.release).toBeTruthy();
			if (!result.release) throw new Error("Release missing");
			expect((await projects.releases.exportDomjudge(result.release.id)).size).toBeGreaterThan(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
