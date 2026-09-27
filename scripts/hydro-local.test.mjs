import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createServer } from "node:net";
import { deploymentEnvironment, loadDeployment, networkEnvironment, redact, saveDeployment } from "./deployment-config.mjs";
import { sandboxBuildArgs } from "../packages/hydro-server/sandbox/build-args.mjs";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function copyInstaller(fixture) {
	for (const file of ["scripts/hydro-local.mjs", "scripts/deployment-config.mjs", "packages/hydro-server/sandbox/build-args.mjs"]) {
		mkdirSync(dirname(join(fixture, file)), { recursive: true });
		copyFileSync(join(root, file), join(fixture, file));
	}
}

function command(executable, args) {
	return spawnSync(executable, args, { cwd: root, encoding: "utf8" });
}

function assertDependencyBuildOrder(commands) {
	const order = [...commands.matchAll(/\brun (?:build|build:offline) --workspace=([^\s&]+)/gu)].map((match) => match[1]);
	assert.ok(order.length > 0, "No workspace builds were executed");
	const packages = readdirSync(join(root, "packages"), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
		.map((entry) => JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")));
	for (const name of order) {
		const manifest = packages.find((item) => item.name === name);
		assert.ok(manifest, `Unknown workspace ${name}`);
		for (const dependency of Object.keys(manifest.dependencies ?? {})) {
			const target = packages.find((item) => item.name === dependency);
			if (!target?.scripts?.build) continue;
			assert.ok(order.includes(dependency) && order.indexOf(dependency) < order.indexOf(name),
				`${name} must build after its dependency ${dependency} on a fresh installation`);
		}
	}
}

test("the standard build produces workspace dependencies before their consumers", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assertDependencyBuildOrder(manifest.scripts["build:hydro"]);
});

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
		copyInstaller(fixture);
		writeFileSync(join(fixture, ".hydro-problem-make", "project.txt"), "keep");
		mkdirSync(join(fixture, ".hydro-problem-make", "deployment", "data"), { recursive: true });
		writeFileSync(join(fixture, ".hydro-problem-make", "deployment", "data", "certificate.key"), "keep certificate");
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
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "deployment", "data", "certificate.key")), true);
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
		copyInstaller(fixture);
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
  copyInstaller(fixture);
  const data = join(fixture, ".hydro-problem-make");
  writeFileSync(join(fixture, ".env"), 'HYDRO_NETWORK="global"\n');
  mkdirSync(join(data, "deployment", "data"), { recursive: true });
  writeFileSync(join(data, "deployment", "data", "certificate.key"), "private certificate");
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
  assert.equal(readFileSync(join(saved, "deployment.env"), "utf8"), 'HYDRO_NETWORK="global"\n');
  assert.equal(readFileSync(join(saved, "deployment", "data", "certificate.key"), "utf8"), "private certificate");
  writeFileSync(join(fixture, ".env"), 'HYDRO_NETWORK="cn"\n');
  const restored = command(process.execPath, [script, "restore", saved]);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(readFileSync(join(fixture, ".env"), "utf8"), 'HYDRO_NETWORK="cn"\n');
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

