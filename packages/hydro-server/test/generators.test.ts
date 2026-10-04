import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Generator, nextGeneratorIndex, projectGenerators } from "@setdraft/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ManualProjectStore, parseGeneratorScript } from "../src/manual-projects.ts";
import { sandboxIt } from "./sandbox-test.ts";

let root: string;
let store: ManualProjectStore;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-generators-"));
	store = new ManualProjectStore({ root });
});
afterEach(async () => {
	store.database.sql.close();
	await rm(root, { recursive: true, force: true });
});
const gen = (
	name: string,
	language: Generator["language"] = "python3",
	code = "import sys\nprint(sys.argv[1], 2)",
): Generator => ({ id: name.replaceAll("_", "-"), name, language, code, remark: `${name} note` });

it("parses numbered aliases and quoted literal parameters without permitting shell syntax", () => {
	expect(parseGeneratorScript("# shared\ngen 'two words'\ngen_2 7 # note")).toEqual([
		{ generator: "gen", args: ["two words"], line: 2 },
		{ generator: "gen_2", args: ["7"], line: 3 },
	]);
	for (const source of [
		"gen_0 1",
		"gen_01 1",
		"python gen.py",
		"gen_1 $HOME",
		"gen_2 1 | cat",
		"gen_1 $(date)",
		"gen_1 1 > output.in",
	])
		expect(() => parseGeneratorScript(source)).toThrow();
});
it("migrates the legacy generator, keeps numbering monotonic and guards referenced deletion", async () => {
	const project = await store.create("acm");
	const legacy = await store.update(project.id, { generatorSource: "print(1)", generatorStandard: "python3" });
	expect(projectGenerators(legacy)[0]).toMatchObject({ name: "gen", language: "python3", code: "print(1)" });
	await store.update(project.id, {
		generators: [...projectGenerators(legacy), gen("gen_1"), gen("gen_2")],
		generatorScript: "gen_2 7",
	});
	await expect(store.update(project.id, { generators: [projectGenerators(legacy)[0], gen("gen_1")] })).rejects.toThrow(
		"引用",
	);
	const removed = await store.update(project.id, {
		generators: [projectGenerators(legacy)[0], gen("gen_1")],
		generatorScript: "gen 1",
	});
	expect(nextGeneratorIndex(removed)).toBe(3);
	await expect(
		store.update(project.id, { generators: [...projectGenerators(removed), gen("gen_2")] }),
	).rejects.toThrow("复用");
	const added = await store.update(project.id, { generators: [...projectGenerators(removed), gen("gen_3")] });
	expect(nextGeneratorIndex(added)).toBe(4);
	await expect(
		store.update(project.id, { generators: projectGenerators(added), generatorSource: "other" }),
	).rejects.toThrow("同时");
	await store.update(project.id, { generators: [], generatorScript: "" });
	await expect(store.update(project.id, { generators: [gen("gen")] })).rejects.toThrow("复用");
});
it("keeps remarks out of generation freshness but invalidates source changes", async () => {
	const project = await store.create("acm");
	const current = await store.update(project.id, {
		generators: [gen("gen"), gen("gen_1")],
		generatorScript: "gen 1\ngen_1 2",
	});
	const hash = await store.pipeline.generatedHash(project.id, current, []);
	const remarked = await store.update(project.id, {
		generators: projectGenerators(current).map((item) => ({ ...item, remark: "changed" })),
	});
	expect(await store.pipeline.generatedHash(project.id, remarked, [])).toBe(hash);
	const edited = await store.update(project.id, {
		generators: projectGenerators(remarked).map((item) => ({ ...item, code: `${item.code}\n# edited` })),
	});
	expect(await store.pipeline.generatedHash(project.id, edited, [])).not.toBe(hash);
});
sandboxIt(
	"mixes Python and C++ generators through one script, compiling only referenced generators once",
	async () => {
		const project = await store.create("acm");
		await store.update(project.id, {
			title: "Multiple generators",
			slug: "multiple-generators",
			statement: "Add integers.",
			checkerMode: "text",
			reference: { language: "python3", code: "print(sum(map(int,input().split())))" },
			generators: [
				gen("gen"),
				gen(
					"gen_1",
					"cpp17",
					'#include <iostream>\nint main(int argc,char**argv){std::cout << argv[1] << " 3\\n";}',
				),
				gen("gen_2", "python3", "invalid syntax!"),
			],
			generatorScript: "gen 7\ngen_1 8\ngen 9",
		});
		const result = await store.pipeline.generate(project.id);
		expect(result.report.success, JSON.stringify(result.report)).toBe(true);
		expect(result.project.cases.map((item) => item.inputFile)).toEqual(["1.in", "2.in", "3.in"]);
		expect(
			result.report.checks.filter((item) => item.stage.startsWith("compile:gen")).map((item) => item.stage),
		).toEqual(["compile:gen", "compile:gen_1"]);
		for (const [name, input, answer] of [
			["1", "7 2\n", "9\n"],
			["2", "8 3\n", "11\n"],
			["3", "9 2\n", "11\n"],
		]) {
			expect(await readFile(await store.dataFile(project.id, "generated", `${name}.in`), "utf8")).toBe(input);
			expect(await readFile(await store.dataFile(project.id, "generated", `${name}.out`), "utf8")).toBe(answer);
		}
		const fresh = await store.get(project.id);
		await store.update(project.id, {
			generators: projectGenerators(fresh).map((item) => ({ ...item, remark: "updated remark" })),
		});
		await expect(store.runs.validate(project.id, { kind: "matrix" })).resolves.toBeUndefined();
		await store.update(project.id, {
			generators: projectGenerators(fresh).map((item) =>
				item.name === "gen" ? { ...item, code: "import time\nprint(time.time_ns())" } : item,
			),
			generatorScript: "gen 7",
		});
		const failed = await store.pipeline.generate(project.id);
		expect(failed.report.success).toBe(false);
		expect(failed.report.checks.some((item) => !item.passed && item.message.includes("不一致"))).toBe(true);
		expect((await store.get(project.id)).cases).toHaveLength(3);
	},
	90000,
);
sandboxIt(
	"reports Python syntax errors without replacing previously generated data",
	async () => {
		const project = await store.create("acm");
		await store.update(project.id, {
			reference: { language: "python3", code: "print(3)" },
			generators: [gen("gen", "python3", "def broken(:")],
			generatorScript: "gen 1",
		});
		const result = await store.pipeline.generate(project.id);
		expect(result.report.success).toBe(false);
		expect(result.report.checks).toContainEqual(
			expect.objectContaining({ stage: "compile:gen", passed: false, verdict: "CE" }),
		);
		expect(result.project.cases).toHaveLength(0);
	},
	30000,
);
