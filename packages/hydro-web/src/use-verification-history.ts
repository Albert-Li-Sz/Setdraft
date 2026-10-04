import type { BackgroundTask, VerificationRun, VerificationRunPage } from "@setdraft/contracts";
import { useEffect, useState } from "react";
import { apiUrl, requestJson } from "./api-client.ts";
import { startPageRefresh } from "./page-refresh.ts";
import { readWorkspaceLocation, replaceWorkspaceLocation, useLocationHash } from "./workspace-navigation.ts";

export function useVerificationHistory(apiOrigin: string, projectId: string) {
	const hash = useLocationHash();
	const parsed = readWorkspaceLocation(hash);
	const location = parsed.project === projectId ? parsed : {};
	const mode = location.mode ?? "matrix";
	const route = `/projects/${projectId}/runs`;
	const [runs, setRuns] = useState<VerificationRun[]>([]);
	const [run, setRun] = useState<VerificationRun>();
	const [task, setTask] = useState<BackgroundTask>();
	const [error, setError] = useState("");
	const [listError, setListError] = useState("");
	const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
	const cursor = cursors.at(-1);
	const [nextCursor, setNextCursor] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [refreshVersion, setRefreshVersion] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Each run kind has its own paginated collection.
	useEffect(() => {
		setCursors([undefined]);
	}, [mode]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: A newly created or selected run must immediately refresh the list.
	useEffect(() => {
		setLoading(true);
		const polling = startPageRefresh(async (signal) => {
			try {
				const query = new URLSearchParams({ kind: mode, limit: "25" });
				if (cursor) query.set("cursor", cursor);
				const page = await requestJson<VerificationRunPage>(apiUrl(apiOrigin, `${route}?${query}`), {
					signal,
				});
				if (signal.aborted) return;
				setRuns(page.runs);
				setNextCursor(page.nextCursor);
				setListError("");
				return page.runs.some((item) => item.state === "running") ? 2500 : 15000;
			} catch (cause) {
				if (!signal.aborted) setListError(cause instanceof Error ? cause.message : "运行记录读取失败。");
				throw cause;
			} finally {
				if (!signal.aborted) setLoading(false);
			}
		}, 2500);
		return () => polling.stop();
	}, [apiOrigin, route, mode, cursor, location.run, location.task]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Re-selecting a mutated run must reload its persisted details.
	useEffect(() => {
		setRun(undefined);
		setTask(undefined);
		setError("");
		const polling = startPageRefresh(async (signal) => {
			let active = true;
			try {
				if (location.run) {
					const value = await requestJson<VerificationRun>(apiUrl(apiOrigin, `${route}/${location.run}`), {
						signal,
					});
					if (signal.aborted) return;
					setRun(value);
					active = value.state === "running";
					if (value.taskId) {
						const status = await requestJson<BackgroundTask>(apiUrl(apiOrigin, `/tasks/${value.taskId}`), {
							signal,
						});
						if (!signal.aborted) {
							setTask(status);
							active ||= ["running", "queued"].includes(status.state) || !!status.cleanupPending;
						}
					}
				} else if (location.task) {
					const status = await requestJson<BackgroundTask>(apiUrl(apiOrigin, `/tasks/${location.task}`), {
						signal,
					});
					const page = await requestJson<VerificationRunPage>(
						apiUrl(apiOrigin, `${route}?task=${encodeURIComponent(location.task)}&limit=1`),
						{ signal },
					);
					if (signal.aborted) return;
					setTask(status);
					if (page.runs[0])
						replaceWorkspaceLocation(projectId, {
							run: page.runs[0].id,
							task: undefined,
							mode: page.runs[0].options.kind,
						});
					else active = ["running", "queued"].includes(status.state);
				} else return false;
				setError("");
				return active ? 1000 : false;
			} catch (cause) {
				if (!signal.aborted) setError(cause instanceof Error ? cause.message : "运行记录读取失败。");
				throw cause;
			}
		}, 1000);
		return () => polling.stop();
	}, [apiOrigin, route, location.run, location.task, projectId, refreshVersion]);
	return {
		location,
		mode,
		route,
		runs,
		run,
		task,
		setTask,
		error: error || listError,
		loading,
		page: cursors.length,
		nextCursor,
		next: () => {
			if (nextCursor) setCursors((current) => [...current, nextCursor]);
		},
		previous: () => setCursors((current) => (current.length > 1 ? current.slice(0, -1) : current)),
		select: async (id: string) => {
			replaceWorkspaceLocation(projectId, { tab: "validation", run: id || undefined, task: undefined });
			setRefreshVersion((current) => current + 1);
		},
		selectMode: (value: "matrix" | "pressure" | "stress") => {
			replaceWorkspaceLocation(projectId, {
				tab: "validation",
				mode: value,
				run: undefined,
				task: undefined,
				solution: undefined,
				subtask: undefined,
				abnormal: false,
			});
		},
	};
}
