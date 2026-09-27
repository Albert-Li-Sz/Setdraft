import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthSession, AuthUser, UserPreferences, UserRole } from "@setdraft/contracts";

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
	readonly db: DatabaseSync;
	private readonly now: () => number;
	private readonly listeners = new Set<() => void>();
	constructor(root: string, now: () => number = Date.now) {
		mkdirSync(root, { recursive: true });
		this.now = now;
		const path = join(root, "identity.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000");
		const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (version.user_version > 1) throw new Error("账号数据库来自更新版本，请升级应用。");
		this.db.exec(`
			BEGIN IMMEDIATE;
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS users (
				id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
				role TEXT NOT NULL CHECK(role IN ('admin','user')), enabled INTEGER NOT NULL DEFAULT 1,
				must_change_password INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS sessions (
				token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL,
				created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, expires_at INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
			CREATE TABLE IF NOT EXISTS login_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS audit (
				id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, subject_id TEXT,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			PRAGMA user_version=1;
			COMMIT;
		`);
	}
	close(): void {
		this.db.close();
	}
	private transaction<T>(work: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const value = work();
			this.db.exec("COMMIT");
			return value;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	private metadata(key: string): string | undefined {
		return (this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)
			?.value;
	}
	get initialized(): boolean {
		return Boolean(this.metadata("legacy-owner"));
	}
	get legacyOwnerId(): string | undefined {
		return this.metadata("legacy-owner");
	}
	getSetting(key: string): unknown {
		const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
		return row ? (JSON.parse(row.value) as unknown) : undefined;
	}
	setSetting(key: string, value: unknown): void {
		this.db
			.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
			.run(key, JSON.stringify(value));
	}
	private audit(actor: string | undefined, action: string, subject?: string): void {
		this.db
			.prepare("INSERT INTO audit(actor_id,action,subject_id,created_at) VALUES(?,?,?,?)")
			.run(actor ?? null, action, subject ?? null, this.now());
	}
	rotateSetupToken(): string {
		return this.transaction(() => {
			if (this.initialized) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
			const token = secret();
			this.db
				.prepare(
					"INSERT INTO metadata(key,value) VALUES('setup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
				)
				.run(JSON.stringify({ hash: hashToken(token), expiresAt: this.now() + day }));
			return token;
		});
	}
	private validSetupToken(token: unknown): boolean {
		const value = this.metadata("setup");
		if (typeof token !== "string" || !value) return false;
		const stored = JSON.parse(value) as { hash: string; expiresAt: number };
		return (
			stored.expiresAt > this.now() &&
			timingSafeEqual(Buffer.from(stored.hash, "hex"), Buffer.from(hashToken(token), "hex"))
		);
	}
	async setup(input: Record<string, unknown>, ip: string): Promise<AuthUser> {
		this.throttle([`setup:${ip}`], [10]);
		if (this.initialized) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
		if (!this.validSetupToken(input.setupToken))
			throw new AuthError("安装码无效或已过期。", 400, "INVALID_SETUP_TOKEN");
		const name = username(input.username);
		const hashed = await passwordHash(input.password);
		return this.transaction(() => {
			if (this.initialized) throw new AuthError("管理员已经初始化。", 409, "ALREADY_INITIALIZED");
			if (!this.validSetupToken(input.setupToken))
				throw new AuthError("安装码无效或已过期。", 400, "INVALID_SETUP_TOKEN");
			const id = randomUUID();
			this.db
				.prepare("INSERT INTO users(id,username,password_hash,role,created_at) VALUES(?,?,?,'admin',?)")
				.run(id, name, hashed, this.now());
			this.db.prepare("INSERT INTO metadata(key,value) VALUES('legacy-owner',?)").run(id);
			this.db.prepare("DELETE FROM metadata WHERE key='setup'").run();
			this.audit(id, "setup", id);
			return this.getUser(id);
		});
	}
	private row(id: string): UserRow {
		const row = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as unknown as UserRow | undefined;
		if (!row) throw new AuthError("账号不存在。", 404, "NOT_FOUND");
		return row;
	}
	getUser(id: string): AuthUser {
		return { ...publicUser(this.row(id)), ...(this.getSetting(`profile:${id}`) as UserPreferences | undefined) };
	}
	updateProfile(id: string, input: Record<string, unknown>): AuthUser {
		const user = this.getUser(id);
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
		this.setSetting(`profile:${id}`, profile);
		return this.getUser(id);
	}
	listUsers(): AuthUser[] {
		return (this.db.prepare("SELECT * FROM users ORDER BY created_at,username").all() as unknown as UserRow[]).map(
			publicUser,
		);
	}
	private throttle(keys: string[], limits: number[]): void {
		this.transaction(() => {
			this.db.prepare("DELETE FROM login_limits WHERE expires_at<=?").run(this.now());
			for (const [index, key] of keys.entries()) {
				const row = this.db.prepare("SELECT count FROM login_limits WHERE key=?").get(key) as
					| { count: number }
					| undefined;
				if (row && row.count >= limits[index])
					throw new AuthError("登录请求过多，请 15 分钟后重试。", 429, "RATE_LIMITED");
			}
			for (const key of keys)
				this.db
					.prepare(
						"INSERT INTO login_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
					)
					.run(key, this.now() + 15 * 60_000);
		});
	}
	async login(input: Record<string, unknown>, ip: string): Promise<AuthUser> {
		const name = typeof input.username === "string" ? input.username.toLowerCase().slice(0, 128) : "";
		const accountKey = `account:${hashToken(name)}`;
		this.throttle([accountKey, `ip:${ip}`], [5, 30]);
		const row = this.db.prepare("SELECT * FROM users WHERE username=?").get(name) as unknown as UserRow | undefined;
		const valid = await verifyPassword(input.password, row?.password_hash);
		// Re-read after expensive hashing: disabling/resetting an account must win the race.
		const current = row ? this.row(row.id) : undefined;
		if (!valid || !current?.enabled || current.password_hash !== row?.password_hash)
			throw new AuthError("用户名或密码错误。", 401, "INVALID_CREDENTIALS");
		this.db.prepare("DELETE FROM login_limits WHERE key=?").run(accountKey);
		this.audit(current.id, "login", current.id);
		return publicUser(current);
	}
	createSession(id: string): { token: string; access: SessionAccess } {
		const user = this.getUser(id);
		if (!user.enabled) throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
		const token = secret();
		const tokenHash = hashToken(token);
		const csrfToken = secret();
		const now = this.now();
		const expiresAt = now + 7 * day;
		this.db.prepare("DELETE FROM sessions WHERE expires_at<=? OR last_seen<=?").run(now, now - day);
		this.db
			.prepare(
				"INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?)",
			)
			.run(tokenHash, id, csrfToken, now, now, expiresAt);
		return { token, access: { user, tokenHash, csrfToken, expiresAt } };
	}
	session(token: string | undefined, touch = true, hashed = false): SessionAccess | undefined {
		if (!token) return undefined;
		const tokenHash = hashed ? token : hashToken(token);
		const row = this.db.prepare("SELECT * FROM sessions WHERE token_hash=?").get(tokenHash) as
			| { user_id: string; csrf_token: string; expires_at: number; last_seen: number }
			| undefined;
		if (!row) return undefined;
		const user = this.getUser(row.user_id);
		if (!user.enabled || row.expires_at <= this.now() || row.last_seen + day <= this.now()) {
			this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
			return undefined;
		}
		if (touch) this.db.prepare("UPDATE sessions SET last_seen=? WHERE token_hash=?").run(this.now(), tokenHash);
		return { user, tokenHash, csrfToken: row.csrf_token, expiresAt: row.expires_at };
	}
	snapshot(access?: SessionAccess): AuthSession {
		return {
			user: access?.user ?? null,
			setupRequired: !this.initialized,
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
	logout(access: SessionAccess): void {
		this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(access.tokenHash);
		this.changed();
	}
	private revoke(id: string): void {
		this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
	}
	async changePassword(id: string, input: Record<string, unknown>): Promise<void> {
		const row = this.row(id);
		if (!(await verifyPassword(input.currentPassword, row.password_hash))) throw new AuthError("当前密码错误。", 400);
		const hashed = await passwordHash(input.password);
		this.transaction(() => {
			const current = this.row(id);
			if (!current.enabled || current.password_hash !== row.password_hash)
				throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
			this.db.prepare("UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?").run(hashed, id);
			this.revoke(id);
			this.audit(id, "password-change", id);
		});
		this.changed();
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
		return this.transaction(() => {
			this.requireAdmin(actor);
			if (this.db.prepare("SELECT 1 FROM users WHERE username=?").get(name))
				throw new AuthError("用户名已存在。", 409);
			const id = randomUUID();
			this.db
				.prepare(
					"INSERT INTO users(id,username,password_hash,role,must_change_password,created_at) VALUES(?,?,?,?,1,?)",
				)
				.run(id, name, hashed, role, this.now());
			this.audit(actor, "user-create", id);
			return { user: this.getUser(id), temporaryPassword };
		});
	}
	requireAdmin(id: string): void {
		const user = this.getUser(id);
		if (!user.enabled || user.role !== "admin" || user.mustChangePassword)
			throw new AuthError("需要管理员权限。", 403, "FORBIDDEN");
	}
	updateUser(actor: string, id: string, input: Record<string, unknown>): AuthUser {
		const result = this.transaction(() => {
			this.requireAdmin(actor);
			const previous = this.getUser(id);
			const role = input.role ?? previous.role;
			const enabled = input.enabled ?? previous.enabled;
			if ((role !== "admin" && role !== "user") || typeof enabled !== "boolean")
				throw new AuthError("账号设置无效。", 422);
			if (previous.role === "admin" && previous.enabled && (role !== "admin" || !enabled)) {
				const count = this.db
					.prepare("SELECT count(*) AS count FROM users WHERE role='admin' AND enabled=1")
					.get() as { count: number };
				if (count.count <= 1) throw new AuthError("必须保留至少一名启用的管理员。", 409);
			}
			this.db.prepare("UPDATE users SET role=?,enabled=? WHERE id=?").run(role, Number(enabled), id);
			if (role !== previous.role || !enabled) this.revoke(id);
			this.audit(actor, enabled ? "user-update" : "user-disable", id);
			return this.getUser(id);
		});
		this.changed();
		return result;
	}
	async resetPassword(actor: string | undefined, id: string): Promise<{ temporaryPassword: string }> {
		if (actor) this.requireAdmin(actor);
		this.row(id);
		const temporaryPassword = secret();
		const hashed = await passwordHash(temporaryPassword);
		this.transaction(() => {
			if (actor) this.requireAdmin(actor);
			this.db.prepare("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?").run(hashed, id);
			this.revoke(id);
			this.audit(actor, "password-reset", id);
		});
		this.changed();
		return { temporaryPassword };
	}
}
