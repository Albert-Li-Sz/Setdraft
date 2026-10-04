import type { ManualProject } from "./index.ts";
import { cppLanguages } from "./languages.ts";

export type GeneratorLanguage = (typeof cppLanguages)[number] | "python3";
export interface Generator {
	id: string;
	name: string;
	language: GeneratorLanguage;
	code: string;
	remark: string;
}
export interface GeneratorCommand {
	generator: string;
	args: string[];
	line: number;
}
export function isGenerator(value: unknown): value is Generator {
	if (!value || typeof value !== "object") return false;
	const item = value as Record<string, unknown>;
	return (
		typeof item.id === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(item.id) &&
		typeof item.name === "string" &&
		/^gen(?:_[1-9]\d{0,8})?$/u.test(item.name) &&
		[...cppLanguages, "python3"].includes(String(item.language)) &&
		typeof item.code === "string" &&
		item.code.length <= 200_000 &&
		typeof item.remark === "string" &&
		item.remark.length <= 2000
	);
}
/** The legacy single generator is a view of this collection. */
export function projectGenerators(
	project: Pick<ManualProject, "generators" | "generatorSource" | "generatorStandard">,
): Generator[] {
	return (
		project.generators ?? [
			{
				id: "gen",
				name: "gen",
				language: project.generatorStandard ?? "cpp17",
				code: project.generatorSource,
				remark: "",
			},
		]
	);
}
export function nextGeneratorIndex(
	project: Pick<ManualProject, "generators" | "generatorSource" | "generatorStandard" | "generatorSequence">,
): number {
	return Math.max(
		project.generatorSequence ?? 1,
		...projectGenerators(project).map((item) => (item.name === "gen" ? 1 : Number(item.name.slice(4)) + 1)),
	);
}
export function synchronizeGenerators(project: ManualProject): void {
	project.generators = projectGenerators(project);
	project.generatorSequence = nextGeneratorIndex(project);
	const first = project.generators.find((item) => item.name === "gen");
	project.generatorSource = first?.code ?? "";
	project.generatorStandard = first?.language ?? "cpp17";
}
