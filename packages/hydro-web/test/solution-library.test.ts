import { projectSolutions, type Solution } from "@setdraft/contracts";
import { describe, expect, it } from "vitest";
import { ProjectSession } from "../src/project-session.ts";
import { changeProjectSolutions, incorrectSolutions, solutionPurposeChange } from "../src/solution-library.ts";
import { projectFixture } from "./project-fixture.ts";

const wrong: Solution = {
	id: "wrong",
	name: "错误解",
	language: "python3",
	code: "print(0)",
	purpose: "wrong",
	expectation: { kind: "WA" },
	required: false,
};
const library = () => changeProjectSolutions(projectFixture(), (items) => [...items, wrong]);

describe("shared solution library", () => {
	it("offers only the program library's non-AC solutions for pressure testing", () => {
		const project = changeProjectSolutions(library(), (items) => [...items, { ...wrong, id: "second" }]);
		expect(incorrectSolutions(project).map((item) => item.id)).toEqual(["wrong", "second"]);
	});

	it("shares source, name, language and expectation without creating a second program", () => {
		const project = changeProjectSolutions(library(), (items) =>
			items.map((item) =>
				item.id === wrong.id
					? { ...item, name: "内存超限", code: "bytearray(10**9)", expectation: { kind: "MLE" }, required: true }
					: item,
			),
		);
		expect(projectSolutions(project)).toHaveLength(2);
		expect(incorrectSolutions(project)[0]).toBe(project.solutions?.[1]);
		expect(project.solutions?.[1]).toMatchObject({
			id: "wrong",
			name: "内存超限",
			language: "python3",
			code: "bytearray(10**9)",
			expectation: { kind: "MLE" },
			required: true,
		});
	});

	it("removes deleted programs from pressure targets without altering the primary", () => {
		const project = changeProjectSolutions(library(), (items) => [...items, { ...wrong, id: "second" }]);
		const removed = changeProjectSolutions(project, (items) => items.filter((item) => item.id !== wrong.id));
		expect(incorrectSolutions(removed).map((item) => item.id)).toEqual(["second"]);
		const empty = changeProjectSolutions(removed, (items) => items.filter((item) => item.id !== "second"));
		expect(incorrectSolutions(empty)).toEqual([]);
		expect(empty.reference).toEqual(project.reference);
	});

	it("removes a program from pressure selection after its expectation becomes AC", () => {
		const project = changeProjectSolutions(library(), (items) =>
			items.map((item) => (item.id === wrong.id ? { ...item, expectation: { kind: "AC" } } : item)),
		);
		expect(projectSolutions(project)).toHaveLength(2);
		expect(incorrectSolutions(project)).toEqual([]);
	});

	it.each([
		["wrong", { kind: "WA" }],
		["slow", { kind: "TLE" }],
		["partial", { kind: "score", min: 0, max: 50 }],
	] as const)("sets a default expectation when an AC auxiliary becomes %s", (purpose, expectation) => {
		expect(solutionPurposeChange({ ...wrong, expectation: { kind: "AC" } }, purpose, false)).toEqual({
			purpose,
			expectation,
		});
	});

	it("preserves explicit expectations and the primary solution's AC rule", () => {
		expect(solutionPurposeChange({ ...wrong, expectation: { kind: "RE" } }, "slow", false)).toEqual({
			purpose: "slow",
		});
		expect(solutionPurposeChange({ ...wrong, expectation: { kind: "AC" } }, "wrong", true)).toEqual({
			purpose: "wrong",
		});
		expect(solutionPurposeChange({ ...wrong, expectation: { kind: "AC" } }, "brute", false)).toEqual({
			purpose: "brute",
		});
	});

	it("keeps program edits available to verification when an earlier autosave response arrives", () => {
		const initial = library();
		const session = new ProjectSession(async (project) => project);
		try {
			session.open(initial);
			session.edit((current) =>
				changeProjectSolutions(current, (items) =>
					items.map((item) => (item.id === wrong.id ? { ...item, name: "程序页修改", code: "print(1)" } : item)),
				),
			);
			session.edit((current) =>
				changeProjectSolutions(current, (items) =>
					items.map((item) => (item.id === wrong.id ? { ...item, expectation: { kind: "TLE" } } : item)),
				),
			);
			session.accept({ ...initial, revision: 2 });
			expect(incorrectSolutions(session.getSnapshot().project!)[0]).toMatchObject({
				name: "程序页修改",
				code: "print(1)",
				expectation: { kind: "TLE" },
			});
		} finally {
			session.dispose();
		}
	});
});
