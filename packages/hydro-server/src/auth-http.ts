import type { IncomingMessage, ServerResponse } from "node:http";
import { AuthError, type IdentityStore, type SessionAccess } from "./identity.ts";
import type { WorkspaceRegistry } from "./workspace-registry.ts";

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(body));
}
async function body(request: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown>> {
	if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json")
		throw new AuthError("请求须使用 JSON。", 415);
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.length;
		if (size > maxBytes) throw new AuthError("请求体过大。", 413);
		chunks.push(bytes);
	}
	try {
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {}
	throw new AuthError("请求格式无效。", 400);
}

export class AuthHttp {
	private readonly identity: IdentityStore;
	private readonly registry: WorkspaceRegistry;
	private readonly publicOrigin?: string;
	private readonly secure: boolean;
	constructor(identity: IdentityStore, registry: WorkspaceRegistry, publicOrigin?: string) {
		this.identity = identity;
		this.registry = registry;
		if (publicOrigin) {
			const url = new URL(publicOrigin);
			if (
				url.origin !== publicOrigin ||
				url.username ||
				url.password ||
				(url.protocol !== "https:" &&
					!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
			)
				throw new Error("HYDRO_PUBLIC_ORIGIN 须为 HTTPS 站点来源；仅本机开发允许 HTTP。");
		}
		this.publicOrigin = publicOrigin;
		this.secure = publicOrigin?.startsWith("https://") ?? false;
	}
	private get cookieName(): string {
		return this.secure ? "__Host-setdraft-session" : "setdraft-session";
	}
	private token(request: IncomingMessage): string | undefined {
		return request.headers.cookie
			?.split(";")
			.map((item) => item.trim())
			.find((item) => item.startsWith(`${this.cookieName}=`))
			?.slice(this.cookieName.length + 1);
	}
	private cookie(response: ServerResponse, token: string, maxAge = 7 * 24 * 60 * 60): void {
		response.setHeader(
			"set-cookie",
			`${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`,
		);
	}
	checkOrigin(request: IncomingMessage, response: ServerResponse): void {
		const port = request.socket.localPort;
		const local = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
		const allowed = this.publicOrigin
			? [this.publicOrigin]
			: [...local, "http://127.0.0.1:5173", "http://localhost:5173"];
		if (![...allowed, ...local].some((value) => new URL(value).host === request.headers.host))
			throw new AuthError("浏览器来源不受支持。", 403, "ORIGIN_NOT_ALLOWED");
		const origin = request.headers.origin;
		const write = !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
		if ((origin !== undefined && !allowed.includes(origin)) || (write && !origin))
			throw new AuthError("浏览器来源不受支持。", 403, "ORIGIN_NOT_ALLOWED");
		if (origin) {
			response.setHeader("access-control-allow-origin", origin);
			response.setHeader("access-control-allow-credentials", "true");
			response.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
			response.setHeader(
				"access-control-allow-headers",
				"content-type, x-csrf-token, x-expected-revision, last-event-id",
			);
			response.setHeader("vary", "origin");
		}
	}
	private ip(request: IncomingMessage): string {
		const remote = request.socket.remoteAddress ?? "unknown";
		// The deployment contract is a same-host reverse proxy. Never trust a remote peer's forwarding headers.
		if (this.secure && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) {
			const forwarded = request.headers["x-forwarded-for"];
			if (typeof forwarded === "string") return forwarded.split(",").at(-1)?.trim().slice(0, 64) || remote;
		}
		return remote;
	}
	require(request: IncomingMessage, allowPasswordChange = false): SessionAccess {
		const access = this.identity.session(this.token(request));
		if (!access) throw new AuthError("登录已过期，请重新登录。", 401, "AUTH_REQUIRED");
		if (
			!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET") &&
			request.headers["x-csrf-token"] !== access.csrfToken
		)
			throw new AuthError("请求校验失败，请刷新后重试。", 403, "CSRF_INVALID");
		if (access.user.mustChangePassword && !allowPasswordChange)
			throw new AuthError("请先修改临时密码。", 403, "PASSWORD_CHANGE_REQUIRED");
		return access;
	}
	watch(access: SessionAccess, response: ServerResponse): void {
		const check = () => {
			if (!this.identity.session(access.tokenHash, false, true)) response.destroy();
		};
		const unsubscribe = this.identity.onChange(check);
		const timer = setInterval(check, 1000);
		timer.unref();
		response.once("close", () => {
			clearInterval(timer);
			unsubscribe();
		});
	}
	async handle(request: IncomingMessage, response: ServerResponse, path: string): Promise<boolean> {
		if (!path.startsWith("/api/auth/") && !path.startsWith("/api/admin/")) return false;
		if (path === "/api/auth/session" && request.method === "GET") {
			json(response, 200, this.identity.snapshot(this.identity.session(this.token(request))));
			return true;
		}
		if (["/api/auth/login", "/api/auth/setup"].includes(path) && request.method === "POST") {
			const input = await body(request);
			const user = path.endsWith("/setup")
				? await this.identity.setup(input, this.ip(request))
				: await this.identity.login(input, this.ip(request));
			const previous = this.identity.session(this.token(request), false);
			if (previous) this.identity.logout(previous);
			const session = this.identity.createSession(user.id);
			this.cookie(response, session.token);
			json(response, 200, this.identity.snapshot(session.access));
			return true;
		}
		const access = this.require(request, true);
		if (path === "/api/auth/logout" && request.method === "POST") {
			this.identity.logout(access);
			this.cookie(response, "", 0);
			json(response, 200, this.identity.snapshot());
			return true;
		}
		if (path === "/api/auth/password" && request.method === "PUT") {
			await this.identity.changePassword(access.user.id, await body(request));
			const session = this.identity.createSession(access.user.id);
			this.cookie(response, session.token);
			json(response, 200, this.identity.snapshot(session.access));
			return true;
		}
		if (path === "/api/auth/profile" && request.method === "PUT") {
			this.require(request);
			const input = await body(request, 192 * 1024);
			this.require(request);
			const user = this.identity.updateProfile(access.user.id, input);
			json(response, 200, this.identity.snapshot({ ...access, user }));
			return true;
		}
		if (path.startsWith("/api/admin/")) {
			this.identity.requireAdmin(access.user.id);
			if (path === "/api/admin/users" && request.method === "GET")
				json(response, 200, { users: this.identity.listUsers() });
			else if (path === "/api/admin/users" && request.method === "POST")
				json(response, 201, await this.identity.createUser(access.user.id, await body(request)));
			else {
				const match = /^\/api\/admin\/users\/([^/]+)(?:\/(reset-password))?$/u.exec(path);
				if (match && !match[2] && request.method === "PATCH") {
					const user = this.identity.updateUser(access.user.id, match[1], await body(request));
					if (!user.enabled) await this.registry.disable(user);
					json(response, 200, { user });
				} else if (match?.[2] === "reset-password" && request.method === "POST")
					json(response, 200, await this.identity.resetPassword(access.user.id, match[1]));
				else throw new AuthError("接口不存在。", 404, "NOT_FOUND");
			}
			return true;
		}
		throw new AuthError("接口不存在。", 404, "NOT_FOUND");
	}
}
