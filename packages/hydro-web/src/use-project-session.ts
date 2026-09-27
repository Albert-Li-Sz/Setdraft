import { readProjectSnapshot } from "@setdraft/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { apiUrl, requestJson } from "./api-client.ts";
import { editableProject } from "./problem.ts";
import { ProjectSession } from "./project-session.ts";

export function useProjectSession(apiOrigin: string, onError: (error: unknown) => void) {
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
	useEffect(() => () => session.dispose(), [session]);
	return { session, ...state };
}
