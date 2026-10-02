import type { BackgroundTask, VerificationRun, VerificationRunPage } from "@setdraft/contracts";
import { useEffect, useState } from "react";
import { apiUrl, requestJson } from "./api-client.ts";
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
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		setLoading(true);
		const refresh = async () => {
			try {
				const query = new URLSearchParams({ kind: mode, limit: "25" });
				if (cursor) query.set("cursor", cursor);
				const page = await requestJson<VerificationRunPage>(apiUrl(apiOrigin, `${route}?${query}`), {
					signal: controller.signal,
				});
				if (controller.signal.aborted) return;
				setRuns(page.runs);
				setNextCursor(page.nextCursor);
				setListError("");
			} catch (cause) {
				if (!controller.signal.aborted) setListError(cause instanceof Error ? cause.message : "运行记录读取失败。");
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
					timer = setTimeout(() => void refresh(), 2500);
				}
			}
		};
		void refresh();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [apiOrigin, route, mode, cursor]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Re-selecting a mutated run must reload its persisted details.
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		setRun(undefined);
		setTask(undefined);
		setError("");
		const refresh = async () => {
			let active = true;
			try {
				if (location.run) {
					const value = await requestJson<VerificationRun>(apiUrl(apiOrigin, `${route}/${location.run}`), {
						signal: controller.signal,
					});
					if (controller.signal.aborted) return;
					setRun(value);
					active = value.state === "running";
					if (value.taskId) {
						const status = await requestJson<BackgroundTask>(apiUrl(apiOrigin, `/tasks/${value.taskId}`), {
							signal: controller.signal,
						});
						if (!controller.signal.aborted) {
							setTask(status);
							active ||= ["running", "queued"].includes(status.state) || !!status.cleanupPending;
						}
					}
				} else if (location.task) {
					const status = await requestJson<BackgroundTask>(apiUrl(apiOrigin, `/tasks/${location.task}`), {
						signal: controller.signal,
					});
					const page = await requestJson<VerificationRunPage>(
						apiUrl(apiOrigin, `${route}?task=${encodeURIComponent(location.task)}&limit=1`),
						{ signal: controller.signal },
					);
					if (controller.signal.aborted) return;
					setTask(status);
					if (page.runs[0])
						replaceWorkspaceLocation(projectId, {
							run: page.runs[0].id,
							task: undefined,
							mode: page.runs[0].options.kind,
						});
					else active = ["running", "queued"].includes(status.state);
				} else return;
			} catch (cause) {
				if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "运行记录读取失败。");
			} finally {
				if (active && !controller.signal.aborted) timer = setTimeout(() => void refresh(), 1000);
			}
		};
		void refresh();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
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
		selectMode: (value: "matrix" | "stress") => {
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
