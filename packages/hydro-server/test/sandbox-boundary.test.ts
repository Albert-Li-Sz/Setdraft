import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { runManualSandbox } from "../src/manual-sandbox.ts";

const dockerAvailable = (() => {
	try {
		execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
})();
let root: string;
let projects: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-boundary-"));
	projects = new ManualProjectStore({ root, image: "setdraft/sandbox:local" });
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const checker = (attack: string) => `#include "testlib.h"
#include <filesystem>
#include <fstream>
#include <unistd.h>
int main(int argc, char** argv) {
 registerTestlibCmd(argc, argv);
 int expected = ans.readInt(), actual = ouf.readInt();
 if (actual != expected) {
  char cwd[4096]; getcwd(cwd, sizeof(cwd));
  if (std::string(cwd).find("negative-value") != std::string::npos) { ${attack} }
  quitf(_wa, "wrong");
 }
 quitf(_ok, "correct");
}`;

async function problem(source: string) {
	const created = await projects.create("acm");
	await projects.addTextCase(created.id, { input: "1\n" });
	await projects.update(created.id, {
		title: "Boundary",
		slug: "boundary",
		statement: "Print one.",
		reference: { language: "python3", code: "print(1)" },
		checkerMode: "custom",
		checkerSource: source,
	});
	return created.id;
}

it.skipIf(!dockerAvailable).each(["leaf", "parent"] as const)(
	"rejects a successful Checker's %s symlink before publishing",
	async (kind) => {
		const outside = join(root, "private");
		await mkdir(outside);
		await writeFile(join(outside, "1.out"), "PRIVATE HOST CONTENT\n");
		const attack =
			kind === "leaf"
				? `std::filesystem::remove("/work/verified/1.out"); std::filesystem::create_symlink(${JSON.stringify(join(outside, "1.out"))}, "/work/verified/1.out");`
				: `std::filesystem::remove_all("/work/verified"); std::filesystem::create_directory_symlink(${JSON.stringify(outside)}, "/work/verified");`;
		const id = await problem(checker(attack));
		if (kind === "leaf") await expect(projects.pipeline.finalize(id)).rejects.toThrow("普通文件");
		else
			await expect(projects.pipeline.finalize(id)).rejects.toMatchObject({
				code: expect.stringMatching(/ELOOP|ENOTDIR/u),
			});
		expect((await projects.get(id)).lastReport?.success).toBe(true);
		expect(await projects.releases.listReleases()).toHaveLength(0);
		expect(await readFile(join(outside, "1.out"), "utf8")).toBe("PRIVATE HOST CONTENT\n");
	},
	30_000,
);

it.skipIf(!dockerAvailable)(
	"ignores a substituted event FIFO and rejects a substituted result device link",
	async () => {
		const input = join(root, "1.in");
		await writeFile(input, "1\n");
		const options = {
			mode: "finalize" as const,
			stage: join(root, "stage"),
			image: "setdraft/sandbox:local",
			reference: { language: "python3" as const, code: "import os\nos.mkfifo('/work/events.jsonl')\nprint(1)" },
			generatorStandard: "cpp17" as const,
			checkerStandard: "cpp17" as const,
			validatorStandard: "cpp17" as const,
			cases: [{ id: "1", inputPath: input, outputName: "1.out" }],
			timeLimitMs: 1000,
			memoryLimitMb: 256,
			maxFileBytes: 1024 * 1024,
		};
		expect((await runManualSandbox(options)).success).toBe(true);
		await expect(
			runManualSandbox({
				...options,
				stage: join(root, "device"),
				reference: {
					language: "python3",
					code: "import os\nos.symlink('/dev/zero', '/work/result.json')\nprint(1)",
				},
			}),
		).rejects.toThrow("普通文件");
	},
	20_000,
);

it.skipIf(!dockerAvailable)(
	"exports immutable sources and data even when the DOMjudge Checker edits its working copy",
	async () => {
		const source = checker("").replace(
			"registerTestlibCmd(argc, argv);",
			'registerTestlibCmd(argc, argv); std::ofstream("checker.cc") << "UNVERIFIED SOURCE"; std::ofstream("/package/data/secret/001.in") << "UNVERIFIED DATA";',
		);
		const id = await problem(source);
		const published = await projects.pipeline.finalize(id);
		expect(published.report.success, JSON.stringify(published.report.checks)).toBe(true);
		if (!published.release) throw new Error("Expected release");
		const exported = await projects.releases.exportDomjudge(published.release.id);
		expect(
			execFileSync("unzip", ["-p", exported.path, "output_validators/checker/checker.cc"], { encoding: "utf8" }),
		).toBe(source);
		expect(execFileSync("unzip", ["-p", exported.path, "data/secret/001.in"], { encoding: "utf8" })).toBe("1\n");
	},
	45_000,
);

it.skipIf(!dockerAvailable).each(["fps", "qduoj"] as const)(
	"rejects incomplete %s exports containing attachment references",
	async (format) => {
		const id = await problem(checker(""));
		await projects.update(id, {
			checkerMode: "text",
			statement: "![figure](file://diagram.svg)",
			attachments: [
				{
					name: "diagram.svg",
					contentBase64: Buffer.from(
						'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"></svg>',
					).toString("base64"),
				},
			],
		});
		const published = await projects.pipeline.finalize(id);
		if (!published.release) throw new Error("Expected release");
		await expect(projects.releases.exportLegacy(published.release.id, format)).rejects.toThrow("题面附件引用");
	},
	30_000,
);
