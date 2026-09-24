import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { stringify } from "yaml";
import type { HydroJudgeLimits, HydroProblemSpec } from "./types.ts";
import { assertValidHydroProblemSpec } from "./validation.ts";

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}

function asBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

function serializeYaml(value: unknown): string {
	return stringify(value, { indent: 2, lineWidth: 0 });
}

function comparePath(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export function buildHydroProblemFiles(
	spec: HydroProblemSpec,
	judgeLimits?: HydroJudgeLimits,
): ReadonlyMap<string, Uint8Array> {
	assertValidHydroProblemSpec(spec, judgeLimits);
	const files = new Map<string, Uint8Array>();
	const metadata: Record<string, unknown> = { title: spec.title };
	if (spec.pid !== undefined) metadata.pid = spec.pid;
	metadata.tag = [...spec.tags];
	files.set("problem.yaml", asBytes(serializeYaml(metadata)));
	files.set(`problem_${spec.language}.md`, asBytes(ensureTrailingNewline(spec.statement)));

	const config = {
		type: spec.type ?? "default",
		...(spec.multiPass ? { multi_pass: spec.multiPass } : {}),
		...(spec.type === "submit_answer" && spec.answerMode === "multi" ? { subType: "multi" } : {}),
		...(spec.type === "interactive" ? { interactor: "interactor.cc" } : {}),
		checker_type: spec.checker?.type ?? "default",
		...(spec.checker ? { checker: "checker.cc" } : {}),
		time: spec.timeLimit,
		memory: spec.memoryLimit,
		subtasks: spec.subtasks.map((subtask) => {
			const output: Record<string, unknown> = {
				id: subtask.id,
				type: subtask.type,
				score: subtask.score,
			};
			if (subtask.timeLimit !== undefined) output.time = subtask.timeLimit;
			if (subtask.memoryLimit !== undefined) output.memory = subtask.memoryLimit;
			if (subtask.dependsOn !== undefined && subtask.dependsOn.length > 0) output.if = [...subtask.dependsOn];
			output.cases = subtask.cases.map((testCase) => {
				const testConfig: Record<string, unknown> = {
					input: testCase.inputFile,
					output: testCase.outputFile,
				};
				if (testCase.timeLimit !== undefined) testConfig.time = testCase.timeLimit;
				if (testCase.memoryLimit !== undefined) testConfig.memory = testCase.memoryLimit;
				return testConfig;
			});
			return output;
		}),
	};
	files.set("testdata/config.yaml", asBytes(serializeYaml(config)));
	if (spec.checker) files.set("testdata/checker.cc", asBytes(spec.checker.source));
	if (spec.type === "interactive" && spec.interactor) files.set("testdata/interactor.cc", asBytes(spec.interactor));
	for (const subtask of spec.subtasks) {
		for (const testCase of subtask.cases) {
			files.set(`testdata/${testCase.inputFile}`, asBytes(testCase.input));
			files.set(`testdata/${testCase.outputFile}`, asBytes(testCase.output));
		}
	}
	for (const attachment of [...(spec.attachments ?? [])].sort((a, b) => comparePath(a.name, b.name))) {
		files.set(`additional_file/${attachment.name}`, asBytes(attachment.content));
	}
	return files;
}

export async function writeHydroProblemDirectory(
	spec: HydroProblemSpec,
	destination: string,
	judgeLimits?: HydroJudgeLimits,
): Promise<string> {
	const destinationRoot = resolve(destination);
	await mkdir(destinationRoot, { recursive: true });
	const stagingRoot = await mkdtemp(join(destinationRoot, `.${spec.slug}-`));
	const targetRoot = join(destinationRoot, spec.slug);
	try {
		for (const [relativePath, content] of [...buildHydroProblemFiles(spec, judgeLimits)].sort(([left], [right]) =>
			comparePath(left, right),
		)) {
			const outputPath = join(stagingRoot, relativePath);
			await mkdir(dirname(outputPath), { recursive: true });
			await writeFile(outputPath, content, { flag: "wx" });
		}
		await rename(stagingRoot, targetRoot);
		return targetRoot;
	} catch (error) {
		await rm(stagingRoot, { recursive: true, force: true });
		throw error;
	}
}
