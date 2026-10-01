import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exportContractVersion } from "@setdraft/contracts";
import { SaxesParser } from "saxes";
import { expect, it } from "vitest";
import { defaultTextChecker } from "../src/acm-checker.ts";
import { exportFileName } from "../src/export-contract.ts";
import { writeLegacyProblemExport } from "../src/legacy-exports.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";

let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}
const repository = fileURLToPath(new URL("../../..", import.meta.url));
const python = process.env.SETDRAFT_QDUOJ_CONTRACT_PYTHON;
const importer = process.env.SETDRAFT_QDUOJ_CONTRACT_ROOT;

function xmlFields(xml: string): Record<string, string> {
	const parser = new SaxesParser();
	const fields: Record<string, string> = {};
	let current = "";
	parser.on("opentag", (node) => {
		current = node.name;
	});
	parser.on("text", (text) => {
		fields[current] = (fields[current] ?? "") + text;
	});
	parser.on("closetag", () => {
		current = "";
	});
	parser.write(xml).close();
	return fields;
}

it.skipIf(!dockerAvailable)(
	"real verified releases import as FPS and native SPJ agrees with testlib for 81 output pairs",
	async () => {
		if (process.env.SETDRAFT_REQUIRE_IMPORTER === "1" && (!python || !importer))
			throw new Error("Pinned QDUOJ importer is required.");
		const root = await mkdtemp(join(tmpdir(), "setdraft-export-contract-"));
		const projects = new ManualProjectStore({ root: join(root, "workspace") });
		try {
			const project = await projects.create("acm");
			await projects.update(project.id, {
				title: "Import contract",
				slug: "import-contract",
				checkerMode: "text",
				statementSections: {
					description: "Sum two integers; keep **original** text.",
					input: "Two integers.",
					output: "Their sum.",
					interaction: "",
					notes: "",
				},
				samples: [{ input: "1 2\n", output: "3\n" }],
				reference: { language: "python3", code: "print(sum(map(int,input().split())))" },
			});
			await projects.addTextCase(project.id, { input: "2 3\n", output: "5\n" });
			const finalized = await projects.pipeline.finalize(project.id);
			expect(finalized.report.success, JSON.stringify(finalized.report.checks)).toBe(true);
			if (!finalized.release) throw new Error("Verified release missing");
			const release = finalized.release;
			const original = await projects.snapshot(project.id);
			const fps = await projects.releases.exportLegacy(release.id, "fps");
			const fields = xmlFields(await readFile(fps.path, "utf8"));
			expect(fields.input).toBe("Two integers.");
			expect(fields.output).toBe("Their sum.");
			expect(fields.description).toContain("**original**");
			await projects.releases.exportLegacy(release.id, "qduoj");
			expect((await projects.releases.release(release.id)).exports).toMatchObject({
				fps: { contractVersion: exportContractVersion },
				qduoj: { contractVersion: exportContractVersion },
			});
			if (python && importer) {
				const result = execFileSync(
					resolve(python),
					[join(repository, "scripts/verify-qduoj-import.py"), resolve(importer), fps.path],
					{ encoding: "utf8", timeout: 30_000 },
				);
				expect(JSON.parse(result)).toMatchObject({ validated: true, problems: 1 });
			}
			// Work only on a separate export fixture, never rewrite the stored source snapshot.
			const stage = join(root, "matrix");
			await cp(projects.releaseDirectory(release.id), stage, { recursive: true });
			const legacy = {
				...original,
				statement: "# Legacy statement\n\nKeep all original wording.",
				statementSections: undefined,
			};
			await writeFile(join(stage, "source/project.json"), JSON.stringify(legacy));
			await rm(join(stage, exportFileName("fps")), { force: true });
			const fallback = await writeLegacyProblemExport(stage, release, "fps");
			expect(xmlFields(await readFile(fallback, "utf8"))).toMatchObject({
				input: "输入要求参见完整题面。",
				output: "输出要求参见完整题面。",
				description: expect.stringContaining("Keep all original wording."),
			});
			if (python && importer)
				execFileSync(
					resolve(python),
					[join(repository, "scripts/verify-qduoj-import.py"), resolve(importer), fallback],
					{ timeout: 30_000 },
				);
			const answers = ["5\n", "5\r\n", "5 \t\n", "5\n\n", "", "6\n", "5 6\n", "中文\n", "5\n6\n"];
			const outputs = ["5\n", "5\r\n\r\n", "5 \t\n", "\ufeff5\n", "\ufeff\ufeff5\n", "ï»¿5\n", "6\n", "", "5\0\n"];
			const data = join(stage, "hydro", release.slug, "testdata");
			await mkdir(data, { recursive: true });
			const cases = [];
			for (const [index, answer] of answers.entries()) {
				const inputFile = `${index + 1}.in`,
					outputFile = `${index + 1}.out`;
				await writeFile(join(data, inputFile), "2 3\n");
				await writeFile(join(data, outputFile), answer);
				cases.push({ inputFile, outputFile });
			}
			for (const [index, output] of outputs.entries()) await writeFile(join(data, `actual-${index}.out`), output);
			await writeFile(join(stage, "source/manifest.json"), JSON.stringify({ cases }));
			await rm(join(stage, exportFileName("fps")), { force: true });
			const matrixFps = await writeLegacyProblemExport(stage, release, "fps");
			await writeFile(join(data, "native.cc"), xmlFields(await readFile(matrixFps, "utf8")).spj);
			await writeFile(join(data, "local.cc"), defaultTextChecker);
			await copyFile(join(repository, "packages/hydro-server/sandbox/testlib/testlib.h"), join(data, "testlib.h"));
			const comparison = `import json,subprocess\nrows=[]\nfor answer in range(1,10):\n for output in range(9):\n  native=subprocess.run(['./native',f'{answer}.in',f'actual-{output}.out'],capture_output=True).returncode\n  local=subprocess.run(['./local',f'{answer}.in',f'actual-{output}.out',f'{answer}.out'],capture_output=True).returncode\n  rows.append([answer,output,native==0,local==0])\nprint(json.dumps(rows))`;
			await writeFile(join(data, "compare.py"), comparison);
			const result = execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--network",
					"none",
					"--mount",
					`type=bind,source=${data},target=/work`,
					"--workdir",
					"/work",
					"setdraft/sandbox:local",
					"sh",
					"-c",
					"g++ -std=c++17 -fsanitize=undefined native.cc -o native && g++ -std=c++17 -I. local.cc -o local && python3 compare.py",
				],
				{ encoding: "utf8", timeout: 60_000 },
			);
			const rows = JSON.parse(result) as Array<[number, number, boolean, boolean]>;
			expect(rows).toHaveLength(81);
			for (const [answer, output, native, local] of rows)
				expect(native, `answer ${answer}, output ${output}`).toBe(local);
			expect(rows.find(([answer, output]) => answer === 1 && output === 3)?.[2]).toBe(true);
			expect(await projects.snapshot(project.id)).toEqual(original);
		} finally {
			projects.database.sql.close();
			await rm(root, { recursive: true, force: true });
		}
	},
	120_000,
);
