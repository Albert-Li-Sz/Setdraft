import { formatHydroStatement } from "@setdraft/authoring/statement";
import { describe, expect, it } from "vitest";
import type { ProjectSnapshot } from "../src/platform.ts";
import { editableProject, parseTags, projectContextSnapshot } from "../src/problem.ts";

const project: ProjectSnapshot = {
	id: "project",
	scoringMode: "oi",
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
	it("saves interactive settings independently of scoring mode and preserves hidden programs", () => {
		expect(
			editableProject({
				...project,
				judgingMode: "interactive",
				interactionInputMode: "empty",
				interactorSource: "interactive source",
				interactorStandard: "cpp20",
				checkerSource: "saved checker",
				generatorSource: "saved generator",
			}),
		).toMatchObject({
			problemType: "interactive",
			interactionInputMode: "empty",
			interactorSource: "interactive source",
			interactorStandard: "cpp20",
			checkerSource: "saved checker",
			generatorSource: "saved generator",
		});
	});
	it("keeps public samples separate from private data", () => {
		expect(formatHydroStatement(project)).toBe(`${project.statement}\n`);
		expect(editableProject(project).samples).toEqual(project.samples);
		expect(formatHydroStatement(project)).not.toContain("## 样例");
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

	it("serializes the active statement sections while preserving inactive content", () => {
		const structured = {
			...project,
			judgingMode: "interactive" as const,
			statement: "OUTDATED_MARKDOWN",
			statementSections: {
				description: "求和说明。",
				input: "SAVED_BATCH_INPUT",
				output: "SAVED_BATCH_OUTPUT",
				interaction: "发送两个整数，收到它们的和。",
				notes: "每次输出后 flush。",
			},
		};
		const editable = editableProject(structured);
		expect(editable.statementSections).toEqual(structured.statementSections);
		expect(editable.statement).toBe(formatHydroStatement(structured));
		expect(editable.statement).toContain("## 交互协议");
		expect(editable.statement).toContain("## 旧双栏样例（消息顺序未整理）");
		expect(editable.statement).not.toContain("OUTDATED_MARKDOWN");
		expect(editable.statement).not.toContain("SAVED_BATCH_INPUT");
		expect(projectContextSnapshot(structured)).toContain("发送两个整数，收到它们的和。");
		expect(projectContextSnapshot(structured)).not.toContain("OUTDATED_MARKDOWN");
		const batch = editableProject({ ...structured, judgingMode: "default" });
		expect(batch.statement).toContain("SAVED_BATCH_INPUT");
		expect(batch.statement).not.toContain("## 交互协议");
		expect(batch.statementSections?.interaction).toBe(structured.statementSections.interaction);
	});
});
