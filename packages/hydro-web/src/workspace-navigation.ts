import { useSyncExternalStore } from "react";

export interface WorkspaceLocation {
	project?: string;
	tab?: string;
	run?: string;
	task?: string;
	mode?: "matrix" | "stress";
	solution?: string;
	subtask?: string;
	abnormal?: boolean;
}
export function readWorkspaceLocation(hash: string): WorkspaceLocation {
	if (hash.split("?")[0] !== "#workspace") return {};
	const params = new URLSearchParams(hash.split("?")[1]);
	const id = (key: string) => {
		const value = params.get(key) ?? "";
		return /^[A-Za-z0-9-]{1,64}$/u.test(value) ? value : undefined;
	};
	return {
		project: id("project"),
		tab: id("tab"),
		run: id("run"),
		task: id("task"),
		mode: params.get("mode") === "stress" ? "stress" : "matrix",
		solution: id("solution"),
		subtask: id("subtask"),
		abnormal: params.get("abnormal") === "1",
	};
}
export function workspaceHash(value: WorkspaceLocation): string {
	const params = new URLSearchParams();
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined && item !== false && item !== "") params.set(key, item === true ? "1" : item);
	}
	return `#workspace${params.size ? `?${params}` : ""}`;
}
function subscribe(listener: () => void) {
	window.addEventListener("hashchange", listener);
	return () => window.removeEventListener("hashchange", listener);
}
const snapshot = () => window.location.hash;
const serverSnapshot = () => "";
export function useLocationHash(): string {
	return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
export function replaceWorkspaceLocation(project: string, patch: Partial<WorkspaceLocation>): void {
	const current = readWorkspaceLocation(window.location.hash);
	const hash = workspaceHash({ ...(current.project === project ? current : {}), project, ...patch });
	if (hash === window.location.hash) return;
	window.history.replaceState(null, "", hash);
	window.dispatchEvent(new Event("hashchange"));
}
