import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Observability, secondsSince, traceCarrier } from "./observability.ts";

const paths = [
	/^\/api\/auth\/(status|setup|login|logout|session|password)$/u,
	/^\/api\/admin\/users(?:\/[^/]+)?$/u,
	/^\/api\/(system\/status|sandbox\/build|ai\/search|ai\/config(?:\/default|\/[^/]+(?:\/test)?)?|people)$/u,
	/^\/api\/tasks(?:\/[^/]+(?:\/(events|cancel|retry))?)?$/u,
	/^\/api\/projects(?:\/[^/]+(?:\/(generate|finalize|generated|domjudge-pdf|copy|files\/[^/]+|cases(?:\/(batch-delete|renumber|(manual|generated)\/[^/]+\/preview))?|releases(?:\/[^/]+\/restore)?))?)?$/u,
	/^\/api\/projects\/[^/]+\/(authoring-insights|drafts(?:\/\d+(?:\/restore)?)?)$/u,
	/^\/api\/releases(?:\/[^/]+(?:\/(hydro|source|domjudge|fps|qduoj|report|exports\/(domjudge|fps|qduoj)))?)?$/u,
	/^\/api\/contests(?:\/[^/]+(?:\/(export|pdf-preview))?)?$/u,
	/^\/api\/contest-releases(?:\/[^/]+\/(download|pdf))?$/u,
	/^\/api\/chats(?:\/[^/]+(?:\/(messages|images\/[^/]+|requests(?:\/[^/]+(?:\/(events|retry|cancel))?)?))?)?$/u,
];
/** Derive labels from the router's shape, never from raw URLs, IDs, filenames or query strings. */
export function httpRoute(path: string): string {
	if (!paths.some((pattern) => pattern.test(path))) return "/api/{unknown}";
	return path.replace(
		/(\/(?:users|tasks|projects|releases|contests|contest-releases|chats|requests|images|files|config|manual|generated|drafts))\/([^/]+)/gu,
		(match, prefix: string, value: string) => {
			if (prefix === "/config" && value === "default") return match;
			return `${prefix}/:id`;
		},
	);
}

export async function observeHttp(
	observability: Observability,
	request: IncomingMessage,
	response: ServerResponse,
	handle: () => Promise<void>,
): Promise<void> {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;
	if (!observability.enabled || !path.startsWith("/api/") || ["/api/health", "/api/system/status"].includes(path))
		return handle();
	const route = httpRoute(path);
	const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method ?? "")
		? request.method
		: "OTHER";
	const labels = {
		"http.route": route,
		"http.request.method": method,
		"http.transport": path.endsWith("/events") ? "sse" : "http",
	};
	const requestId = randomUUID();
	response.setHeader("x-request-id", requestId);
	return observability.withPropagation(
		traceCarrier({ traceparent: request.headers.traceparent, tracestate: request.headers.tracestate }),
		() =>
			observability.startSpan(
				{
					name: labels["http.transport"] === "sse" ? "http.sse" : "http.request",
					attributes: { ...labels, "request.id": requestId },
				},
				async (span) => {
					const start = performance.now();
					let disconnected = false;
					const completed = new Promise<void>((resolve) => {
						const finish = () => {
							response.off("close", close);
							resolve();
						};
						const close = () => {
							response.off("finish", finish);
							disconnected = !response.writableFinished;
							resolve();
						};
						response.once("finish", finish);
						response.once("close", close);
					});
					await handle();
					await completed;
					const result = {
						...labels,
						"http.response.status_code": response.statusCode,
						"operation.result": disconnected ? "disconnected" : response.statusCode >= 400 ? "error" : "ok",
					};
					span.setAttributes(result);
					if (disconnected || response.statusCode >= 400) span.setStatus({ status: "error" });
					observability.metric("setdraft.http.requests", 1, result);
					observability.metric("setdraft.http.duration", secondsSince(start), result);
					observability.log("http.complete", { ...result, "request.id": requestId });
				},
			),
	);
}
