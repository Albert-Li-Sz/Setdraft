import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { AuthHttp } from "./auth-http.ts";
import { ChatError, type ChatImageUpload, type ChatService } from "./chat.ts";
import { streamEvents } from "./event-stream.ts";
import { AuthError, type IdentityStore } from "./identity.ts";
import { ManualProjectError, type ManualProjectStore } from "./manual-projects.ts";
import { copyProject, restoreProject } from "./project-history.ts";
import { releaseName } from "./releases.ts";
import { WorkspaceRegistry } from "./workspace-registry.ts";

export interface HydroServerOptions {
	identity: IdentityStore;
	publicOrigin?: string;
	staticRoot?: string;
	maxRequestBytes?: number;
	projects: ManualProjectStore;
	chat: ChatService;
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

function expectedRevision(request: IncomingMessage): number | undefined {
	const header = request.headers["x-expected-revision"];
	if (header === undefined) return undefined;
	if (typeof header !== "string" || !/^(0|[1-9]\d*)$/u.test(header)) {
		throw new ManualProjectError("题目版本无效。", 422);
	}
	const value = Number(header);
	if (!Number.isSafeInteger(value)) throw new ManualProjectError("题目版本无效。", 422);
	return value;
}

async function readChatSubmission(
	request: IncomingMessage,
	maxBytes: number,
): Promise<ReturnType<typeof readChatMessage> & { requestId: string }> {
	const contentType = request.headers["content-type"] ?? "";
	if (contentType.startsWith("application/json")) {
		const value = await readJson(request, maxBytes);
		const parsed = readChatMessage(value);
		const requestId =
			typeof value === "object" && value !== null && "requestId" in value ? String(value.requestId) : "";
		return { ...parsed, requestId };
	}
	if (!contentType.startsWith("multipart/form-data;")) throw new ChatError("消息须使用 multipart/form-data。", 415);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const raw of request) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		size += chunk.length;
		if (size > maxBytes) throw new ChatError("消息或图片超过大小限制。", 413);
		chunks.push(chunk);
	}
	const form = await new Request("http://localhost", {
		method: "POST",
		headers: { "content-type": contentType },
		body: new Uint8Array(Buffer.concat(chunks)),
	}).formData();
	const field = (name: string) => {
		const value = form.get(name);
		return typeof value === "string" ? value : undefined;
	};
	const images: ChatImageUpload[] = [];
	for (const item of form.getAll("images")) {
		if (typeof item === "string") throw new ChatError("图片格式无效。", 422);
		images.push({
			name: item.name,
			mimeType: item.type,
			data: Buffer.from(await item.arrayBuffer()).toString("base64"),
		});
	}
	return {
		requestId: field("requestId") ?? "",
		message: field("message") ?? "",
		contextSnapshot: field("contextSnapshot"),
		profileId: field("profileId"),
		images,
	};
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
	const stream = createReadStream(path);
	response.once("close", () => stream.destroy());
	stream.on("error", () => response.destroy());
	stream.pipe(response);
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

