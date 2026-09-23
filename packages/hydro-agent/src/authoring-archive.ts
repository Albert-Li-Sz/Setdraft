import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildStoredArchive } from "@hydro-problem-make/authoring";
import type { HydroReferenceProgram } from "./sandbox.ts";
import { loadAuthoringEvidence } from "./workspace.ts";

/** The directory comes from the run manager, never from a user-supplied path. */
export async function buildAuthoringArchive(
	artifactDirectory: string,
	runId: string,
	verificationId: string,
	context: { source?: string; model?: string } = {},
): Promise<Uint8Array> {
	const workspaceRoot = resolve(artifactDirectory, "../../../..");
	const evidence = await loadAuthoringEvidence(workspaceRoot, runId, verificationId);
	const files = new Map<string, Uint8Array>();
	const add = (path: string, content: string): void => {
		files.set(path, Buffer.from(content));
	};
	const program = (role: string, source: HydroReferenceProgram): void => {
		const name = source.language === "cpp17" ? "main.cc" : source.language === "java" ? "Main.java" : "main.py";
		add(`${role}/${name}`, source.code);
	};
	program("reference", evidence.project.reference);
	program("oracle", evidence.project.oracle);
	if (evidence.project.queryLimitProbe) program("query-limit-probe", evidence.project.queryLimitProbe);
	for (const [index, item] of evidence.project.wrongPrograms.entries()) program(`wrong-${index + 1}`, item.program);
	add("generator.cc", evidence.project.generator);
	add("validator.cc", evidence.project.validator);
	if (evidence.project.checker) add("checker.cc", evidence.project.checker);
	if (evidence.project.interactor) add("interactor.cc", evidence.project.interactor);
	add("analysis.md", evidence.project.analysis);
	if (context.source) add("original-statement.md", context.source);
	add("project.json", JSON.stringify(evidence.project, null, 2));
	add(
		"report.json",
		JSON.stringify(
			{
				...evidence.report,
				cases: evidence.report.cases.map(({ input, output, ...item }) => ({
					...item,
					inputBytes: Buffer.byteLength(input),
					outputBytes: Buffer.byteLength(output),
				})),
			},
			null,
			2,
		),
	);
	for (const item of evidence.report.cases) {
		add(`data/${item.id}.in`, item.input);
		add(`data/${item.id}.out`, item.output);
	}
	files.set("testlib.h", await readFile(new URL("../sandbox/testlib/testlib.h", import.meta.url)));
	files.set("testlib-LICENSE.txt", await readFile(new URL("../sandbox/testlib/LICENSE", import.meta.url)));
	add(
		"README.md",
		`# 制题工程\n\n包含标程、独立对拍程序、testlib 生成器与输入校验器、可选 SPJ、固定参数与数据、验证报告。\n\nproject.json 中的 cases 记录 generatorArgs（包括种子）及验证限制。\n编译生成器：g++ -std=c++17 -O2 -I. generator.cc -o generator\n编译校验器：g++ -std=c++17 -O2 -I. validator.cc -o validator\n按各测试点 generatorArgs 运行生成器；使用 validator < data/测试点.in 校验输入。\nC++ SPJ 参数顺序：checker 输入文件 选手输出文件 标准输出文件。\n\ntestlib 固定提交：1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd。\n本地验证不等于真实 Hydro 实例导入评测，也不是算法正确性的形式化证明。\n`,
	);
	add(
		"manifest.json",
		JSON.stringify(
			{
				runId,
				verificationId,
				draftRevision: evidence.summary.revision,
				problemType: evidence.project.type ?? "default",
				model: context.model,
				sourceSha256: context.source ? createHash("sha256").update(context.source).digest("hex") : undefined,
				skillVersion: "hydro-problem-authoring/2",
				toolchain: evidence.report.toolchain,
				seeds: Object.fromEntries(
					evidence.project.cases.filter((item) => item.generatorArgs).map((item) => [item.id, item.generatorArgs]),
				),
				testlibCommit: "1e4e8a24c79c6bad3becbdb5a332ffc352b7d5dd",
				sha256: Object.fromEntries(
					[...files].map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")]),
				),
			},
			null,
			2,
		),
	);
	return buildStoredArchive(`${runId}-authoring`, files);
}
