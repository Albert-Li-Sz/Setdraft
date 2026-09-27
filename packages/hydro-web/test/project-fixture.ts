import type { ProjectSnapshot } from "@setdraft/contracts";

export function projectFixture(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
	return {
		id: "project",
		scoringMode: "oi",
		revision: 1,
		createdAt: "",
		updatedAt: "",
		slug: "a-plus-b",
		title: "A + B",
		tags: [],
		statement: "求和。",
		samples: [],
		timeLimit: "1s",
		memoryLimit: "256m",
		reference: { language: "cpp17", code: "int main() {}" },
		generatorSource: "",
		generatorStandard: "cpp17",
		generatorScript: "",
		checkerSource: "",
		checkerStandard: "cpp17",
		validatorSource: "",
		validatorStandard: "cpp17",
		subtasks: [{ id: 1, type: "sum", score: 100 }],
		caseSubtasks: {},
		attachments: [],
		cases: [],
		orphanOutputs: [],
		...overrides,
	};
}
