import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import { migrateDatabase } from "../packages/hydro-server/dist/database-schema.js";
import { fileManifest, validateWorkspaceDirectory } from "./workspace-integrity.mjs";

// Both Compose and native maintenance use the explicitly selected database and data root.
const root = resolve(process.env.SETDRAFT_WORKSPACE_ROOT);
const [command, directory, ...extra] = process.argv.slice(2);
const preflight = extra.length === 1 && extra[0] === "--preflight";
if (!directory || (extra.length && !preflight) || !["backup", "restore"].includes(command)) throw new Error("backup|restore <目录> [--preflight]");
const target = resolve(directory);
if (target === root || target.startsWith(`${root}${sep}`) || root.startsWith(`${target}${sep}`)) throw new Error("备份目录不能与数据目录重叠。");
const url = new URL(process.env.SETDRAFT_DATABASE_ADMIN_URL);
const pgEnv = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || "5432", PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), ...(url.searchParams.has("sslmode") ? { PGSSLMODE: url.searchParams.get("sslmode") } : {}) };
const excluded = new Set(["runtime", ".tmp", ".blob-staging", ".service.lock", "server.pid"]);

function run(program, args) {
	return new Promise((resolveRun, reject) => {
		const child = spawn(program, args, { env: pgEnv, stdio: ["ignore", "ignore", "pipe"] });
		let failure = "";
		child.stderr.on("data", (chunk) => { if (failure.length < 4000) failure += chunk.toString().slice(0, 4000 - failure.length); });
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolveRun() : reject(new Error(`${program} 失败（${code}）：${pgEnv.PGPASSWORD ? failure.replaceAll(pgEnv.PGPASSWORD, "***") : failure}`)));
	});
}
async function copyData(source, destination) {
	await cp(source, destination, { recursive: true, filter: (path) => !excluded.has(relative(source, path).split(sep)[0]) });
}
async function clearData() {
	await mkdir(root, { recursive: true });
	for (const entry of await readdir(root)) if (entry !== ".service.lock") await rm(join(root, entry), { recursive: true, force: true });
}
await run("pg_dump", ["--version"]);
await run("pg_restore", ["--version"]);
if (command === "restore") {
	await validateWorkspaceDirectory(target);
	await run("pg_restore", ["--list", join(target, "database.dump")]);
} else if (await stat(target).catch(() => undefined)) throw new Error("备份目录已存在，请使用新目录。");
if (preflight) {
	const probe = new Pool({ connectionString: url.toString(), max: 1, connectionTimeoutMillis: 5000 });
	try { await probe.query("SELECT 1 FROM identity.schema_version; SELECT 1 FROM workspace.documents LIMIT 1"); }
	finally { await probe.end(); }
	console.log("维护预检通过：PostgreSQL 工具和备份可用。");
} else {
	const pool = new Pool({ connectionString: url.toString(), max: 1 });
	const client = await pool.connect();
	async function referenceIssues(files) {
		const { rows } = await client.query("SELECT DISTINCT account_id,hash FROM workspace.files");
		return rows.flatMap((row) => {
			const path = `files/users/${row.account_id}/blobs/${row.hash.slice(0, 2)}/${row.hash}`;
			return files[path] === row.hash ? [] : [{ code: files[path] ? "BLOB_CORRUPT" : "BLOB_MISSING", path }];
		});
	}
	async function backup(destination, preserveDamage = false) {
		if (await stat(destination).catch(() => undefined)) throw new Error("备份目录已存在，请使用新目录。");
		await mkdir(destination, { recursive: true, mode: 0o700 });
		try {
			await copyData(root, join(destination, "files"));
			await run("pg_dump", ["--format=custom", "--schema=identity", "--schema=workspace", `--file=${join(destination, "database.dump")}`]);
			const files = await fileManifest(destination);
			const issues = await referenceIssues(files);
			if (issues.length && !preserveDamage) throw new Error("数据库引用的文件缺失或内容校验失败。");
			await writeFile(join(destination, "manifest.json"), JSON.stringify({ format: issues.length ? "setdraft-damaged-snapshot-1" : "setdraft-postgres-1", createdAt: new Date().toISOString(), files, ...(issues.length ? { issues } : {}) }, null, 2), { mode: 0o600 });
			if (!issues.length) await validateWorkspaceDirectory(destination);
			return !issues.length;
		} catch (error) { await rm(destination, { recursive: true, force: true }); throw error; }
	}
	async function restore(source) {
		await run("pg_restore", ["--clean", "--if-exists", "--single-transaction", "--no-owner", "--no-privileges", `--dbname=${pgEnv.PGDATABASE}`, join(source, "database.dump")]);
		await migrateDatabase(url.toString(), process.env.SETDRAFT_DATABASE_URL ? decodeURIComponent(new URL(process.env.SETDRAFT_DATABASE_URL).username) : "setdraft_app");
		if ((await referenceIssues(await fileManifest(source))).length) throw new Error("备份数据库引用的文件缺失或损坏。");
		await clearData();
		await copyData(join(source, "files"), root);
		await client.query("DELETE FROM identity.sessions; DELETE FROM identity.metadata WHERE key='setup'");
	}
	try {
		const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended('setdraft-server',0)) AS locked");
		if (!result.rows[0].locked) throw new Error("服务仍在运行，请先停止所有连接此数据库的 Setdraft 实例。");
		if (command === "backup") { await backup(target); console.log(`PostgreSQL 与全部用户文件已备份并校验：${target}`); }
		else {
			const previous = `${target}.before-restore-${Date.now()}`;
			const healthy = await backup(previous, true);
			try { await restore(target); }
			catch (error) {
				if (healthy) await restore(previous);
				else console.error(`恢复失败；损坏现场已保留，请使用健康备份重试：${previous}`);
				throw error;
			}
			console.log(`恢复完成，旧会话已撤销。恢复前${healthy ? "备份" : "损坏现场归档"}：${previous}`);
		}
	} finally { client.release(); await pool.end(); }
}
