import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";

import { resolve } from "node:path";
import type { AuthSession, AuthUser, UserPreferences, UserRole } from "@setdraft/contracts";
import { PostgresScope } from "./postgres.ts";

const day = 86_400_000;
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
let hashing = 0;
const hashWaiters: Array<() => void> = [];

export class AuthError extends Error {
	readonly statusCode: number;
	readonly code: string;
	constructor(message: string, statusCode = 400, code = "AUTH_ERROR") {
		super(message);
		this.name = "AuthError";
		this.statusCode = statusCode;
		this.code = code;
	}
}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
	if (hashing >= 2) {
		if (hashWaiters.length >= 16) throw new AuthError("登录请求过多，请稍后重试。", 429, "RATE_LIMITED");
		await new Promise<void>((resolve) => hashWaiters.push(resolve));
	} else hashing++;
	try {
		return await new Promise<Buffer>((resolve, reject) => {
			scrypt(password, salt, 64, { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => {
				if (error) reject(error);
				else resolve(key);
			});
		});
	} finally {
		const next = hashWaiters.shift();
		if (next) next();
		else hashing--;
	}
}

async function passwordHash(value: unknown): Promise<string> {
	if (typeof value !== "string" || [...value].length < 15 || [...value].length > 128)
		throw new AuthError("密码须为 15–128 个字符。", 422);
	const salt = randomBytes(16);
	return `scrypt$${salt.toString("hex")}$${(await derive(value, salt)).toString("hex")}`;
}

async function verifyPassword(value: unknown, stored?: string): Promise<boolean> {
	if (typeof value !== "string" || [...value].length > 128) return false;
	const [, salt, key] = (stored ?? `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`).split("$");
	const actual = await derive(value, Buffer.from(salt, "hex"));
	return Boolean(stored) && timingSafeEqual(actual, Buffer.from(key, "hex"));
}

function username(value: unknown): string {
	if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,31}$/u.test(value))
		throw new AuthError("用户名须为 3–32 位字母、数字、点、下划线或短横线。", 422);
	return value.toLowerCase();
}

interface UserRow {
	id: string;
	username: string;
	role: UserRole;
	enabled: number;
	must_change_password: number;
	password_hash: string;
	created_at: number;
}

export interface SessionAccess {
	user: AuthUser;
	tokenHash: string;
	csrfToken: string;
	expiresAt: number;
}

function publicUser(row: UserRow): AuthUser {
	return {
		id: row.id,
		username: row.username,
		role: row.role,
		enabled: Boolean(row.enabled),
		mustChangePassword: Boolean(row.must_change_password),
		createdAt: new Date(row.created_at).toISOString(),
	};
}

