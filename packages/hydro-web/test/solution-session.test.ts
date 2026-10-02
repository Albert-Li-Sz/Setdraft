import { projectSolutions, synchronizeSolutions } from "@setdraft/contracts";
import { expect, it } from "vitest";
import { editableProject } from "../src/problem.ts";
import { ProjectSession } from "../src/project-session.ts";
import { projectFixture } from "./project-fixture.ts";

it("keeps the primary source derived from unsaved solutions when an older save response arrives", () => {
	const initial = projectFixture();
	initial.solutions = projectSolutions(initial);
	synchronizeSolutions(initial);
	const session = new ProjectSession(async (value) => value);
	try {
		session.open(initial);
		session.edit((current) => {
			const next = { ...current, solutions: current.solutions!.map((item) => ({ ...item, code: "new source" })) };
			synchronizeSolutions(next);
			return next;
		});
		session.accept({ ...initial, revision: 2 });
		const snapshot = session.getSnapshot().project!;
		expect(snapshot.reference.code).toBe("new source");
		expect(snapshot.solutions?.[0].code).toBe("new source");
		expect(editableProject(snapshot)).not.toHaveProperty("reference");
		expect(editableProject(snapshot)).not.toHaveProperty("oracle");
		expect(editableProject(snapshot)).toHaveProperty("referenceSolutionId", "reference");
	} finally {
		session.dispose();
	}
});
