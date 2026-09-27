import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityStore } from "../src/identity.ts";

let root: string;
let now: number;
let identity: IdentityStore;
const password = "correct horse battery staple";
const setup = async () =>
	await identity.setup(
		{ username: "administrator", password, setupToken: await identity.rotateSetupToken() },
		"local",
	);
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-identity-"));
	now = Date.now();
	identity = new IdentityStore(root, () => now);
});
afterEach(async () => {
	identity.close();
	await rm(root, { recursive: true, force: true });
});

describe("identity lifecycle", () => {
	it("expires installation codes, rotates them, and allows only one concurrent initialization", async () => {
		const expired = await identity.rotateSetupToken();
		now += 86_400_001;
		await expect(
			identity.setup({ username: "administrator", password, setupToken: expired }, "local"),
		).rejects.toThrow("安装码");
		const token = await identity.rotateSetupToken();
		const attempts = await Promise.allSettled(
			[1, 2].map(
				async () => await identity.setup({ username: "administrator", password, setupToken: token }, "local"),
			),
		);
		expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect(await identity.listUsers()).toHaveLength(1);
		await expect(identity.rotateSetupToken()).rejects.toThrow("已经初始化");
		expect(await identity.sql.one("SELECT value FROM metadata WHERE key='setup'", [])).toBeUndefined();
	});
	it("stores only password/session digests and enforces idle and absolute session expiry", async () => {
		const user = await setup();
		const session = await identity.createSession(user.id);
		const row = (await identity.sql.one("SELECT password_hash FROM users", [])) as { password_hash: string };
		expect(row.password_hash).toMatch(/^scrypt\$/u);
		expect(row.password_hash).not.toContain(password);
		expect(JSON.stringify(await identity.sql.all("SELECT * FROM sessions", []))).not.toContain(session.token);
		now += 23 * 3_600_000;
		expect((await identity.session(session.token))?.user.id).toBe(user.id);
		now += 24 * 3_600_000;
		expect(await identity.session(session.token)).toBeUndefined();
		const fresh = await identity.createSession(user.id);
		for (let i = 0; i < 7; i++) {
			now += 23 * 3_600_000;
			expect(await identity.session(fresh.token)).toBeDefined();
		}
		now += 7 * 3_600_000;
		expect(await identity.session(fresh.token)).toBeUndefined();
	});
	it("requires a new password, revokes sessions on reset/change/disable, and protects the last admin", async () => {
		const admin = await setup();
		const member = await identity.createUser(admin.id, { username: "Member" });
		expect(member.user).toMatchObject({ username: "member", mustChangePassword: true });
		const login = await identity.login({ username: "MEMBER", password: member.temporaryPassword }, "local");
		const session = await identity.createSession(login.id);
		await identity.changePassword(login.id, { currentPassword: member.temporaryPassword, password });
		expect(await identity.session(session.token)).toBeUndefined();
		expect((await identity.getUser(login.id)).mustChangePassword).toBe(false);
		const changed = await identity.createSession(login.id);
		await identity.resetPassword(admin.id, login.id);
		expect(await identity.session(changed.token)).toBeUndefined();
		const reset = await identity.createSession(login.id);
		await identity.updateUser(admin.id, login.id, { enabled: false });
		expect(await identity.session(reset.token)).toBeUndefined();
		await expect(identity.updateUser(admin.id, admin.id, { enabled: false })).rejects.toThrow("至少一名");
		await expect(identity.updateUser(admin.id, admin.id, { role: "user" })).rejects.toThrow("至少一名");
	});
	it("throttles account and IP attempts without revealing whether an account exists", async () => {
		await setup();
		for (let i = 0; i < 5; i++)
			await expect(identity.login({ username: "missing", password }, "remote")).rejects.toMatchObject({
				code: "INVALID_CREDENTIALS",
			});
		await expect(identity.login({ username: "missing", password }, "different-ip")).rejects.toMatchObject({
			statusCode: 429,
		});
		now += 900_001;
		await expect(identity.login({ username: "missing", password }, "remote")).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
		await expect(identity.login({ username: "administrator", password: "wrong" }, "remote")).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
	});
	it("rejects session issuance if a password is reset after verification", async () => {
		const admin = await setup();
		const verifiedHash = await identity.changePassword(admin.id, { currentPassword: password, password });
		await identity.resetPassword(admin.id, admin.id);
		await expect(identity.createSession(admin.id, verifiedHash)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
		expect(await identity.sql.all("SELECT * FROM sessions")).toEqual([]);
	});
	it("applies the source-IP limit even when every attempt uses a different account", async () => {
		for (let index = 0; index < 30; index++)
			await expect(identity.login({ username: `unknown${index}` }, "same-ip")).rejects.toMatchObject({
				code: "INVALID_CREDENTIALS",
			});
		await expect(identity.login({ username: "another-account" }, "same-ip")).rejects.toMatchObject({
			statusCode: 429,
		});
		await expect(identity.login({ username: "another-account" }, "another-ip")).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
		});
	});
});
