import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import {
	buildAuthoringArchive,
	type HydroAiConfigurationController,
	type HydroSandbox,
} from "@hydro-problem-make/agent";
import {
	buildHydroDirectoryArchive,
	buildHydroProblemArchive,
	HydroProblemValidationError,
	validateHydroProblemSpec,
} from "@hydro-problem-make/authoring";
import type { HydroLiveVerifier } from "./live-hydro.ts";
import {
	InvalidRequestError,
	parseAgentRunRequest,
	parseAiConfigurationRequest,
	parseContinueRequest,
	parseProblemRequest,
	parseSandboxRequest,
} from "./request.ts";
import type { HydroRunEvent, HydroRunManager, HydroRunStatus } from "./runs.ts";

export interface HydroServerOptions {
	staticRoot?: string;
	maxRequestBytes?: number;
	runManager?: HydroRunManager;
	aiConfiguration?: HydroAiConfigurationController;
	sandbox?: HydroSandbox;
	liveVerifier?: HydroLiveVerifier;
}

const contentTypes: Readonly<Record<string, string>> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
	const body = JSON.stringify(value);
	response.writeHead(statusCode, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function isTerminalRun(status: HydroRunStatus): boolean {
	return status === "needs_input" || status === "succeeded" || status === "failed" || status === "cancelled";
}

function writeServerEvent(response: ServerResponse, event: HydroRunEvent): void {
	response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function localBrowserOrigin(request: IncomingMessage): string | undefined {
	const origin = request.headers.origin;
	if (typeof origin !== "string") return undefined;
	try {
		const hostname = new URL(origin).hostname;
		return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" ? origin : undefined;
	} catch {
		return undefined;
	}
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
	const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
	if (contentType !== "application/json") throw new InvalidRequestError("Content-Type must be application/json.");
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > maxBytes) throw new InvalidRequestError(`Request body exceeds ${maxBytes} bytes.`);
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new InvalidRequestError("Request body must contain valid JSON.");
	}
}

