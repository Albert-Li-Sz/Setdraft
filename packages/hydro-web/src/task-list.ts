import type { BackgroundTask } from "@setdraft/contracts";

export type TaskFilter = "all" | "active" | "issues" | "ended";
export function taskNeedsAttention(task: Pick<BackgroundTask, "state" | "cleanupPending">): boolean {
	return !!task.cleanupPending || ["failed", "stale", "interrupted"].includes(task.state);
}
export function matchesTaskFilter(task: BackgroundTask, filter: TaskFilter): boolean {
	const active = task.state === "queued" || task.state === "running";
	return filter === "all" || (filter === "active" ? active : filter === "issues" ? taskNeedsAttention(task) : !active);
}
export function groupTasks(tasks: readonly BackgroundTask[]): Map<string, BackgroundTask[]> {
	const groups = new Map<string, BackgroundTask[]>();
	for (const item of tasks) {
		const group = groups.get(item.resource);
		if (group) group.push(item);
		else groups.set(item.resource, [item]);
	}
	return groups;
}
