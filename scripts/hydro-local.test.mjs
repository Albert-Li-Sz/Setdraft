import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(executable, args) {
	return spawnSync(executable, args, { cwd: root, encoding: "utf8" });
}

test("quick install and upgrade dry runs list the exact preparation steps", () => {
	const install = command("sh", [join(root, "install.sh"), "--dry-run"]);
	assert.equal(install.status, 0, install.stderr);
	assert.match(install.stdout, /npm ci --ignore-scripts/);
	assert.match(install.stdout, /npm 镜像 https:\/\/registry\.npmmirror\.com/);
	assert.match(install.stdout, /模型数据缺失时先补齐/);
	assert.match(install.stdout, /docker build -t hydro-problem-make\/sandbox:local/);
	const upgrade = command("sh", [join(root, "upgrade.sh"), "--dry-run"]);
	assert.equal(upgrade.status, 0, upgrade.stderr);
	assert.match(upgrade.stdout, /git fetch origin main/);
	assert.match(upgrade.stdout, /git merge --ff-only FETCH_HEAD/);
});

test("model catalog loads its JSON snapshot before the API starts", () => {
	const models = command(process.execPath, [
		"--import",
		"tsx",
		"--input-type=module",
		"-e",
		'import { MODELS } from "./packages/ai/src/models.generated.ts"; if (!MODELS["amazon-bedrock"]) throw new Error("Bedrock models missing");',
	]);
	assert.equal(models.status, 0, models.stderr);
});

test("uninstall dry run makes data and dependency deletion explicit", () => {
	const defaultRun = command("sh", [join(root, "uninstall.sh"), "--dry-run"]);
	assert.equal(defaultRun.status, 0, defaultRun.stderr);
	assert.doesNotMatch(defaultRun.stdout, /永久删除/);
	const purge = command("sh", [
		join(root, "uninstall.sh"),
		"--purge-data",
		"--remove-deps",
		"--dry-run",
	]);
	assert.equal(purge.status, 0, purge.stderr);
	assert.match(purge.stdout, /永久删除/);
	assert.match(purge.stdout, /node_modules/);
});

test("invalid and duplicate options do not run maintenance commands", () => {
	const duplicate = command(process.execPath, [join(root, "scripts/hydro-local.mjs"), "install", "--dry-run", "--dry-run"]);
	assert.equal(duplicate.status, 1);
	assert.match(duplicate.stderr, /参数无效或重复/);
	const invalidService = command(process.execPath, [join(root, "scripts/hydro-local.mjs"), "service", "toString"]);
	assert.equal(invalidService.status, 1);
	assert.match(invalidService.stderr, /无效服务名/);
});

