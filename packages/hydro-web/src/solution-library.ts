import { type ProjectSnapshot, projectSolutions, type Solution, synchronizeSolutions } from "@setdraft/contracts";

/** Program edits update the canonical collection and its derived legacy views. */
export function changeProjectSolutions(
	project: ProjectSnapshot,
	edit: (items: Solution[]) => Solution[],
	primaryId = project.referenceSolutionId ?? "reference",
): ProjectSnapshot {
	const next = { ...project, solutions: edit(projectSolutions(project)), referenceSolutionId: primaryId };
	synchronizeSolutions(next);
	return next;
}

export function solutionPurposeChange(
	solution: Solution,
	purpose: Solution["purpose"],
	primary: boolean,
): Partial<Solution> {
	const change: Partial<Solution> = { purpose };
	if (primary || solution.expectation.kind !== "AC") return change;
	if (purpose === "wrong") change.expectation = { kind: "WA" };
	else if (purpose === "slow") change.expectation = { kind: "TLE" };
	else if (purpose === "partial") change.expectation = { kind: "score", min: 0, max: 50 };
	return change;
}

export function incorrectSolutions(project: ProjectSnapshot): Solution[] {
	return projectSolutions(project).filter((item) => item.expectation.kind !== "AC");
}