/** Identity is deliberately independent of any user's workspace database. */
export class IdentityStore {
	readonly root: string;
	readonly sql: PostgresScope;
	private readonly now: () => number;
	private readonly listeners = new Set<() => void>();
	constructor(root: string, now: () => number = Date.now) {
		this.root = resolve(root);
		this.now = now;
		this.sql = new PostgresScope(root, "identity");
	}
	close(): void {}
	private transaction<T>(work: () => Promise<T> | T): Promise<T> {
		return this.sql.transaction(work);
	}
	private async metadata(key: string): Promise<string | undefined> {
		return ((await this.sql.one("SELECT value FROM metadata WHERE key=$1", [key])) as { value: string } | undefined)
			?.value;
	}
	async isInitialized(): Promise<boolean> {
		return Boolean(await this.metadata("initialized"));
	}
	async getSetting(key: string): Promise<unknown> {
		const row = (await this.sql.one("SELECT value FROM settings WHERE key=$1", [key])) as
			| { value: string }
			| undefined;
		return row ? (JSON.parse(row.value) as unknown) : undefined;
	}
	async setSetting(key: string, value: unknown): Promise<void> {
		await this.sql.execute(
			"INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
			[key, JSON.stringify(value)],
		);
	}
	private async audit(actor: string | undefined, action: string, subject?: string): Promise<void> {
		await this.sql.execute("INSERT INTO audit(actor_id,action,subject_id,created_at) VALUES($1,$2,$3,$4)", [
			actor ?? null,
			action,
			subject ?? null,
			this.now(),
		]);
	}
	async rotateSetupToken(): Promise<string> {
		return await this.transaction(async () => {
			if (await this.isInitialized()) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
			const token = secret();
			await this.sql.execute(
				"INSERT INTO metadata(key,value) VALUES('setup',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
				[JSON.stringify({ hash: hashToken(token), expiresAt: this.now() + day })],
			);
			return token;
		});
	}
	private async validSetupToken(token: unknown): Promise<boolean> {
		const value = await this.metadata("setup");
		if (typeof token !== "string" || !value) return false;
		const stored = JSON.parse(value) as { hash: string; expiresAt: number };
		return (
			stored.expiresAt > this.now() &&
			timingSafeEqual(Buffer.from(stored.hash, "hex"), Buffer.from(hashToken(token), "hex"))
		);
	}
	async setup(input: Record<string, unknown>, ip: string): Promise<AuthUser> {
		await this.throttle([`setup:${ip}`], [10]);
		if (await this.isInitialized()) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
		if (!(await this.validSetupToken(input.setupToken)))
			throw new AuthError("安装码无效或已过期。", 400, "INVALID_SETUP_TOKEN");
		const name = username(input.username);
		const hashed = await passwordHash(input.password);
		return await this.transaction(async () => {
			if (await this.isInitialized()) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
			if (!(await this.validSetupToken(input.setupToken)))
				throw new AuthError("安装码无效或已过期。", 400, "INVALID_SETUP_TOKEN");
			const id = randomUUID();
			await this.sql.execute(
				"INSERT INTO users(id,username,password_hash,role,created_at) VALUES($1,$2,$3,'admin',$4)",
				[id, name, hashed, this.now()],
			);
			await this.sql.execute("INSERT INTO metadata(key,value) VALUES('initialized',$1)", [id]);
			await this.sql.execute("DELETE FROM metadata WHERE key='setup'", []);
			await this.audit(id, "setup", id);
			return await this.getUser(id);
		});
	}
	private async row(id: string): Promise<UserRow> {
		const row = (await this.sql.one("SELECT * FROM users WHERE id=$1", [id])) as unknown as UserRow | undefined;
		if (!row) throw new AuthError("账号不存在。", 404, "NOT_FOUND");
		return row;
	}
	async getUser(id: string): Promise<AuthUser> {
		return {
			...publicUser(await this.row(id)),
			...((await this.getSetting(`profile:${id}`)) as UserPreferences | undefined),
		};
	}
	async updateProfile(id: string, input: Record<string, unknown>): Promise<AuthUser> {
		const user = await this.getUser(id);
		if (!user.enabled || user.mustChangePassword) throw new AuthError("请先完成登录。", 403);
		const profile: UserPreferences = { locale: user.locale, avatar: user.avatar };
		if (input.locale !== undefined) {
			if (input.locale !== "zh-CN" && input.locale !== "en") throw new AuthError("语言偏好无效。", 422);
			profile.locale = input.locale;
		}
		if (input.avatar !== undefined) {
			if (input.avatar === null) profile.avatar = undefined;
			else {
				const match =
					typeof input.avatar === "string"
						? /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u.exec(input.avatar)
						: null;
				if (!match) throw new AuthError("头像须为 PNG、JPEG 或 WebP 图片。", 422);
				const bytes = Buffer.from(match[2], "base64");
				if (bytes.length > 128 * 1024) throw new AuthError("头像不能超过 128 KiB。", 413);
				const valid =
					match[1] === "png"
						? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
						: match[1] === "jpeg"
							? bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
							: bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
				if (!valid || bytes.toString("base64") !== match[2]) throw new AuthError("头像图片格式无效。", 422);
				profile.avatar = input.avatar as string;
			}
		}
		await this.setSetting(`profile:${id}`, profile);
		return await this.getUser(id);
	}
	async listUsers(): Promise<AuthUser[]> {
		return ((await this.sql.all("SELECT * FROM users ORDER BY created_at,username", [])) as unknown as UserRow[]).map(
			publicUser,
		);
	}
	private async throttle(keys: string[], limits: number[]): Promise<void> {
		await this.transaction(async () => {
			await this.sql.execute("DELETE FROM login_limits WHERE expires_at<=$1", [this.now()]);
			for (const [index, key] of keys.entries()) {
				const row = (await this.sql.one("SELECT count FROM login_limits WHERE key=$1", [key])) as
					| { count: number }
					| undefined;
				if (row && row.count >= limits[index])
					throw new AuthError("登录请求过多，请 15 分钟后重试。", 429, "RATE_LIMITED");
			}
			for (const key of keys)
				await this.sql.execute(
					"INSERT INTO login_limits(key,count,expires_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=login_limits.count+1",
					[key, this.now() + 15 * 60_000],
				);
		});
	}
	async login(input: Record<string, unknown>, ip: string): Promise<AuthUser> {
		return publicUser(await this.authenticate(input, ip));
	}
	async loginSession(input: Record<string, unknown>, ip: string): ReturnType<IdentityStore["createSession"]> {
		const row = await this.authenticate(input, ip);
		return this.createSession(row.id, row.password_hash);
	}
	private async authenticate(input: Record<string, unknown>, ip: string): Promise<UserRow> {
		const name = typeof input.username === "string" ? input.username.toLowerCase().slice(0, 128) : "";
		const accountKey = `account:${hashToken(name)}`;
		await this.throttle([accountKey, `ip:${ip}`], [5, 30]);
		const row = (await this.sql.one("SELECT * FROM users WHERE username=$1", [name])) as unknown as
			| UserRow
			| undefined;
		const valid = await verifyPassword(input.password, row?.password_hash);
		// Re-read after expensive hashing: disabling/resetting an account must win the race.
		const current = row ? await this.row(row.id) : undefined;
		if (!valid || !current?.enabled || current.password_hash !== row?.password_hash)
			throw new AuthError("用户名或密码错误。", 401, "INVALID_CREDENTIALS");
		await this.sql.execute("DELETE FROM login_limits WHERE key=$1", [accountKey]);
		await this.audit(current.id, "login", current.id);
		return current;
	}
	async createSession(id: string, verifiedPasswordHash?: string): Promise<{ token: string; access: SessionAccess }> {
		return this.transaction(async () => {
			if (verifiedPasswordHash && (await this.row(id)).password_hash !== verifiedPasswordHash)
				throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
			const user = await this.getUser(id);
			if (!user.enabled) throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
			const token = secret();
			const tokenHash = hashToken(token);
			const csrfToken = secret();
			const now = this.now();
			const expiresAt = now + 7 * day;
			await this.sql.execute("DELETE FROM sessions WHERE expires_at<=$1 OR last_seen<=$2", [now, now - day]);
			await this.sql.execute(
				"INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
				[tokenHash, id, csrfToken, now, now, expiresAt],
			);
			return { token, access: { user, tokenHash, csrfToken, expiresAt } };
		});
	}

