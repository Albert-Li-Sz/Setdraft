import { formatHydroStatement } from "@setdraft/authoring/statement";
import { problemTypeNames, resolveProblemType } from "@setdraft/contracts";
import type { ProjectSnapshot } from "./platform.ts";

export function parseTags(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[,，]/u)
				.map((tag) => tag.trim())
				.filter(Boolean),
		),
	];
}

export function editableProject(project: ProjectSnapshot) {
	return {
		problemType: resolveProblemType(project),
		communication: project.communication,
		protocolSamples: project.protocolSamples,
		interactionInputMode: project.interactionInputMode ?? "provided",
		interactorSource: project.interactorSource ?? "",
		interactorStandard: project.interactorStandard ?? "cpp17",
		slug: project.slug,
		title: project.title,
		tags: project.tags,
		statement: project.statementSections ? formatHydroStatement(project) : project.statement,
		statementSections: project.statementSections,
		samples: project.samples,
		timeLimit: project.timeLimit,
		memoryLimit: project.memoryLimit,
		...(project.solutions
			? { solutions: project.solutions, referenceSolutionId: project.referenceSolutionId }
			: { reference: project.reference, oracle: project.oracle ?? null }),
		...(project.generators
			? { generators: project.generators }
			: { generatorSource: project.generatorSource, generatorStandard: project.generatorStandard }),
		generatorScript: project.generatorScript,
		checkerSource: project.checkerSource,
		checkerStandard: project.checkerStandard,
		validatorSource: project.validatorSource,
		validatorStandard: project.validatorStandard,
		subtasks: project.subtasks,
		caseSubtasks: project.caseSubtasks,
		boundaryConditions: project.boundaryConditions ?? [],
		attachments: project.attachments,
	};
}

export function projectContextSnapshot(project: ProjectSnapshot): string {
	const sampleText = project.samples
		.map((sample, index) => `样例 ${index + 1} 输入:\n${sample.input}\n样例 ${index + 1} 输出:\n${sample.output}`)
		.join("\n\n");
	return [
		`标题：${project.title || "未命名"}`,
		`时间限制：${project.timeLimit}；内存限制：${project.memoryLimit}`,
		`判题方式：${problemTypeNames[resolveProblemType(project)]}${project.judgingMode === "interactive" ? `（${project.interactionInputMode === "empty" ? "无测试输入" : "私有测试数据"}）` : ""}`,
		`题面：\n${formatHydroStatement(project).slice(0, 50_000)}`,
		`样例：\n${sampleText.slice(0, 8_000)}`,
		`标准程序（${project.reference.language}）：\n${project.reference.code.slice(0, 18_000)}`,
	].join("\n\n");
}
