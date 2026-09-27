import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export async function workspaceDirectories(directory) {
	const directories = [directory];
	const identityPath = join(directory, "identity.sqlite");
	if (!(await stat(identityPath).catch(() => undefined))) return directories;
	const identity = new DatabaseSync(identityPath, { readOnly: true });
	try {
		if (identity.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("账号数据库校验失败。");
		const legacyOwner = identity.prepare("SELECT value FROM metadata WHERE key='legacy-owner'").get()?.value;
		for (const user of identity.prepare("SELECT id FROM users").all()) {
			if (!/^[a-f0-9-]{36}$/u.test(user.id)) throw new Error("账号 ID 无效。");
			if (user.id === legacyOwner) continue;
			const path = join(directory, "users", user.id);
			if (await stat(join(path, "workspace.sqlite")).catch(() => undefined)) directories.push(path);
			else if (await stat(path).catch(() => undefined)) throw new Error(`个人工作区缺少 workspace.sqlite：${user.id}`);
		}
	} finally { identity.close(); }
	return directories;
}

export async function validateWorkspaceDirectory(directory) {
	for (const workspace of await workspaceDirectories(directory)) await validateOneWorkspace(workspace);
}

async function validateOneWorkspace(directory) {
	const path = join(directory, "workspace.sqlite");
	if (!(await stat(path).catch(() => undefined))) throw new Error("备份目录缺少 workspace.sqlite。");
	const database = new DatabaseSync(path, { readOnly: true });
	let hashes;
	try {
		const integrity = database.prepare("PRAGMA integrity_check").get();
		if (integrity.integrity_check !== "ok") throw new Error(`SQLite 校验失败：${integrity.integrity_check}`);
		hashes = database.prepare("SELECT DISTINCT hash FROM files").all().map((row) => row.hash);
	} finally { database.close(); }
	for (const hash of hashes) {
		if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error(`文件索引哈希无效：${hash}`);
		const blob = join(directory, "blobs", hash.slice(0, 2), hash);
		const actual = createHash("sha256");
		try { for await (const chunk of createReadStream(blob)) actual.update(chunk); }
		catch { throw new Error(`备份文件缺失：${hash}`); }
		if (actual.digest("hex") !== hash) throw new Error(`备份文件哈希不匹配：${hash}`);
	}
}
