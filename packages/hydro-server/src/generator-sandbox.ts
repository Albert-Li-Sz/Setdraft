import type { Generator, GeneratorCommand } from "@setdraft/contracts";
import type { SandboxInput } from "./manual-sandbox.ts";

export function sandboxGenerators(input: SandboxInput): Generator[] {
	return (
		input.generators ??
		(input.generator
			? [{ id: "gen", name: "gen", language: input.generatorStandard, code: input.generator, remark: "" }]
			: [])
	);
}
export function sandboxGeneratorCommands(input: SandboxInput): GeneratorCommand[] {
	return (input.commands ?? []).map((command, index) =>
		Array.isArray(command) ? { generator: "gen", args: command, line: index + 1 } : command,
	);
}
