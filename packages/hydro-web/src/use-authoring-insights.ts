import type { DataQualityReport, ProjectSnapshot, PublicationReadiness } from "@setdraft/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { requestJson } from "./api-client.ts";
import { startPageRefresh } from "./page-refresh.ts";
import { apiUrl } from "./platform.ts";
import type { ProjectSession } from "./project-session.ts";

const emptyState = { status: "saved" as const };
const subscribe = () => () => {};
const snapshot = () => emptyState;
export function useAuthoringInsights(
	apiOrigin: string,
	project: ProjectSnapshot,
	session: ProjectSession | undefined,
	enabled: boolean,
) {
	const state = useSyncExternalStore(session?.subscribe ?? subscribe, session?.getSnapshot ?? snapshot, snapshot);
	const [result, setResult] = useState<{ quality: DataQualityReport; readiness: PublicationReadiness }>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [sequence, setSequence] = useState(0);
	const refresh = useCallback(() => setSequence((value) => value + 1), []);
	const dirty = state.status !== "saved";
	const verifiedAt = project.lastReport?.verifiedAt;
	useEffect(() => {
		if (!enabled || dirty) {
			setLoading(false);
			return;
		}
		setError("");
		const polling = startPageRefresh(async (signal) => {
			setLoading(true);
			try {
				const value = await requestJson<{ quality: DataQualityReport; readiness: PublicationReadiness }>(
					apiUrl(
						apiOrigin,
						`/projects/${project.id}/authoring-insights?revision=${project.revision}&refresh=${sequence}&verification=${encodeURIComponent(verifiedAt ?? "")}`,
					),
					{ signal },
				);
				if (!signal.aborted) {
					setResult(value);
					setError("");
				}
			} catch (cause) {
				if (!signal.aborted) setError(cause instanceof Error ? cause.message : "报告读取失败。");
				throw cause;
			} finally {
				if (!signal.aborted) setLoading(false);
			}
			return undefined;
		}, 30000);
		return () => polling.stop();
	}, [apiOrigin, project.id, project.revision, dirty, enabled, sequence, verifiedAt]);
	const current = !dirty && result?.quality.projectId === project.id && result.quality.revision === project.revision;
	return {
		quality: current ? result.quality : undefined,
		readiness: current ? result.readiness : undefined,
		dirty,
		error,
		loading,
		refresh,
	};
}
