import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../src/platform.ts";
import { editableProject, parseTags, projectContextSnapshot, statementWithSamples } from "../src/problem.ts";

const project: ProjectSnapshot = {
	id: "project",
	revision: 1,
	createdAt: "",
	updatedAt: "",
	slug: "a-plus-b",
	title: "A + B",
	tags: ["入门"],
	statement: "# A + B\n\n求和。",
	samples: [{ input: "1 2", output: "3" }],
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
};

describe("manual problem editor helpers", () => {
	it("keeps public samples separate from private data", () => {
		expect(statementWithSamples(project)).toContain("```input1\n1 2\n```");
		expect(statementWithSamples({ ...project, samples: [] })).not.toContain("## 样例");
		expect(editableProject(project)).not.toHaveProperty("cases");
		expect(editableProject(project)).toMatchObject({
			generatorStandard: "cpp17",
			checkerStandard: "cpp17",
			validatorStandard: "cpp17",
		});
	});

	it("sends only an explicit read-only snapshot to AI chat", () => {
		const snapshot = projectContextSnapshot(project);
		expect(snapshot).toContain("标准程序（cpp17）");
		expect(snapshot).toContain("# A + B");
		expect(parseTags("入门, 模拟，入门")).toEqual(["入门", "模拟"]);
	});
});
