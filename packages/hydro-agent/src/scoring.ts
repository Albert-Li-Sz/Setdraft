export interface ScoredSubtask {
	id: number;
	type: "sum" | "min" | "max";
	score: number;
	dependsOn?: readonly number[];
	cases: readonly { caseId?: string }[];
}

/** Compute the release score from per-case percentages using Hydro's sum/min/max rules. */
export function scoreHydroSubtasks(
	subtasks: readonly ScoredSubtask[],
	percentages: Readonly<Record<string, number>>,
): number {
	const scores = new Map<number, number>();
	let total = 0;
	for (const subtask of subtasks) {
		if (subtask.cases.length === 0) throw new Error(`子任务 ${subtask.id} 没有测试点。`);
		const fractions = subtask.cases.map((item) => {
			const percent = item.caseId ? percentages[item.caseId] : undefined;
			if (percent === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100)
				throw new Error(`测试点 ${item.caseId ?? "?"} 缺少有效得分。`);
			return percent / 100;
		});
		const score =
			subtask.type === "sum"
				? (subtask.score / fractions.length) * fractions.reduce((sum, value) => sum + value, 0)
				: subtask.score * (subtask.type === "min" ? Math.min(...fractions) : Math.max(...fractions));
		scores.set(subtask.id, score);
	}
	for (const subtask of subtasks) {
		if (
			(subtask.dependsOn ?? []).some(
				(id) => (scores.get(id) ?? 0) < (subtasks.find((item) => item.id === id)?.score ?? 0),
			)
		)
			continue;
		total += scores.get(subtask.id) ?? 0;
	}
	return total;
}
