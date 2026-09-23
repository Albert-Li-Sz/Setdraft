import type { AuthoringCheck } from "./authoring-project.ts";

export interface GroupedAuthoringFailure {
	signature: string;
	stage: string;
	message: string;
	count: number;
	caseIds: string[];
}

function diagnostic(message: string): string {
	const compilerLine = message.split("\n").find((line) => line.includes("error:"));
	return (compilerLine ?? message.split("\n").find((line) => line.trim()) ?? "未知错误")
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/\/work\/[^\s:]+/g, "<file>")
		.replace(/:\d+(?::\d+)?/g, ":<line>")
		.replace(/\b\d+\b/g, "#")
		.trim()
		.slice(0, 240);
}

export function groupAuthoringFailures(checks: readonly AuthoringCheck[]): GroupedAuthoringFailure[] {
	const grouped = new Map<string, GroupedAuthoringFailure>();
	for (const check of checks) {
		if (check.passed) continue;
		const signature = `${check.stage}: ${diagnostic(check.message)}`;
		const existing = grouped.get(signature);
		if (existing) {
			existing.count += 1;
			if (check.caseId && existing.caseIds.length < 3 && !existing.caseIds.includes(check.caseId))
				existing.caseIds.push(check.caseId);
		} else
			grouped.set(signature, {
				signature,
				stage: check.stage,
				message: check.message.slice(0, 2000),
				count: 1,
				caseIds: check.caseId ? [check.caseId] : [],
			});
	}
	return [...grouped.values()].sort(
		(left, right) => right.count - left.count || left.signature.localeCompare(right.signature),
	);
}
