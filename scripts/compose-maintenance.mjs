import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateWorkspaceDirectory } from "./workspace-integrity.mjs";

const root = resolve(process.env.SETDRAFT_WORKSPACE_ROOT);
const [command, directory, ...extra] = process.argv.slice(2);
if (!directory || extra.length || !["backup", "restore"].includes(command)) throw new Error("backup|restore <目录>");
const target = resolve(directory);
if (target === root || target.startsWith(`${root}/`) || root.startsWith(`${target}/`)) throw new Error("备份目录不能与数据目录重叠。");
const excluded = new Set(["runtime", ".tmp", ".service.lock", "server.pid"]);
async function copyData(source, destination) {
	await cp(source, destination, { recursive: true, filter: (path) => !excluded.has(relative(source, path).split(sep)[0]) });
}
async function clearData() {
	for (const entry of await readdir(root)) if (entry !== ".service.lock") await rm(join(root, entry), { recursive: true, force: true });
}
if (command === "backup") {
	if (await stat(target).catch(() => undefined)) throw new Error("备份目录已存在，请使用新目录。");
	try { await copyData(root, target); await validateWorkspaceDirectory(target); }
	catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
	console.log(`备份已完成并校验全部数据库与文件哈希：${target}`);
} else {
	await validateWorkspaceDirectory(target);
	const previous = `${target}.before-restore-${Date.now()}`;
	await copyData(root, previous);
	try {
		await clearData();
		await copyData(target, root);
		await validateWorkspaceDirectory(root);
		const identityPath = join(root, "identity.sqlite");
		if (await stat(identityPath).catch(() => undefined)) {
			const database = new DatabaseSync(identityPath);
			try { database.exec("DELETE FROM sessions; DELETE FROM metadata WHERE key='setup';"); } finally { database.close(); }
		}
		await mkdir(join(root, ".tmp"), { recursive: true });
	} catch (error) { await clearData(); await copyData(previous, root); throw error; }
	console.log(`恢复完成，旧会话已撤销。恢复前数据保存在 ${previous}。`);
}
