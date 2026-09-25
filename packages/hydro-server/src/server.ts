import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { ChatError, type ChatImageUpload, type ChatService } from "./chat.ts";
import { ContestStore } from "./contests.ts";
import type { HydroLiveVerifier } from "./live-hydro.ts";
import { ManualProjectError, type ManualProjectStore } from "./manual-projects.ts";

export interface HydroServerOptions {
	staticRoot?: string;
	maxRequestBytes?: number;
	projects: ManualProjectStore;
	chat: ChatService;
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
	if (response.destroyed || response.headersSent) return;
	const body = JSON.stringify(value);
	response.writeHead(statusCode, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
	});
	response.end(body);
}

function sendChatEvent(response: ServerResponse, event: "start" | "delta" | "done" | "error", value: unknown): void {
	if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
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
	if (contentType !== "application/json") throw new ManualProjectError("Content-Type 必须为 application/json。");
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const raw of request) {
		const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		total += bytes.byteLength;
		if (total > maxBytes) throw new ManualProjectError("请求体过大。", 413);
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new ManualProjectError("请求体不是有效 JSON。");
	}
}

async function sendFile(
	response: ServerResponse,
	path: string,
	name?: string,
	size?: number,
	contentType?: string,
): Promise<void> {
	const bytes = size ?? (await stat(path)).size;
	response.writeHead(200, {
		"cache-control": "no-store",
		"content-type": contentType ?? (name?.endsWith(".zip") ? "application/zip" : "application/octet-stream"),
		"content-length": bytes,
		...(name ? { "content-disposition": `attachment; filename="${name}"` } : {}),
	});
	createReadStream(path).pipe(response);
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

function readChatMessage(value: unknown): {
	message: string;
	contextSnapshot?: string;
	profileId?: string;
	images?: ChatImageUpload[];
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ChatError("消息格式无效。");
	const record = value as Record<string, unknown>;
	if (typeof record.message !== "string") throw new ChatError("请填写消息。");
	if (record.contextSnapshot !== undefined && typeof record.contextSnapshot !== "string") {
		throw new ChatError("题目上下文格式无效。");
	}
	if (record.profileId !== undefined && typeof record.profileId !== "string") {
		throw new ChatError("AI 配置 ID 无效。");
	}
	if (record.images !== undefined && !Array.isArray(record.images)) throw new ChatError("图片列表格式无效。");
	const images = record.images as unknown[] | undefined;
	if (
		images?.some((image) => {
			if (typeof image !== "object" || image === null || Array.isArray(image)) return true;
			const candidate = image as Record<string, unknown>;
			return (
				typeof candidate.name !== "string" ||
				typeof candidate.mimeType !== "string" ||
				typeof candidate.data !== "string"
			);
		})
	)
		throw new ChatError("图片列表格式无效。");
	return {
		message: record.message,
		contextSnapshot: record.contextSnapshot as string | undefined,
		profileId: record.profileId as string | undefined,
		images: images as ChatImageUpload[] | undefined,
	};
}

export function createHydroServer(options: HydroServerOptions): Server {
	const maxRequestBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
	const contests = new ContestStore(options.projects);
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			const origin = localBrowserOrigin(request);
			if (request.headers.origin !== undefined && origin === undefined && url.pathname.startsWith("/api/")) {
				sendJson(response, 403, { error: "ORIGIN_NOT_ALLOWED", message: "浏览器来源不受支持。" });
				return;
			}
			if (origin && url.pathname.startsWith("/api/")) {
				response.setHeader("access-control-allow-origin", origin);
				response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
				response.setHeader("access-control-allow-headers", "content-type");
				response.setHeader("vary", "origin");
			}
			if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
				response.writeHead(204, { "content-length": 0 });
				response.end();
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/health") {
				let sandbox: { available: boolean; image: string; message: string };
				try {
					await promisify(execFile)("docker", ["image", "inspect", options.projects.image], { timeout: 10_000 });
					sandbox = {
						available: true,
						image: options.projects.image,
						message: "Linux 沙箱已就绪 · GCC 16.2 · testlib.h 可用",
					};
				} catch (error) {
					sandbox = {
						available: false,
						image: options.projects.image,
						message: error instanceof Error ? error.message : "沙箱不可用",
					};
				}
				sendJson(response, 200, {
					status: "ok",
					sandbox,
					capabilities: {
						judgeLimits: options.projects.judgeLimits,
						maxFileBytes: options.projects.maxFileBytes,
						maxProjectBytes: options.projects.maxProjectBytes,
						aiChat: options.chat.getConfiguration().configured,
						liveHydro: options.liveVerifier?.status() ?? {
							configured: false,
							message: "未配置真实 Hydro 实测适配器。",
						},
					},
				});
				return;
			}
			if (url.pathname === "/api/ai/config") {
				if (request.method === "GET") sendJson(response, 200, options.chat.getConfiguration());
				else if (request.method === "PUT")
					sendJson(response, 200, await options.chat.configure(await readJson(request, maxRequestBytes)));
				else if (request.method === "DELETE") sendJson(response, 200, await options.chat.clearConfiguration());
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/ai/config/default" && request.method === "PUT") {
				const value = await readJson(request, maxRequestBytes);
				if (typeof value !== "object" || value === null || Array.isArray(value))
					throw new ChatError("默认配置无效。");
				const id = (value as Record<string, unknown>).profileId;
				if (typeof id !== "string") throw new ChatError("默认配置 ID 无效。");
				sendJson(response, 200, await options.chat.setDefaultProfile(id));
				return;
			}
			const configProfileRoute = /^\/api\/ai\/config\/([^/]+)$/u.exec(url.pathname);
			if (configProfileRoute && request.method === "DELETE") {
				sendJson(response, 200, await options.chat.removeProfile(configProfileRoute[1]));
				return;
			}
			if (url.pathname === "/api/contests") {
				if (request.method === "GET") sendJson(response, 200, { contests: await contests.list() });
				else if (request.method === "POST")
					sendJson(response, 201, await contests.create(await readJson(request, maxRequestBytes)));
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const contestRoute = /^\/api\/contests\/([^/]+)(?:\/(export))?$/u.exec(url.pathname);
			if (contestRoute) {
				const id = contestRoute[1];
				if (request.method === "GET" && !contestRoute[2]) sendJson(response, 200, await contests.get(id));
				else if (request.method === "PUT" && !contestRoute[2]) {
					sendJson(response, 200, await contests.update(id, await readJson(request, maxRequestBytes)));
				} else if (request.method === "POST" && contestRoute[2] === "export") {
					const value = await readJson(request, maxRequestBytes);
					const format =
						typeof value === "object" && value !== null && !Array.isArray(value)
							? (value as Record<string, unknown>).format
							: undefined;
					if (format !== "hydro" && format !== "domjudge") throw new ManualProjectError("竞赛导出格式无效。");
					sendJson(response, 201, await contests.export(id, format));
				} else if (request.method === "DELETE" && !contestRoute[2]) {
					await contests.delete(id);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/contest-releases" && request.method === "GET") {
				sendJson(response, 200, { releases: await contests.listReleases() });
				return;
			}
			const contestReleaseRoute = /^\/api\/contest-releases\/([^/]+)\/download$/u.exec(url.pathname);
			if (contestReleaseRoute) {
				if (request.method === "GET") {
					const file = await contests.releaseFile(contestReleaseRoute[1]);
					await sendFile(response, file.path, file.name, file.size);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/projects") {
				if (request.method === "GET") sendJson(response, 200, { projects: await options.projects.list() });
				else if (request.method === "POST") {
					const value = await readJson(request, maxRequestBytes);
					const scoringMode =
						typeof value === "object" && value !== null && !Array.isArray(value)
							? (value as Record<string, unknown>).scoringMode
							: undefined;
					if (scoringMode !== "acm" && scoringMode !== "oi") {
						throw new ManualProjectError("新建题目时须选择 ACM 或 OI 赛制。");
					}
					sendJson(response, 201, await options.projects.create(scoringMode));
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const textCaseRoute = /^\/api\/projects\/([^/]+)\/cases$/u.exec(url.pathname);
			if (textCaseRoute) {
				if (request.method === "POST") {
					sendJson(
						response,
						201,
						await options.projects.addTextCase(textCaseRoute[1], await readJson(request, maxRequestBytes)),
					);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const pdfRoute = /^\/api\/projects\/([^/]+)\/domjudge-pdf$/u.exec(url.pathname);
			if (pdfRoute) {
				const id = pdfRoute[1];
				if (request.method === "GET") {
					const file = await options.projects.domjudgePdfFile(id);
					await sendFile(response, file.path, "problem.pdf", file.size, "application/pdf");
				} else if (request.method === "PUT") {
					if (request.headers["content-type"]?.split(";", 1)[0] !== "application/pdf") {
						throw new ManualProjectError("上传题面须使用 application/pdf。");
					}
					sendJson(response, 200, await options.projects.uploadDomjudgePdf(id, request));
				} else if (request.method === "DELETE") {
					sendJson(response, 200, await options.projects.deleteDomjudgePdf(id));
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const fileRoute = /^\/api\/projects\/([^/]+)\/files\/([^/]+)$/u.exec(url.pathname);
			if (fileRoute) {
				const id = fileRoute[1];
				let name: string;
				try {
					name = decodeURIComponent(fileRoute[2]);
				} catch {
					throw new ManualProjectError("文件名编码无效。");
				}
				if (request.method === "GET") {
					const requestedOrigin = url.searchParams.get("origin");
					const fileOrigin =
						requestedOrigin === "manual" || requestedOrigin === "generated" ? requestedOrigin : undefined;
					if (requestedOrigin !== null && !fileOrigin) {
						throw new ManualProjectError("测试文件来源无效。");
					}
					const file = await options.projects.file(id, name, fileOrigin);
					await sendFile(response, file.path, undefined, file.size);
				} else if (request.method === "PUT") {
					if (request.headers["content-type"]?.split(";", 1)[0] !== "application/octet-stream") {
						throw new ManualProjectError("上传数据须使用 application/octet-stream。");
					}
					sendJson(response, 200, await options.projects.upload(id, name, request));
				} else if (request.method === "DELETE")
					sendJson(response, 200, await options.projects.deleteFile(id, name));
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const projectRoute = /^\/api\/projects\/([^/]+)(?:\/(generate|finalize))?$/u.exec(url.pathname);
			if (projectRoute) {
				const id = projectRoute[1];
				const action = projectRoute[2];
				if (request.method === "GET" && !action) sendJson(response, 200, await options.projects.get(id));
				else if (request.method === "PUT" && !action)
					sendJson(response, 200, await options.projects.update(id, await readJson(request, maxRequestBytes)));
				else if (request.method === "DELETE" && !action) {
					const releaseIds = (await options.projects.listReleases())
						.filter((release) => release.projectId === id)
						.map((release) => release.id);
					await contests.assertProblemReleasesUnreferenced(releaseIds);
					await options.projects.delete(id);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
				} else if (request.method === "POST" && action === "generate")
					sendJson(response, 200, await options.projects.generate(id));
				else if (request.method === "POST" && action === "finalize")
					sendJson(response, 200, await options.projects.finalize(id));
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const exportRoute = /^\/api\/releases\/([^/]+)\/exports\/(domjudge|fps|qduoj)$/u.exec(url.pathname);
			if (exportRoute) {
				if (request.method === "POST") {
					const format = exportRoute[2] as "domjudge" | "fps" | "qduoj";
					const file =
						format === "domjudge"
							? await options.projects.exportDomjudge(exportRoute[1])
							: await options.projects.exportLegacy(exportRoute[1], format);
					sendJson(response, 200, { name: file.name, download: `/api/releases/${exportRoute[1]}/${format}` });
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const releaseRoute = /^\/api\/releases\/([^/]+)\/(hydro|source|domjudge|fps|qduoj|report|live-verify)$/u.exec(
				url.pathname,
			);
			if (request.method === "GET" && url.pathname === "/api/releases") {
				sendJson(response, 200, { releases: await options.projects.listReleases() });
				return;
			}
			if (releaseRoute) {
				const id = releaseRoute[1];
				const action = releaseRoute[2];
				if (request.method === "GET" && action === "report")
					sendJson(response, 200, (await options.projects.release(id)).report);
				else if (
					request.method === "GET" &&
					(action === "hydro" ||
						action === "source" ||
						action === "domjudge" ||
						action === "fps" ||
						action === "qduoj")
				) {
					const file = await options.projects.releaseFile(id, action);
					await sendFile(
						response,
						file.path,
						file.name,
						file.size,
						action === "fps" ? "application/xml; charset=utf-8" : undefined,
					);
				} else if (request.method === "POST" && action === "live-verify") {
					if (!options.liveVerifier) throw new ManualProjectError("真实 Hydro 实测适配器未配置。", 503);
					const release = await options.projects.release(id);
					const result = await options.liveVerifier.verify({
						releaseId: id,
						slug: release.slug,
						packageDirectory: joinReleaseHydroDirectory(options.projects, release.id, release.slug),
						reference: await options.projects.releaseReference(id),
						wrongPrograms: [],
					});
					await options.projects.recordLiveVerification(id, result);
					sendJson(response, 200, result);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/chats") {
				if (request.method === "GET") sendJson(response, 200, { chats: await options.chat.list() });
				else if (request.method === "POST") sendJson(response, 201, await options.chat.create());
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const chatImageRoute = /^\/api\/chats\/([^/]+)\/images\/([^/]+)$/u.exec(url.pathname);
			if (chatImageRoute) {
				if (request.method === "GET") {
					const image = await options.chat.image(chatImageRoute[1], chatImageRoute[2]);
					await sendFile(response, image.path, undefined, undefined, image.mimeType);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const chatRoute = /^\/api\/chats\/([^/]+)(?:\/(messages))?$/u.exec(url.pathname);
			if (chatRoute) {
				const id = chatRoute[1];
				if (request.method === "GET" && !chatRoute[2]) sendJson(response, 200, await options.chat.get(id));
				else if (request.method === "DELETE" && !chatRoute[2]) {
					await options.chat.delete(id);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
				} else if (request.method === "POST" && chatRoute[2] === "messages") {
					const { message, contextSnapshot, profileId, images } = readChatMessage(
						await readJson(request, maxRequestBytes),
					);
					const controller = new AbortController();
					response.once("close", () => {
						if (!response.writableEnded) controller.abort();
					});
					response.writeHead(200, {
						"cache-control": "no-cache, no-transform",
						"content-type": "text/event-stream; charset=utf-8",
						connection: "keep-alive",
						"x-accel-buffering": "no",
					});
					response.flushHeaders();
					const heartbeat = setInterval(() => {
						if (!response.destroyed) response.write(": ping\n\n");
					}, 15_000);
					heartbeat.unref();
					try {
						const chat = await options.chat.send(
							id,
							message,
							contextSnapshot,
							{
								onStart: (started) => sendChatEvent(response, "start", { chat: started }),
								onDelta: (delta) => sendChatEvent(response, "delta", { delta }),
							},
							controller.signal,
							profileId,
							images,
						);
						sendChatEvent(response, "done", { chat });
					} catch (error) {
						sendChatEvent(response, "error", {
							message: error instanceof Error ? error.message : "AI 请求失败。",
						});
					} finally {
						clearInterval(heartbeat);
						response.end();
					}
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (request.method === "GET" && options.staticRoot && !url.pathname.startsWith("/api/")) {
				if (await serveStatic(response, options.staticRoot, url.pathname)) return;
				if (!extname(url.pathname) && (await serveStatic(response, options.staticRoot, "/"))) return;
			}
			sendJson(response, 404, { error: "NOT_FOUND", message: "接口不存在。" });
		} catch (error) {
			if (error instanceof ManualProjectError || error instanceof ChatError) {
				sendJson(response, error.statusCode, { error: error.name, message: error.message });
				return;
			}
			console.error(error);
			sendJson(response, 500, {
				error: "INTERNAL_ERROR",
				message: error instanceof Error ? error.message : "服务器内部错误。",
			});
		}
	});
}

function joinReleaseHydroDirectory(projects: ManualProjectStore, id: string, slug: string): string {
	return resolve(projects.root, "releases", id, "hydro", slug);
}