test("uninstall preserves project data unless purge is requested", () => {
	const fixture = mkdtempSync(join(tmpdir(), "hydro-local-uninstall-"));
	try {
		mkdirSync(join(fixture, "scripts"));
		mkdirSync(join(fixture, "bin"));
		mkdirSync(join(fixture, ".hydro-problem-make", "runtime"), { recursive: true });
		copyFileSync(join(root, "scripts/hydro-local.mjs"), join(fixture, "scripts/hydro-local.mjs"));
		writeFileSync(join(fixture, ".hydro-problem-make", "project.txt"), "keep");
		writeFileSync(join(fixture, ".hydro-problem-make", "runtime", "api.log"), "temporary log");
		writeFileSync(join(fixture, "bin", "docker"), "#!/bin/sh\necho 'No such image' >&2\nexit 1\n", {
			mode: 0o755,
		});
		const env = { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}` };
		const uninstall = spawnSync(process.execPath, [join(fixture, "scripts/hydro-local.mjs"), "uninstall"], {
			cwd: fixture,
			encoding: "utf8",
			env,
		});
		assert.equal(uninstall.status, 0, uninstall.stderr);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "project.txt")), true);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "runtime")), false);
		const purge = spawnSync(
			process.execPath,
			[join(fixture, "scripts/hydro-local.mjs"), "uninstall", "--purge-data"],
			{ cwd: fixture, encoding: "utf8", env },
		);
		assert.equal(purge.status, 0, purge.stderr);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make")), false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("backup validates blobs and restore rejects a damaged copy without replacing live data", () => {
	const fixture = mkdtempSync(join(tmpdir(), "hydro-local-backup-"));
	try {
		mkdirSync(join(fixture, "scripts"));
		copyFileSync(join(root, "scripts/hydro-local.mjs"), join(fixture, "scripts/hydro-local.mjs"));
		const data = join(fixture, ".hydro-problem-make");
		mkdirSync(data);
		const database = new DatabaseSync(join(data, "workspace.sqlite"));
		database.exec("CREATE TABLE files (hash TEXT NOT NULL); CREATE TABLE metadata (value TEXT NOT NULL)");
		const original = Buffer.from("original data");
		const hash = createHash("sha256").update(original).digest("hex");
		mkdirSync(join(data, "blobs", hash.slice(0, 2)), { recursive: true });
		writeFileSync(join(data, "blobs", hash.slice(0, 2), hash), original);
		database.prepare("INSERT INTO files (hash) VALUES (?)").run(hash);
		database.prepare("INSERT INTO metadata (value) VALUES (?)").run("original");
		database.close();
		const saved = join(fixture, "saved-backup");
		const backup = command(process.execPath, [join(fixture, "scripts/hydro-local.mjs"), "backup", saved]);
		assert.equal(backup.status, 0, backup.stderr);
		const live = new DatabaseSync(join(data, "workspace.sqlite"));
		live.prepare("UPDATE metadata SET value='modified'").run();
		live.close();
		writeFileSync(join(saved, "blobs", hash.slice(0, 2), hash), "damaged");
		const rejected = command(process.execPath, [join(fixture, "scripts/hydro-local.mjs"), "restore", saved]);
		assert.equal(rejected.status, 1);
		assert.match(rejected.stderr, /哈希不匹配/);
		const unchanged = new DatabaseSync(join(data, "workspace.sqlite"), { readOnly: true });
		assert.equal(unchanged.prepare("SELECT value FROM metadata").get().value, "modified");
		unchanged.close();
		writeFileSync(join(saved, "blobs", hash.slice(0, 2), hash), original);
		const restored = command(process.execPath, [join(fixture, "scripts/hydro-local.mjs"), "restore", saved]);
		assert.equal(restored.status, 0, restored.stderr);
		const checked = new DatabaseSync(join(data, "workspace.sqlite"), { readOnly: true });
		assert.equal(checked.prepare("SELECT value FROM metadata").get().value, "original");
		checked.close();
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});

test("multi-user backups include identity and personal blobs, revoke restored sessions, and require offline data", () => {
 const fixture = mkdtempSync(join(tmpdir(), "setdraft-team-backup-"));
 try {
  mkdirSync(join(fixture, "scripts"));
  copyFileSync(join(root, "scripts/hydro-local.mjs"), join(fixture, "scripts/hydro-local.mjs"));
  const data = join(fixture, ".hydro-problem-make");
  const id = "10000000-0000-4000-8000-000000000000";
  const personal = join(data, "users", id);
  mkdirSync(personal, { recursive: true });
  const hash = createHash("sha256").update("private blob").digest("hex");
  for (const workspace of [data, personal]) {
   const db = new DatabaseSync(join(workspace, "workspace.sqlite"));
   db.exec("CREATE TABLE files (hash TEXT NOT NULL)");
   db.prepare("INSERT INTO files VALUES (?)").run(hash); db.close();
   mkdirSync(join(workspace, "blobs", hash.slice(0, 2)), { recursive: true });
   writeFileSync(join(workspace, "blobs", hash.slice(0, 2), hash), "private blob");
  }
  const identity = new DatabaseSync(join(data, "identity.sqlite"));
  identity.exec("CREATE TABLE metadata(key TEXT,value TEXT); CREATE TABLE users(id TEXT); CREATE TABLE sessions(token_hash TEXT); CREATE TABLE settings(key TEXT,value TEXT)");
  identity.prepare("INSERT INTO users VALUES (?)").run(id);
  identity.exec("INSERT INTO sessions VALUES ('old-session'); INSERT INTO settings VALUES ('ai-config','team config'); INSERT INTO metadata VALUES ('setup','old-install-code')");
  identity.close();
  const script = join(fixture, "scripts/hydro-local.mjs");
  const saved = join(fixture, "backup");
  writeFileSync(join(data, "server.pid"), String(process.pid));
  const rejected = command(process.execPath, [script, "backup", saved]);
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /仍有直接启动/);
  rmSync(join(data, "server.pid"));
  const backup = command(process.execPath, [script, "backup", saved]);
  assert.equal(backup.status, 0, backup.stderr);
  assert.equal(existsSync(join(saved, "users", id, "blobs", hash.slice(0, 2), hash)), true);
  const restored = command(process.execPath, [script, "restore", saved]);
  assert.equal(restored.status, 0, restored.stderr);
  const checked = new DatabaseSync(join(data, "identity.sqlite"));
  assert.equal(checked.prepare("SELECT count(*) AS count FROM sessions").get().count, 0);
  assert.equal(checked.prepare("SELECT value FROM settings WHERE key='ai-config'").get().value, "team config");
  assert.equal(checked.prepare("SELECT value FROM metadata WHERE key='setup'").get(), undefined);
  checked.close();
  writeFileSync(join(saved, "users", id, "blobs", hash.slice(0, 2), hash), "damaged");
  const damaged = command(process.execPath, [script, "restore", saved]);
  assert.equal(damaged.status, 1); assert.match(damaged.stderr, /哈希不匹配/);
 } finally { rmSync(fixture, { recursive: true, force: true }); }
});