test("deployment precedence, persistence, profile switching and scoped proxies", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "setdraft-config-"));
	try {
		writeFileSync(join(fixture, ".env"), '# Keep this comment\nUNRELATED="keep"\nNODE_OPTIONS="--bad-option"\nHYDRO_NETWORK="global"\nHYDRO_NPM_REGISTRY=""\nHYDRO_WORKSPACE_ROOT="data with spaces"\n');
		const config = await loadDeployment(fixture, { HYDRO_NETWORK: "cn" }, {
			HYDRO_PUBLIC_ORIGIN: "http://setdraft.example.com", HYDRO_HOST: "127.0.0.1",
			HYDRO_DOWNLOAD_PROXY: "http://user:secret@127.0.0.1:8080",
		});
		assert.equal(config.values.HYDRO_PUBLIC_ORIGIN, "http://setdraft.example.com");
		assert.equal(config.registry, "https://registry.npmmirror.com");
		assert.equal(config.dataRoot, join(fixture, "data with spaces"));
		assert.equal(deploymentEnvironment(config, {}).NODE_OPTIONS, undefined);
		assert.equal(deploymentEnvironment(config, {}).HTTPS_PROXY, undefined);
		const network = networkEnvironment(config, { NO_PROXY: "my.internal" });
		assert.equal(network.HTTPS_PROXY, "http://user:secret@127.0.0.1:8080");
		assert.match(network.NO_PROXY, /127\.0\.0\.1,localhost,::1,my.internal/);
		await saveDeployment(config);
		const saved = readFileSync(join(fixture, ".env"), "utf8");
		assert.match(saved, /# Keep this comment\nUNRELATED="keep"/);
		if (process.platform !== "win32") assert.equal(statSync(join(fixture, ".env")).mode & 0o777, 0o600);
		const reloaded = await loadDeployment(fixture, {});
		assert.deepEqual(reloaded.values, config.values);
		const global = await loadDeployment(fixture, {}, { HYDRO_NETWORK: "global" });
		assert.equal(global.registry, "https://registry.npmjs.org");
		assert.equal(global.debianMirror, "https://deb.debian.org");
		assert.equal(global.values.HYDRO_PUBLIC_ORIGIN, "http://setdraft.example.com");
		assert.equal(global.values.HYDRO_HOST, "127.0.0.1");
		assert.equal(redact("https://user:secret@example.com/a"), "https://***@example.com/a");
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("deployment rejects invalid origins, injection, invalid limits and destructive workspace paths", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "setdraft-invalid-"));
	try {
		for (const overrides of [
			{ HYDRO_PUBLIC_ORIGIN: "https://example.com/path" }, { HYDRO_PUBLIC_ORIGIN: "http://example.com\nadmin off" },
			{ HYDRO_PUBLIC_ORIGIN: "https://example.com/" }, { HYDRO_PUBLIC_ORIGIN: "https://u:p@example.com" },
			{ HYDRO_PUBLIC_ORIGIN: "ftp://example.com" }, { HYDRO_HOST: "not-a-host" },
			{ HYDRO_NPM_REGISTRY: "http://mirror.example.com" }, { HYDRO_NETWORK: "oops" },
			{ HYDRO_DOCKER_REGISTRY: "https://mirror.example.com" }, { HYDRO_TESTCASES_MAX: "0" },
			{ HYDRO_WORKSPACE_ROOT: fixture }, { HYDRO_WORKSPACE_ROOT: dirname(fixture) },
			{ HYDRO_DOWNLOAD_PROXY: "http://proxy.example.com/path" },
		]) await assert.rejects(loadDeployment(fixture, {}, overrides));
		await assert.rejects(loadDeployment(fixture, { PORT: "9999" }), /PORT=4321/);
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("installation defaults to an all-interface web server without provisioning a proxy", () => {
	const fixture = mkdtempSync(join(tmpdir(), "setdraft-dry-run-"));
	try {
		copyInstaller(fixture);
		const script = join(fixture, "scripts/hydro-local.mjs");
		const result = command(process.execPath, [script, "install", "--download-proxy", "http://user:secret@127.0.0.1:8080", "--dry-run"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /生产监听 0\.0\.0\.0:4321/);
		assert.match(result.stdout, /不安装或托管反向代理/);
		assert.doesNotMatch(result.stdout + result.stderr, /secret|Caddy|SSL|80\/443/);
		const proxy = command(process.execPath, [script, "install", "--host", "127.0.0.1", "--public-origin", "https://setdraft.example.com", "--dry-run"]);
		assert.equal(proxy.status, 0, proxy.stderr);
		assert.match(proxy.stdout, /生产监听 127\.0\.0\.1:4321/);
		assert.match(proxy.stdout, /https:\/\/setdraft\.example\.com/);
		for (const args of [
			["--network", "cn", "--network", "global"], ["--host"], ["--host", "bad"],
			["--host", "0.0.0.0", "--host", "127.0.0.1"], ["--domain", "example.com"],
			["--https"], ["--ssl-cert", "cert.pem"], ["--caddy-archive", "archive.tar.gz"],
			["--public-origin", "https://example.com", "--mode", "dev"],
		]) {
			const invalid = command(process.execPath, [script, "install", ...args, "--dry-run"]);
			assert.equal(invalid.status, 1, invalid.stdout);
		}
		assert.deepEqual(readdirSync(fixture).sort(), ["packages", "scripts"]);
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("direct IP access and custom proxy origins persist without certificate or proxy settings", async () => {
	const fixture = mkdtempSync(join(tmpdir(), "setdraft-origin-config-"));
	try {
		writeFileSync(join(fixture, ".env"), 'HYDRO_PROXY_MODE="caddy"\nHYDRO_SSL_CERT="missing.pem"\nHYDRO_CADDY_BIN="missing-caddy"\nUNRELATED="keep"\n');
		for (const origin of ["", "http://192.168.1.20:4321", "http://[2001:db8::20]:4321", "https://setdraft.example.com"]) {
			const config = await loadDeployment(fixture, {}, { HYDRO_PUBLIC_ORIGIN: origin });
			assert.equal(config.values.HYDRO_HOST, "0.0.0.0");
			assert.equal(config.values.HYDRO_PUBLIC_ORIGIN, origin);
			assert.equal(config.values.HYDRO_PROXY_MODE, undefined);
			assert.equal(deploymentEnvironment(config, { HYDRO_CADDY_BIN: "old" }).HYDRO_CADDY_BIN, undefined);
			await saveDeployment(config);
			const restored = await loadDeployment(fixture, {});
			assert.deepEqual(restored.values, config.values);
		}
		const saved = readFileSync(join(fixture, ".env"), "utf8");
		assert.match(saved, /UNRELATED="keep"/);
		assert.doesNotMatch(saved, /HYDRO_PROXY_MODE|HYDRO_SSL_CERT|HYDRO_CADDY_BIN/);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "deployment")), false);
	} finally { rmSync(fixture, { recursive: true, force: true }); }
});

test("sandbox mirror settings preserve the pinned GCC digest and never add Docker daemon configuration", () => {
	const args = sandboxBuildArgs({ HYDRO_DOCKER_REGISTRY: "mirror.example.com", HYDRO_DEBIAN_MIRROR: "https://mirrors.tuna.tsinghua.edu.cn/" });
	assert.ok(args.includes("PYTHON_IMAGE=mirror.example.com/library/python:3.14-slim-trixie"));
	assert.ok(args.some((arg) => /^GCC_IMAGE=mirror\.example\.com\/library\/gcc:16\.2\.0-trixie@sha256:[a-f0-9]{64}$/.test(arg)));
	assert.ok(args.includes("DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn"));
	assert.deepEqual(sandboxBuildArgs({}), []);
	assert.throws(() => sandboxBuildArgs({ HYDRO_DOCKER_REGISTRY: "user:password@mirror.example.com" }));
});

async function freePort() {
	const server = createServer();
	await new Promise((accept) => server.listen(0, "127.0.0.1", accept));
	const port = server.address().port;
	await new Promise((accept) => server.close(accept));
	return port;
}

test("install, restart, upgrade and uninstall preserve .env and apply mirror settings to subprocesses", { skip: process.platform === "win32" }, async () => {
	const fixture = mkdtempSync(join(tmpdir(), "setdraft-lifecycle-"));
	copyInstaller(fixture);
	const script = join(fixture, "scripts/hydro-local.mjs");
	const port = await freePort();
	writeFileSync(script, readFileSync(script, "utf8").replaceAll("4321", String(port)));
	mkdirSync(join(fixture, "bin"));
	mkdirSync(join(fixture, "packages/hydro-web/dist"), { recursive: true });
	mkdirSync(join(fixture, "packages/hydro-server/dist"), { recursive: true });
	writeFileSync(join(fixture, "packages/hydro-web/dist/index.html"), "fixture");
	writeFileSync(join(fixture, "packages/hydro-server/dist/cli.js"), `require('node:http').createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({setupRequired:false,origin:process.env.HYDRO_PUBLIC_ORIGIN,mirror:process.env.HYDRO_DEBIAN_MIRROR,listenHost:process.env.HYDRO_HOST}));}).listen(${port},'127.0.0.1');`);
	writeFileSync(join(fixture, "bin/npm"), '#!/bin/sh\necho "npm $*" >> commands.log\ncase "$*" in *ping*registry.npmmirror.com*) exit 1;; esac\nexit 0\n', { mode: 0o755 });
	writeFileSync(join(fixture, "bin/docker"), '#!/bin/sh\necho "docker $*" >> commands.log\nexit 0\n', { mode: 0o755 });
	writeFileSync(join(fixture, "bin/git"), '#!/bin/sh\necho "git $*" >> commands.log\ncase "$1" in branch) echo main;; remote) echo https://example.com/project.git;; esac\nexit 0\n', { mode: 0o755 });
	const env = { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}` };
	for (const key of Object.keys(env)) if (key.startsWith("HYDRO_") || key === "PORT") delete env[key];
	const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: fixture, encoding: "utf8", env, timeout: 65_000 });
	try {
		const installed = invoke("install", "--network", "cn", "--docker-registry", "mirror.example.com");
		assert.equal(installed.status, 0, installed.stderr);
		assert.match(installed.stderr, /回退到 npm 官方源/);
		const logged = readFileSync(join(fixture, "commands.log"), "utf8");
		assertDependencyBuildOrder(logged);
		assert.match(logged, /registry.npmjs.org.*ci --ignore-scripts/);
		assert.match(logged, /DEBIAN_MIRROR=https:\/\/mirrors.tuna.tsinghua.edu.cn/);
		assert.match(logged, /GCC_IMAGE=mirror.example.com/);
		const config = await loadDeployment(fixture, {}, { HYDRO_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` });
		await saveDeployment(config);
		const restarted = invoke("start");
		assert.equal(restarted.status, 0, restarted.stderr);
		const response = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.json());
		assert.equal(response.origin, `http://127.0.0.1:${port}`);
		assert.equal(response.listenHost, "0.0.0.0");
		const before = readFileSync(join(fixture, ".env"), "utf8");
		const upgraded = invoke("upgrade");
		assert.equal(upgraded.status, 0, upgraded.stderr);
		assert.equal(readFileSync(join(fixture, ".env"), "utf8"), before);
		assert.match(readFileSync(join(fixture, "commands.log"), "utf8"), /git fetch origin main/);
		const uninstalled = invoke("uninstall");
		assert.equal(uninstalled.status, 0, uninstalled.stderr);
		assert.equal(readFileSync(join(fixture, ".env"), "utf8"), before);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make/runtime")), false);
		await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
	} finally { invoke("stop"); rmSync(fixture, { recursive: true, force: true }); }
});
