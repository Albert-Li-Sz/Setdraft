import { readProjectSnapshot } from "@setdraft/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiUrl, requestJson } from "./api-client.ts";
import { type DraftRecovery, DraftRecoveryStore } from "./draft-recovery.ts";
import { DraftRecoveryWriter } from "./draft-recovery-writer.ts";
import { editableProject } from "./problem.ts";
import { ProjectSession } from "./project-session.ts";

export function useProjectSession(apiOrigin: string, onError: (error: unknown) => void, userId?: string) {
	const errorHandler = useRef(onError);
	errorHandler.current = onError;
	const [session] = useState(
		() =>
			new ProjectSession(
				(project, signal) =>
					requestJson(
						apiUrl(apiOrigin, `/projects/${project.id}`),
						{
							method: "PUT",
							signal,
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ ...editableProject(project), expectedRevision: project.revision }),
						},
						readProjectSnapshot,
					),
				(error) => errorHandler.current(error),
			),
	);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
	const [recoveries, setRecoveries] = useState<DraftRecovery[]>([]);
	const [recoveryError, setRecoveryError] = useState("");
	const recoveryStore = useRef<DraftRecoveryStore | undefined>(undefined);
	useEffect(() => {
		if (!userId) return;
		let store: DraftRecoveryStore;
		try {
			store = new DraftRecoveryStore(localStorage, userId);
		} catch {
			return;
		}
		recoveryStore.current = store;
		const writer = new DraftRecoveryWriter(store, (error) =>
			setRecoveryError(error ? "浏览器未保存恢复副本；请保持页面开启直到自动保存成功。" : ""),
		);
		let projectId: string | undefined;
		const update = () => {
			const snapshot = session.getSnapshot(),
				base = session.getBaseline();
			try {
				if (snapshot.project && base) {
					writer.update(base, snapshot.project, snapshot.status === "saved");
				}
				if (snapshot.project?.id !== projectId) {
					projectId = snapshot.project?.id;
					setRecoveries(projectId ? store.list(projectId) : []);
				}
			} catch {
				setRecoveryError("浏览器未保存恢复副本；请保持页面开启直到自动保存成功。");
			}
		};
		const sync = () => {
			try {
				// Discover recovery copies when opening a project. Edits in a live tab must not steal focus here.
				const remaining = new Set(projectId ? store.list(projectId).map((entry) => entry.id) : []);
				setRecoveries((current) => current.filter((entry) => remaining.has(entry.id)));
			} catch {
				/* Existing editing remains available. */
			}
		};
		const unsubscribe = session.subscribe(update);
		const visibility = () => {
			if (document.hidden) writer.flush();
		};
		window.addEventListener("storage", sync);
		window.addEventListener("pagehide", writer.flush);
		document.addEventListener("visibilitychange", visibility);
		update();
		return () => {
			unsubscribe();
			writer.flush();
			window.removeEventListener("storage", sync);
			window.removeEventListener("pagehide", writer.flush);
			document.removeEventListener("visibilitychange", visibility);
			recoveryStore.current = undefined;
		};
	}, [session, userId]);
	const discardRecovery = (id: string) => {
		recoveryStore.current?.discard(id);
		setRecoveries((current) => current.filter((entry) => entry.id !== id));
	};
	useEffect(() => () => session.dispose(), [session]);
	return { session, ...state, recoveries, discardRecovery, recoveryError };
}
