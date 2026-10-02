import { isSolution, type ManualProject, type Solution, synchronizeSolutions } from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";

export function updateSolutions(project: ManualProject, input: Record<string, unknown>): void {
	synchronizeSolutions(project);
	if (input.solutions !== undefined) {
		if (
			!Array.isArray(input.solutions) ||
			input.solutions.length < 1 ||
			input.solutions.length > 32 ||
			!input.solutions.every(isSolution)
		)
			throw new ManualProjectError("请提供 1–32 个有效解法及预期结果。", 422);
		if (new Set(input.solutions.map((item) => item.id)).size !== input.solutions.length)
			throw new ManualProjectError("解法 ID 不能重复。", 422);
		project.solutions = input.solutions.map(
			(item): Solution => ({
				id: item.id,
				name: item.name.trim(),
				language: item.language,
				code: item.code,
				purpose: item.purpose,
				required: item.required,
				expectation: { ...item.expectation },
			}),
		);
	}
	if (input.referenceSolutionId !== undefined) {
		if (typeof input.referenceSolutionId !== "string") throw new ManualProjectError("主标程 ID 无效。", 422);
		project.referenceSolutionId = input.referenceSolutionId;
	}
	const primary = project.solutions?.find((item) => item.id === project.referenceSolutionId);
	if (!primary || !primary.required || primary.expectation.kind !== "AC")
		throw new ManualProjectError("主标程必须保留，并设置为必检 AC。", 422);
	synchronizeSolutions(project);
}
