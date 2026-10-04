import type { BackgroundTask, ProjectSnapshot } from "@setdraft/contracts";
import { isProjectSnapshot } from "@setdraft/contracts";
import { authFetch } from "./auth-client.ts";
import type { ProgressRequestInit } from "./upload-request.ts";

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

export async function requestJson<T>(
	url: string,
	init?: ProgressRequestInit,
	decode?: (body: unknown) => T,
): Promise<T> {
	// Reads can be retried safely. Writes keep their existing lifetime and cancellation semantics.
	const deadline = ["GET", "HEAD"].includes(init?.method?.toUpperCase() ?? "GET") ? new AbortController() : undefined;
	const timer = deadline
		? setTimeout(() => deadline.abort(new DOMException("Read timeout", "TimeoutError")), 30000)
		: undefined;
	const signal = deadline
		? init?.signal
			? AbortSignal.any([init.signal, deadline.signal])
			: deadline.signal
		: init?.signal;
	let response: Response;
	let body: unknown;
	try {
		response = await authFetch(url, { ...init, signal });
		try {
			body = response.status === 204 || init?.method?.toUpperCase() === "HEAD" ? undefined : await response.json();
		} catch (cause) {
			if (!(cause instanceof SyntaxError)) throw cause;
			if (response.ok) throw new Error("服务响应格式错误，请刷新后重试。");
			body = { message: "服务暂时不可用，请稍后重试。" };
		}
	} catch (cause) {
		if (deadline?.signal.aborted && !init?.signal?.aborted) throw new Error("请求超时，请检查连接后重试。");
		throw cause;
	} finally {
		clearTimeout(timer);
	}
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