	async session(token: string | undefined, touch = true, hashed = false): Promise<SessionAccess | undefined> {
		if (!token) return undefined;
		const tokenHash = hashed ? token : hashToken(token);
		const row = (await this.sql.one("SELECT * FROM sessions WHERE token_hash=$1", [tokenHash])) as
			| { user_id: string; csrf_token: string; expires_at: number; last_seen: number }
			| undefined;
		if (!row) return undefined;
		const user = await this.getUser(row.user_id);
		if (!user.enabled || row.expires_at <= this.now() || row.last_seen + day <= this.now()) {
			await this.sql.execute("DELETE FROM sessions WHERE token_hash=$1", [tokenHash]);
			return undefined;
		}
		if (touch)
			await this.sql.execute("UPDATE sessions SET last_seen=$1 WHERE token_hash=$2", [this.now(), tokenHash]);
		return { user, tokenHash, csrfToken: row.csrf_token, expiresAt: row.expires_at };
	}
	async snapshot(access?: SessionAccess): Promise<AuthSession> {
		return {
			user: access?.user ?? null,
			setupRequired: !(await this.isInitialized()),
			csrfToken: access?.csrfToken,
			expiresAt: access ? new Date(access.expiresAt).toISOString() : undefined,
		};
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private changed(): void {
		for (const listener of this.listeners) listener();
	}
	async logout(access: SessionAccess): Promise<void> {
		await this.sql.execute("DELETE FROM sessions WHERE token_hash=$1", [access.tokenHash]);
		this.changed();
	}
	private async revoke(id: string): Promise<void> {
		await this.sql.execute("DELETE FROM sessions WHERE user_id=$1", [id]);
	}
	async changePassword(id: string, input: Record<string, unknown>): Promise<string> {
		const row = await this.row(id);
		if (!(await verifyPassword(input.currentPassword, row.password_hash))) throw new AuthError("当前密码错误。", 400);
		const hashed = await passwordHash(input.password);
		await this.transaction(async () => {
			const current = await this.row(id);
			if (!current.enabled || current.password_hash !== row.password_hash)
				throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
			await this.sql.execute("UPDATE users SET password_hash=$1,must_change_password=0 WHERE id=$2", [hashed, id]);
			await this.revoke(id);
			await this.audit(id, "password-change", id);
		});
		this.changed();
		return hashed;
	}
	async createUser(
		actor: string,
		input: Record<string, unknown>,
	): Promise<{ user: AuthUser; temporaryPassword: string }> {
		const name = username(input.username);
		const role = input.role ?? "user";
		if (role !== "admin" && role !== "user") throw new AuthError("角色无效。", 422);
		const temporaryPassword = secret();
		const hashed = await passwordHash(temporaryPassword);
		return await this.transaction(async () => {
			await this.requireAdmin(actor);
			if (await this.sql.one("SELECT 1 FROM users WHERE username=$1", [name]))
				throw new AuthError("用户名已存在。", 409);
			const id = randomUUID();
			await this.sql.execute(
				"INSERT INTO users(id,username,password_hash,role,must_change_password,created_at) VALUES($1,$2,$3,$4,1,$5)",
				[id, name, hashed, role, this.now()],
			);
			await this.audit(actor, "user-create", id);
			return { user: await this.getUser(id), temporaryPassword };
		});
	}
	async requireAdmin(id: string): Promise<void> {
		const user = await this.getUser(id);
		if (!user.enabled || user.role !== "admin" || user.mustChangePassword)
			throw new AuthError("需要管理员权限。", 403, "FORBIDDEN");
	}
	async updateUser(actor: string, id: string, input: Record<string, unknown>): Promise<AuthUser> {
		const result = await this.transaction(async () => {
			await this.requireAdmin(actor);
			const previous = await this.getUser(id);
			const role = input.role ?? previous.role;
			const enabled = input.enabled ?? previous.enabled;
			if ((role !== "admin" && role !== "user") || typeof enabled !== "boolean")
				throw new AuthError("账号设置无效。", 422);
			if (previous.role === "admin" && previous.enabled && (role !== "admin" || !enabled)) {
				const count = (await this.sql.one(
					"SELECT count(*)::integer AS count FROM users WHERE role='admin' AND enabled=1",
					[],
				)) as { count: number };
				if (count.count <= 1) throw new AuthError("必须保留至少一名启用的管理员。", 409);
			}
			await this.sql.execute("UPDATE users SET role=$1,enabled=$2 WHERE id=$3", [role, Number(enabled), id]);
			if (role !== previous.role || !enabled) await this.revoke(id);
			await this.audit(actor, enabled ? "user-update" : "user-disable", id);
			return await this.getUser(id);
		});
		this.changed();
		return result;
	}
	async resetPassword(actor: string | undefined, id: string): Promise<{ temporaryPassword: string }> {
		if (actor) await this.requireAdmin(actor);
		await this.row(id);
		const temporaryPassword = secret();
		const hashed = await passwordHash(temporaryPassword);
		await this.transaction(async () => {
			if (actor) await this.requireAdmin(actor);
			await this.sql.execute("UPDATE users SET password_hash=$1,must_change_password=1 WHERE id=$2", [hashed, id]);
			await this.revoke(id);
			await this.audit(actor, "password-reset", id);
		});
		this.changed();
		return { temporaryPassword };
	}
}
