import { formatHydroStatement } from "@hydro-problem-make/authoring/statement";
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

export const statementWithSamples = formatHydroStatement;

export function editableProject(project: ProjectSnapshot) {
	return {
		slug: project.slug,
		title: project.title,
		tags: project.tags,
		statement: project.statement,
		samples: project.samples,
		timeLimit: project.timeLimit,
		memoryLimit: project.memoryLimit,
		reference: project.reference,
		oracle: project.oracle ?? null,
		generatorSource: project.generatorSource,
		generatorStandard: project.generatorStandard,
		generatorScript: project.generatorScript,
		checkerSource: project.checkerSource,
		checkerStandard: project.checkerStandard,
		validatorSource: project.validatorSource,
		validatorStandard: project.validatorStandard,
		subtasks: project.subtasks,
		caseSubtasks: project.caseSubtasks,
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
		`题面：\n${project.statement.slice(0, 50_000)}`,
		`样例：\n${sampleText.slice(0, 8_000)}`,
		`标准程序（${project.reference.language}）：\n${project.reference.code.slice(0, 18_000)}`,
	].join("\n\n");
}
