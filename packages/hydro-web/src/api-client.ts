import type { BackgroundTask, ProjectSnapshot } from "@hydro-problem-make/contracts";
import { isProjectSnapshot } from "@hydro-problem-make/contracts";

export class ApiError extends Error {
	readonly status: number;
	readonly body: unknown;
	constructor(status: number, body: unknown) {
		super(responseError(body));
		this.status = status;
		this.body = body;
	}
}

export class RevisionConflict extends ApiError {
	readonly current: ProjectSnapshot;
	constructor(body: unknown, current: ProjectSnapshot) {
		super(409, body);
		this.current = current;
	}
}

export function responseError(value: unknown, fallback = "请求失败，请检查本地 API。") {
	if (typeof value !== "object" || value === null) return fallback;
	const message = (value as Record<string, unknown>).message;
	return typeof message === "string" ? message : fallback;
}

export function apiUrl(apiOrigin: string, route: string): string {
	const suffix = route.startsWith("/") ? route : `/${route}`;
	return `${apiOrigin.replace(/\/+$/u, "")}/api${suffix}`;
}

export async function requestJson<T>(url: string, init?: RequestInit, decode?: (body: unknown) => T): Promise<T> {
	const response = await fetch(url, init);
	const body: unknown = response.status === 204 ? undefined : await response.json();
	if (!response.ok) {
		if (
			response.status === 409 &&
			typeof body === "object" &&
			body !== null &&
			"current" in body &&
			isProjectSnapshot(body.current)
		) {
			throw new RevisionConflict(body, body.current);
		}
		throw new ApiError(response.status, body);
	}
	return decode ? decode(body) : (body as T);
}

export async function waitForTask<T>(
	apiOrigin: string,
	id: string,
	onUpdate?: (task: BackgroundTask<T>) => void,
	signal?: AbortSignal,
): Promise<T> {
	for (;;) {
		signal?.throwIfAborted();
		const task = await requestJson<BackgroundTask<T>>(apiUrl(apiOrigin, `/tasks/${id}`), { signal });
		signal?.throwIfAborted();
		onUpdate?.(task);
		if (task.state === "succeeded") return task.result as T;
		if (["failed", "cancelled", "stale", "interrupted"].includes(task.state))
			throw new Error(task.error ?? `任务${task.state}。`);
		await new Promise<void>((resolve, reject) => {
			const finish = () => {
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const timer = setTimeout(finish, 800);
			const abort = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(signal?.reason);
			};
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
		});
	}
}