async function serveStatic(response: ServerResponse, staticRoot: string, pathname: string): Promise<boolean> {
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(pathname);
	} catch {
		return false;
	}
	const requestedPath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
	const root = resolve(staticRoot);
	const filePath = resolve(root, requestedPath);
	if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return false;
	try {
		const metadata = await stat(filePath);
		if (!metadata.isFile()) return false;
		response.writeHead(200, {
			"content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
			"content-length": metadata.size,
		});
		createReadStream(filePath).pipe(response);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function createHydroServer(options: HydroServerOptions = {}): Server {
	const maxRequestBytes = options.maxRequestBytes ?? 12 * 1024 * 1024;
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			const corsOrigin = localBrowserOrigin(request);
			if (corsOrigin !== undefined && url.pathname.startsWith("/api/")) {
				response.setHeader("access-control-allow-origin", corsOrigin);
				response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
				response.setHeader("access-control-allow-headers", "content-type, last-event-id");
				response.setHeader("vary", "origin");
			}
			if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
				if (request.headers.origin !== undefined && corsOrigin === undefined) {
					sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED", message: "Browser origin is not allowed." });
					return;
				}
				response.writeHead(204, { "content-length": 0 });
				response.end();
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/health") {
				const readiness = options.runManager?.getReadiness();
				sendJson(response, 200, {
					status: "ok",
					target: "Hydro default / C++ testlib checker",
					skill: "hydro-problem-authoring",
					sandbox: options.sandbox
						? await options.sandbox.status()
						: { available: false, image: "", message: "沙箱尚未配置。" },
					capabilities: {
						validate: true,
						deterministicArchive: true,
						agentGeneration: readiness?.available ?? false,
						agentModels: readiness?.models ?? [],
						maxConcurrentRuns: options.runManager?.getMaxConcurrentRuns() ?? 0,
						liveHydro: options.liveVerifier?.status() ?? {
							configured: false,
							message: "未配置真实 Hydro 实测适配器。",
						},
					},
				});
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/sandbox/run") {
				if (!options.sandbox) {
					sendJson(response, 503, { error: "SANDBOX_UNAVAILABLE", message: "沙箱尚未配置。" });
					return;
				}
				const input = parseSandboxRequest(await readJson(request, maxRequestBytes));
				const controller = new AbortController();
				response.once("close", () => {
					if (!response.writableEnded) controller.abort();
				});
				try {
					sendJson(response, 200, await options.sandbox.run(input, controller.signal));
				} catch (error) {
					if (!response.destroyed)
						sendJson(response, 503, {
							error: "SANDBOX_ERROR",
							message: error instanceof Error ? error.message : "沙箱无法执行。",
						});
				}
				return;
			}
			if (url.pathname === "/api/ai/config") {
				const configuration = options.aiConfiguration;
				if (configuration === undefined) {
					sendJson(response, 503, {
						error: "AI_CONFIGURATION_UNAVAILABLE",
						message: "Pi Agent configuration is not available in this server process.",
					});
					return;
				}
				if (request.method === "GET") {
					sendJson(response, 200, configuration.getSnapshot());
					return;
				}
				if (request.method === "PUT") {
					const input = parseAiConfigurationRequest(await readJson(request, maxRequestBytes));
					sendJson(response, 200, await configuration.configure(input));
					return;
				}
				if (request.method === "DELETE") {
					sendJson(response, 200, await configuration.clear());
					return;
				}
			}
			if (request.method === "GET" && url.pathname === "/api/runs") {
				sendJson(response, 200, { runs: options.runManager?.list() ?? [] });
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/runs") {
				if (options.runManager === undefined || !options.runManager.getReadiness().available) {
					sendJson(response, 503, {
						error: "AGENT_UNAVAILABLE",
						message: "No configured Pi model is available for Agent generation.",
					});
					return;
				}
				const { source, referenceProgram, attachments } = parseAgentRunRequest(
					await readJson(request, maxRequestBytes),
				);
				if (options.sandbox) {
					const sandboxStatus = await options.sandbox.status();
					if (!sandboxStatus.available) {
						sendJson(response, 503, { error: "SANDBOX_UNAVAILABLE", message: sandboxStatus.message });
						return;
					}
				}
				sendJson(response, 202, options.runManager.create(source, referenceProgram, attachments));
				return;
			}
			const runRoute = url.pathname.match(
				/^\/api\/runs\/([^/]+)(?:\/(events|cancel|archive|continue|retry|authoring|authoring-report|live-verify))?$/,
			);
			if (runRoute !== null) {
				const manager = options.runManager;
				if (manager === undefined) {
					sendJson(response, 503, { error: "AGENT_UNAVAILABLE", message: "Agent generation is not enabled." });
					return;
				}
				const runId = runRoute[1];
				const action = runRoute[2];
				const run = manager.get(runId);
				if (run === undefined) {
					sendJson(response, 404, { error: "RUN_NOT_FOUND", message: "Authoring run not found." });
					return;
				}
				if (request.method === "GET" && action === undefined) {
					sendJson(response, 200, run);
					return;
				}
				if (request.method === "GET" && action === "authoring-report") {
					const evidence = manager.getAuthoringEvidence(runId);
					if (!evidence) {
						sendJson(response, 404, {
							error: "AUTHORING_REPORT_NOT_FOUND",
							message: "该任务没有可读取的完整制题验证报告。",
						});
						return;
					}
					sendJson(response, 200, {
						...evidence.report,
						checks: evidence.report.checks.map((check) => ({
							...check,
							message:
								check.message.length > (check.passed ? 500 : 2000)
									? `${check.message.slice(0, check.passed ? 500 : 2000)}\n…（已截断）`
									: check.message,
						})),
						cases: evidence.report.cases.map(({ id, durationMs, timeLimitMs, memoryLimitMb }) => ({
							id,
							durationMs,
							timeLimitMs,
							memoryLimitMb,
						})),
					});
					return;
				}
				if (request.method === "POST" && action === "live-verify") {
					if (!options.liveVerifier) {
						sendJson(response, 503, {
							error: "LIVE_HYDRO_UNAVAILABLE",
							message: "未配置真实 Hydro 实测适配器。",
						});
						return;
					}
					const liveRequest = manager.getLiveVerificationRequest(runId);
					if (!liveRequest) {
						sendJson(response, 409, {
							error: "LIVE_HYDRO_NOT_READY",
							message: "需要先完成完整制题验证和 Hydro 打包。",
						});
						return;
					}
					const controller = new AbortController();
					response.once("close", () => {
						if (!response.writableEnded) controller.abort();
					});
					try {
						const result = await options.liveVerifier.verify(liveRequest, controller.signal);
						manager.setLiveVerification(runId, result);
						sendJson(response, 200, result);
					} catch (error) {
						if (!response.destroyed)
							sendJson(response, 502, {
								error: "LIVE_HYDRO_FAILED",
								message: error instanceof Error ? error.message : "Hydro 实测失败。",
							});
					}
					return;
				}
				if (request.method === "DELETE" && action === undefined) {
					try {
						await manager.delete(runId);
						response.writeHead(204, { "cache-control": "no-store" });
						response.end();
					} catch (error) {
						sendJson(response, 409, {
							error: "RUN_NOT_DELETABLE",
							message: error instanceof Error ? error.message : "删除失败，请重试。",
						});
					}
					return;
				}
				if (request.method === "POST" && action === "cancel") {
					if (!manager.cancel(runId)) {
						sendJson(response, 409, {
							error: "RUN_TERMINAL",
							message: "The run is already in a terminal state.",
						});
						return;
					}
					sendJson(response, 202, manager.get(runId));
					return;
				}
				if (request.method === "POST" && action === "continue") {
					if (!manager.getReadiness().available) {
						sendJson(response, 503, { error: "AGENT_UNAVAILABLE", message: "请先配置可用的 AI API。" });
						return;
					}
					const input = parseContinueRequest(await readJson(request, maxRequestBytes));
					try {
						sendJson(response, 202, manager.continue(runId, input));
					} catch (error) {
						sendJson(response, 409, {
							error: "RUN_NOT_CONTINUABLE",
							message: error instanceof Error ? error.message : "任务当前无法继续。",
						});
					}
					return;
				}
				if (request.method === "POST" && action === "retry") {
					if (!manager.getReadiness().available) {
						sendJson(response, 503, { error: "AGENT_UNAVAILABLE", message: "请先配置可用的 AI API。" });
						return;
					}
					try {
						sendJson(response, 202, manager.retry(runId));
					} catch (error) {
						sendJson(response, 409, {
							error: "RUN_NOT_RETRYABLE",
							message: error instanceof Error ? error.message : "任务不能续接。",
						});
					}
					return;
				}
				if (request.method === "GET" && (action === "archive" || action === "authoring")) {
					const directory = manager.getArtifactDirectory(runId);
					if (run.status !== "succeeded" || run.artifact === undefined || directory === undefined) {
						sendJson(response, 409, {
							error: "ARTIFACT_NOT_READY",
							message: "The run has not produced a validated Hydro artifact.",
						});
						return;
					}
					if (action === "authoring" && !run.artifact.authoring) {
						sendJson(response, 409, {
							error: "AUTHORING_NOT_READY",
							message: "此历史任务尚未生成 testlib 制题工程。",
						});
						return;
					}
					const archive =
						action === "authoring" && run.artifact.authoring
							? await buildAuthoringArchive(directory, runId, run.artifact.authoring.verificationId, {
									source: run.source,
									model: run.model,
								})
							: await buildHydroDirectoryArchive(directory);
					response.writeHead(200, {
						"cache-control": "no-store",
						"content-type": "application/zip",
						"content-disposition": `attachment; filename="${run.artifact.slug}.${action === "authoring" ? "authoring" : "hydro"}.zip"`,
						"content-length": archive.byteLength,
					});
					response.end(archive);
					return;
				}
				if (request.method === "GET" && action === "events") {
					const lastEventId = request.headers["last-event-id"];
					const headerSequence = Number.parseInt(
						Array.isArray(lastEventId) ? (lastEventId[0] ?? "0") : (lastEventId ?? "0"),
						10,
					);
					const querySequence = Number.parseInt(url.searchParams.get("after") ?? "0", 10);
					const afterSequence = Math.max(
						0,
						Number.isSafeInteger(headerSequence) ? headerSequence : 0,
						Number.isSafeInteger(querySequence) ? querySequence : 0,
					);
					response.writeHead(200, {
						"cache-control": "no-cache, no-transform",
						connection: "keep-alive",
						"content-type": "text/event-stream; charset=utf-8",
						"x-accel-buffering": "no",
					});
					response.flushHeaders();
					let closed = false;
					let unsubscribe: (() => void) | undefined;
					const finish = (): void => {
						if (closed) return;
						closed = true;
						unsubscribe?.();
						response.end();
					};
					unsubscribe = manager.subscribe(runId, (event) => {
						if (closed) return;
						writeServerEvent(response, event);
						if (event.status !== undefined && isTerminalRun(event.status)) finish();
					});
					for (const event of manager.getEvents(runId, afterSequence) ?? []) writeServerEvent(response, event);
					if (isTerminalRun(run.status)) finish();
					request.once("close", finish);
					return;
				}
			}
			if (request.method === "POST" && url.pathname === "/api/problems/validate") {
				const problem = parseProblemRequest(await readJson(request, maxRequestBytes));
				sendJson(response, 200, validateHydroProblemSpec(problem));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/problems/archive") {
				const problem = parseProblemRequest(await readJson(request, maxRequestBytes));
				const archive = buildHydroProblemArchive(problem);
				response.writeHead(200, {
					"cache-control": "no-store",
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="${problem.slug}.hydro.zip"`,
					"content-length": archive.byteLength,
				});
				response.end(archive);
				return;
			}
			if (request.method === "GET" && options.staticRoot !== undefined && !url.pathname.startsWith("/api/")) {
				if (await serveStatic(response, options.staticRoot, url.pathname)) return;
				if (!extname(url.pathname) && (await serveStatic(response, options.staticRoot, "/"))) return;
			}
			sendJson(response, 404, { error: "NOT_FOUND", message: "Route not found." });
		} catch (error) {
			if (error instanceof Error && error.name === "HydroAiConfigurationError") {
				sendJson(response, 400, { error: "AI_CONFIGURATION_INVALID", message: error.message });
				return;
			}
			if (error instanceof InvalidRequestError) {
				sendJson(response, 400, { error: "INVALID_REQUEST", message: error.message });
				return;
			}
			if (error instanceof HydroProblemValidationError) {
				sendJson(response, 422, { error: "INVALID_PROBLEM", report: error.report });
				return;
			}
			console.error(error);
			sendJson(response, 500, { error: "INTERNAL_ERROR", message: "The request could not be completed." });
		}
	});
}
