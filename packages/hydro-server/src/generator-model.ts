import {
	cppLanguages,
	isGenerator,
	type ManualProject,
	nextGeneratorIndex,
	synchronizeGenerators,
} from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";
import { parseGeneratorScript } from "./project-files.ts";

export function updateGenerators(project: ManualProject, input: Record<string, unknown>): void {
	synchronizeGenerators(project);
	if (input.generators !== undefined) {
		if (input.generatorSource !== undefined || input.generatorStandard !== undefined)
			throw new ManualProjectError("请使用生成器集合或旧 Gen 字段更新，不能同时使用。", 422);
		if (!Array.isArray(input.generators) || input.generators.length > 32 || !input.generators.every(isGenerator))
			throw new ManualProjectError("最多支持 32 个 Gen；请检查名称、语言、源码和备注。", 422);
		if (
			new Set(input.generators.map((item) => item.id)).size !== input.generators.length ||
			new Set(input.generators.map((item) => item.name)).size !== input.generators.length
		)
			throw new ManualProjectError("Gen 编号和 ID 不能重复。", 422);
		const requested = input.generators;
		const before = project.generators ?? [];
		const removed = before.filter((item) => !requested.some((next) => next.name === item.name));
		for (const item of requested) {
			const existing = before.find((previous) => previous.id === item.id);
			if (existing && existing.name !== item.name) throw new ManualProjectError("已有 Gen 的编号不能修改。", 422);
			if (!existing && (item.name === "gen" || Number(item.name.slice(4)) < nextGeneratorIndex(project)))
				throw new ManualProjectError("已删除的 Gen 编号不能复用。", 422);
		}
		const script = typeof input.generatorScript === "string" ? input.generatorScript : project.generatorScript;
		const commands = removed.length && script.trim() ? parseGeneratorScript(script) : [];
		for (const item of removed) {
			const lines = commands.filter((command) => command.generator === item.name).map((command) => command.line);
			if (lines.length)
				throw new ManualProjectError(`${item.name} 仍被生成脚本第 ${lines.join("、")} 行引用，请先修改脚本。`, 422);
		}
		project.generators = requested.map((item) => ({ ...item }));
	} else if (input.generatorSource !== undefined || input.generatorStandard !== undefined) {
		if (
			input.generatorSource !== undefined &&
			(typeof input.generatorSource !== "string" || input.generatorSource.length > 200_000)
		)
			throw new ManualProjectError("Gen 源码必须是不超过 200000 字符的文本。", 422);
		if (
			input.generatorStandard !== undefined &&
			![...cppLanguages, "python3"].includes(String(input.generatorStandard))
		)
			throw new ManualProjectError("Gen 支持 C++ 或 Python 3。", 422);
		const first = project.generators?.find((item) => item.name === "gen");
		if (!first) throw new ManualProjectError("gen 已删除，请使用生成器集合更新。", 422);
		if (typeof input.generatorSource === "string") first.code = input.generatorSource;
		if (typeof input.generatorStandard === "string")
			first.language = input.generatorStandard as typeof first.language;
	}
	synchronizeGenerators(project);
}