export function createHydroServer(options: HydroServerOptions): Server & { closeWorkspaces(): Promise<void> } {
	const maxRequestBytes = options.maxRequestBytes ?? 32 * 1024 * 1024;
	const registry = new WorkspaceRegistry(options.identity, options.projects, options.chat);
	const ready = registry.start();
	const auth = new AuthHttp(options.identity, registry, options.publicOrigin);
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			response.setHeader("x-content-type-options", "nosniff");
			response.setHeader("referrer-policy", "same-origin");
			response.setHeader("x-frame-options", "DENY");
			await ready;
			if (!url.pathname.startsWith("/api/")) {
				if (request.method === "GET" && options.staticRoot) {
					if (await serveStatic(response, options.staticRoot, url.pathname)) return;
					if (!extname(url.pathname) && (await serveStatic(response, options.staticRoot, "/"))) return;
				}
				sendJson(response, 404, { error: "NOT_FOUND", message: "接口不存在。" });
				return;
			}
			auth.checkOrigin(request, response);
			if (request.method === "OPTIONS") {
				response.writeHead(204);
				response.end();
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/health") {
				sendJson(response, 200, { status: "ok" });
				return;
			}
			if (await auth.handle(request, response, url.pathname)) return;
			const access = auth.require(request);
			response.setHeader("x-setdraft-user", access.user.id);
			const { projects, chat, contests, tasks, chatRequests } = registry.get(access.user);
			if (
				(url.pathname.startsWith("/api/ai/config") && request.method !== "GET") ||
				url.pathname === "/api/sandbox/build"
			)
				options.identity.requireAdmin(access.user.id);
			auth.watch(access, response);
			if (request.method === "GET" && url.pathname === "/api/system/status") {
				let sandbox: { available: boolean; image: string; message: string; state: string };
				try {
					await promisify(execFile)("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10_000 });
					await promisify(execFile)("docker", ["image", "inspect", projects.image], { timeout: 10_000 });
					sandbox = {
						available: true,
						state: "ready",
						image: projects.image,
						message: "Linux 沙箱已就绪 · GCC 16.2 · testlib.h 可用",
					};
				} catch (error) {
					let daemon = false;
					try {
						await promisify(execFile)("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 5000 });
						daemon = true;
					} catch {
						daemon = false;
					}
					sandbox = {
						available: false,
						state: daemon ? "image-missing" : "daemon-unavailable",
						image: projects.image,
						message: daemon
							? "沙盒镜像缺失，请在设置中构建。"
							: `Docker 守护进程未运行：${error instanceof Error ? error.message : "请启动 Docker"}`,
					};
				}
				sendJson(response, 200, {
					status: "ok",
					sandbox,
					capabilities: {
						judgeLimits: projects.judgeLimits,
						maxFileBytes: projects.maxFileBytes,
						maxProjectBytes: projects.maxProjectBytes,
						aiChat: chat.getConfiguration().configured,
						tasks: true,
					},
				});
				return;
			}
			if (url.pathname === "/api/sandbox/build" && request.method === "POST") {
				sendJson(response, 202, { task: await tasks.submit("image-build", "image") });
				return;
			}
			if (url.pathname === "/api/tasks" && request.method === "GET") {
				sendJson(response, 200, { tasks: tasks.list() });
				return;
			}
			const taskRoute = /^\/api\/tasks\/([^/]+)(?:\/(events|cancel|retry))?$/u.exec(url.pathname);
			if (taskRoute) {
				const id = taskRoute[1];
				const action = taskRoute[2];
				if (request.method === "GET" && !action) sendJson(response, 200, tasks.get(id));
				else if (request.method === "POST" && action === "cancel") sendJson(response, 200, await tasks.cancel(id));
				else if (request.method === "POST" && action === "retry") {
					if (tasks.get(id).kind === "image-build") options.identity.requireAdmin(access.user.id);
					sendJson(response, 202, { task: await tasks.retry(id) });
				} else if (request.method === "GET" && action === "events") {
					const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
					if (!Number.isSafeInteger(after) || after < 0) throw new ManualProjectError("事件序号无效。", 422);
					tasks.get(id);
					streamEvents(response, {
						after,
						read: (cursor) => tasks.events(id, cursor),
						isTerminal: () =>
							["succeeded", "failed", "cancelled", "stale", "interrupted"].includes(tasks.get(id).state),
						data: (event) => event,
					});
					return;
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/ai/config") {
				if (request.method === "GET") {
					const configuration = chat.getConfiguration();
					sendJson(
						response,
						200,
						access.user.role === "admin"
							? configuration
							: {
									...configuration,
									profiles: configuration.profiles.map(({ baseUrl: _baseUrl, ...profile }) => profile),
								},
					);
				} else if (request.method === "PUT") {
					const input = await readJson(request, maxRequestBytes);
					options.identity.requireAdmin(access.user.id);
					sendJson(response, 200, await chat.configure(input));
				} else if (request.method === "DELETE") sendJson(response, 200, await chat.clearConfiguration());
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/ai/config/default" && request.method === "PUT") {
				const value = await readJson(request, maxRequestBytes);
				options.identity.requireAdmin(access.user.id);
				if (typeof value !== "object" || value === null || Array.isArray(value))
					throw new ChatError("默认配置无效。");
				const id = (value as Record<string, unknown>).profileId;
				if (typeof id !== "string") throw new ChatError("默认配置 ID 无效。");
				sendJson(response, 200, await chat.setDefaultProfile(id));
				return;
			}
			const profileTestRoute = /^\/api\/ai\/config\/([^/]+)\/test$/u.exec(url.pathname);
			if (profileTestRoute && request.method === "POST") {
				sendJson(response, 200, await registry.testProfile(access.user, profileTestRoute[1]));
				return;
			}
			const configProfileRoute = /^\/api\/ai\/config\/([^/]+)$/u.exec(url.pathname);
			if (configProfileRoute && request.method === "DELETE") {
				sendJson(response, 200, await chat.removeProfile(configProfileRoute[1]));
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
					sendJson(response, 202, { task: await tasks.submit("contest-export", id, format) });
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
				if (request.method === "GET") sendJson(response, 200, { projects: await projects.list() });
				else if (request.method === "POST") {
					const value = await readJson(request, maxRequestBytes);
					const scoringMode =
						typeof value === "object" && value !== null && !Array.isArray(value)
							? (value as Record<string, unknown>).scoringMode
							: undefined;
					if (scoringMode !== "acm" && scoringMode !== "oi") {
						throw new ManualProjectError("新建题目时须选择 ACM 或 OI 赛制。");
					}
					sendJson(response, 201, await projects.create(scoringMode));
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const textCaseRoute = /^\/api\/projects\/([^/]+)\/cases$/u.exec(url.pathname);
			if (textCaseRoute) {
				if (request.method === "POST") {
					sendJson(
						response,
						201,
						await projects.addTextCase(textCaseRoute[1], await readJson(request, maxRequestBytes)),
					);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const caseBatchRoute = /^\/api\/projects\/([^/]+)\/cases\/(batch-delete|renumber)$/u.exec(url.pathname);
			if (caseBatchRoute) {
				const id = caseBatchRoute[1];
				if (request.method === "GET" && caseBatchRoute[2] === "renumber")
					sendJson(response, 200, { changes: await projects.renumberPreview(id) });
				else if (request.method === "POST") {
					const value = await readJson(request, maxRequestBytes);
					if (typeof value !== "object" || value === null || Array.isArray(value))
						throw new ManualProjectError("请求格式无效。", 422);
					const body = value as Record<string, unknown>;
					const revision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
					if (caseBatchRoute[2] === "renumber")
						sendJson(response, 200, await projects.renumberCases(id, revision));
					else {
						if (!Array.isArray(body.stems) || body.stems.some((item) => typeof item !== "string"))
							throw new ManualProjectError("测试点列表无效。", 422);
						sendJson(response, 200, await projects.deleteCases(id, body.stems as string[], revision));
					}
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const generatedRoute = /^\/api\/projects\/([^/]+)\/generated$/u.exec(url.pathname);
			if (generatedRoute && request.method === "DELETE") {
				const expectedRevision = Number(request.headers["x-expected-revision"]);
				sendJson(
					response,
					200,
					await projects.clearGenerated(
						generatedRoute[1],
						Number.isSafeInteger(expectedRevision) && request.headers["x-expected-revision"] !== undefined
							? expectedRevision
							: undefined,
					),
				);
				return;
			}
			const casePreviewRoute = /^\/api\/projects\/([^/]+)\/cases\/(manual|generated)\/([^/]+)\/preview$/u.exec(
				url.pathname,
			);
			if (casePreviewRoute && request.method === "GET") {
				sendJson(
					response,
					200,
					await projects.casePreview(
						casePreviewRoute[1],
						casePreviewRoute[2] as "manual" | "generated",
						decodeURIComponent(casePreviewRoute[3]),
					),
				);
				return;
			}
			const pdfRoute = /^\/api\/projects\/([^/]+)\/domjudge-pdf$/u.exec(url.pathname);
			if (pdfRoute) {
				const id = pdfRoute[1];
				if (request.method === "GET") {
					const file = await projects.domjudgePdfFile(id);
					await sendFile(response, file.path, "problem.pdf", file.size, "application/pdf");
				} else if (request.method === "PUT") {
					if (request.headers["content-type"]?.split(";", 1)[0] !== "application/pdf") {
						throw new ManualProjectError("上传题面须使用 application/pdf。");
					}
					sendJson(response, 200, await projects.uploadDomjudgePdf(id, request, expectedRevision(request)));
				} else if (request.method === "DELETE") {
					sendJson(response, 200, await projects.deleteDomjudgePdf(id, expectedRevision(request)));
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
					const file = await projects.file(id, name, fileOrigin);
					await sendFile(response, file.path, undefined, file.size);
				} else if (request.method === "PUT") {
					if (request.headers["content-type"]?.split(";", 1)[0] !== "application/octet-stream") {
						throw new ManualProjectError("上传数据须使用 application/octet-stream。");
					}
					sendJson(response, 200, await projects.upload(id, name, request, expectedRevision(request)));
				} else if (request.method === "DELETE")
					sendJson(response, 200, await projects.deleteFile(id, name, expectedRevision(request)));
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/people" && request.method === "GET") {
				sendJson(response, 200, {
					users: options.identity
						.listUsers()
						.filter((user) => user.enabled && user.id !== access.user.id)
						.map(({ id, username }) => ({ id, username })),
				});
				return;
			}
			const historyRoute = /^\/api\/projects\/([^/]+)\/(copy|releases)(?:\/([^/]+)\/(restore))?$/u.exec(
				url.pathname,
			);
			if (historyRoute) {
				const [, id, action, releaseId] = historyRoute;
				await projects.get(id);
				if (action === "releases" && !releaseId && request.method === "GET") {
					sendJson(response, 200, {
						releases: (await projects.releases.listReleases()).filter((release) => release.projectId === id),
					});
				} else if (request.method === "POST") {
					const input = (await readJson(request, 4096)) as {
						recipientId?: unknown;
						expectedRevision?: unknown;
					} | null;
					if (!input || typeof input !== "object" || Array.isArray(input))
						throw new ManualProjectError("请求格式无效。", 422);
					const assertAccess = () => {
						auth.require(request);
					};
					if (action === "copy" && !releaseId) {
						if (typeof input.recipientId !== "string" || input.recipientId === access.user.id)
							throw new ManualProjectError("请选择其他用户。", 422);
						const recipient = options.identity.getUser(input.recipientId);
						if (!recipient.enabled) throw new ManualProjectError("接收用户不存在。", 404);
						const target = registry.get(recipient).projects;
						const copied = await copyProject(projects, id, target, input.expectedRevision, () => {
							assertAccess();
							registry.get(recipient);
						});
						sendJson(response, 201, { id: copied.id, title: copied.title, username: recipient.username });
					} else if (action === "releases" && releaseId) {
						sendJson(
							response,
							200,
							await restoreProject(projects, id, releaseId, input.expectedRevision, assertAccess),
						);
					} else throw new ManualProjectError("接口不存在。", 404);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const projectRoute = /^\/api\/projects\/([^/]+)(?:\/(generate|finalize))?$/u.exec(url.pathname);
			if (projectRoute) {
				const id = projectRoute[1];
				const action = projectRoute[2];
				if (request.method === "GET" && !action) sendJson(response, 200, await projects.get(id));
				else if (request.method === "PUT" && !action)
					sendJson(response, 200, await projects.update(id, await readJson(request, maxRequestBytes)));
				else if (request.method === "DELETE" && !action) {
					const releaseIds = (await projects.releases.listReleases())
						.filter((release) => release.projectId === id)
						.map((release) => release.id);
					await contests.assertProblemReleasesUnreferenced(releaseIds);
					await projects.delete(id);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
				} else if (request.method === "POST" && action === "generate")
					sendJson(response, 202, { task: await tasks.submit("generate", id) });
				else if (request.method === "POST" && action === "finalize") {
					let name: string | undefined;
					if (request.headers["content-type"]) {
						const input = (await readJson(request, 4096)) as { name?: unknown } | null;
						if (!input || typeof input !== "object" || Array.isArray(input))
							throw new ManualProjectError("请求格式无效。", 422);
						if (input.name !== undefined) name = releaseName(input.name);
					}
					sendJson(response, 202, { task: await tasks.submit("finalize", id, undefined, name) });
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const exportRoute = /^\/api\/releases\/([^/]+)\/exports\/(domjudge|fps|qduoj)$/u.exec(url.pathname);
			if (exportRoute) {
				if (request.method === "POST") {
					const format = exportRoute[2] as "domjudge" | "fps" | "qduoj";
					const file =
						format === "domjudge"
							? await projects.releases.exportDomjudge(exportRoute[1])
							: await projects.releases.exportLegacy(exportRoute[1], format);
					sendJson(response, 200, { name: file.name, download: `/api/releases/${exportRoute[1]}/${format}` });
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const releaseRoute = /^\/api\/releases\/([^/]+)\/(hydro|source|domjudge|fps|qduoj|report)$/u.exec(
				url.pathname,
			);
			if (request.method === "GET" && url.pathname === "/api/releases") {
				sendJson(response, 200, { releases: await projects.releases.listReleases() });
				return;
			}
			const releaseDeleteRoute = /^\/api\/releases\/([^/]+)$/u.exec(url.pathname);
			if (releaseDeleteRoute && request.method === "PATCH") {
				const input = (await readJson(request, 4096)) as { name?: unknown } | null;
				sendJson(response, 200, await projects.releases.rename(releaseDeleteRoute[1], input?.name));
				return;
			}
			if (releaseDeleteRoute && request.method === "DELETE") {
				await contests.assertProblemReleasesUnreferenced([releaseDeleteRoute[1]]);
				await projects.releases.deleteRelease(releaseDeleteRoute[1]);
				response.writeHead(204, { "cache-control": "no-store" });
				response.end();
				return;
			}
			if (releaseRoute) {
				const id = releaseRoute[1];
				const action = releaseRoute[2];
				if (request.method === "GET" && action === "report")
					sendJson(response, 200, (await projects.releases.release(id)).report);
				else if (
					request.method === "GET" &&
					(action === "hydro" ||
						action === "source" ||
						action === "domjudge" ||
						action === "fps" ||
						action === "qduoj")
				) {
					const file = await projects.releases.releaseFile(id, action);
					await sendFile(
						response,
						file.path,
						file.name,
						file.size,
						action === "fps" ? "application/xml; charset=utf-8" : undefined,
					);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (url.pathname === "/api/chats") {
				if (request.method === "GET") sendJson(response, 200, { chats: await chat.list() });
				else if (request.method === "POST") sendJson(response, 201, await chat.create());
				else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const chatImageRoute = /^\/api\/chats\/([^/]+)\/images\/([^/]+)$/u.exec(url.pathname);
			if (chatImageRoute) {
				if (request.method === "GET") {
					const image = await chat.image(chatImageRoute[1], chatImageRoute[2]);
					await sendFile(response, image.path, undefined, undefined, image.mimeType);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			const chatRoute = /^\/api\/chats\/([^/]+)(?:\/(messages))?$/u.exec(url.pathname);
			const chatRequestsRoute = /^\/api\/chats\/([^/]+)\/requests$/u.exec(url.pathname);
			if (chatRequestsRoute && request.method === "GET") {
				await chat.get(chatRequestsRoute[1]);
				sendJson(response, 200, { requests: chatRequests.list(chatRequestsRoute[1]) });
				return;
			}
			const chatRequestRoute = /^\/api\/chats\/([^/]+)\/requests\/([^/]+)(?:\/(events|retry|cancel))?$/u.exec(
				url.pathname,
			);
			if (chatRequestRoute) {
				const [, chatId, requestId, action] = chatRequestRoute;
				if (request.method === "GET" && !action) sendJson(response, 200, chatRequests.get(requestId, chatId));
				else if (request.method === "POST" && action === "retry")
					sendJson(response, 202, await chatRequests.retry(chatId, requestId));
				else if (request.method === "POST" && action === "cancel")
					sendJson(response, 200, await chatRequests.cancel(chatId, requestId));
				else if (request.method === "GET" && action === "events") {
					const after = Number(request.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
					if (!Number.isSafeInteger(after) || after < 0) throw new ChatError("事件序号无效。", 422);
					chatRequests.get(requestId, chatId);
					streamEvents(response, {
						after,
						read: (cursor) => chatRequests.events(requestId, chatId, cursor),
						isTerminal: () => ["done", "failed"].includes(chatRequests.get(requestId, chatId).state),
						data: (event) => event.data,
					});
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			if (chatRoute) {
				const id = chatRoute[1];
				if (request.method === "GET" && !chatRoute[2]) sendJson(response, 200, await chat.get(id));
				else if (request.method === "DELETE" && !chatRoute[2]) {
					await chat.delete(id);
					response.writeHead(204, { "cache-control": "no-store" });
					response.end();
				} else if (request.method === "POST" && chatRoute[2] === "messages") {
					const { requestId, message, contextSnapshot, profileId, images } = await readChatSubmission(
						request,
						maxRequestBytes,
					);
					sendJson(
						response,
						202,
						await chatRequests.submit(id, requestId, message, contextSnapshot, profileId, images),
					);
				} else sendJson(response, 405, { error: "METHOD_NOT_ALLOWED", message: "不支持该方法。" });
				return;
			}
			sendJson(response, 404, { error: "NOT_FOUND", message: "接口不存在。" });
		} catch (error) {
			if (error instanceof AuthError) {
				if (error.statusCode === 429) response.setHeader("retry-after", "900");
				sendJson(response, error.statusCode, { error: error.code, message: error.message });
				return;
			}
			if (error instanceof ManualProjectError || error instanceof ChatError) {
				sendJson(response, error.statusCode, {
					error: error.name,
					message: error.message,
					...(error instanceof ManualProjectError && error.current ? { current: error.current } : {}),
				});
				return;
			}
			console.error("API request failed:", error instanceof Error ? error.name : "unknown");
			sendJson(response, 500, {
				error: "INTERNAL_ERROR",
				message: "服务器内部错误。",
			});
		}
	});
	let closing: Promise<void> | undefined;
	const closeWorkspaces = () => {
		closing ??= ready.then(() => registry.close());
		return closing;
	};
	server.once("close", () => {
		void closeWorkspaces().catch(() => console.error("Workspace shutdown failed."));
	});
	return Object.assign(server, { closeWorkspaces });
}
