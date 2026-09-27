#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxBuildArgs } from "../packages/hydro-server/sandbox/build-args.mjs";
import { deploymentEnvironment, loadDeployment, networkEnvironment, redact, saveDeployment, takeDeploymentOptions } from "./deployment-config.mjs";
import { caddyEnvironment, caddyPaths, prepareCaddy } from "./managed-caddy.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
let deployment;
let dataRoot;
let runtimeRoot;
let modePath;
let image;
// .cmd files cannot be spawned directly without a shell on Windows. Invoke npm's JS entry instead.
const npm = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix = process.platform === "win32" ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] : [];
let npmRegistry;
const services = {
	api: { script: "dev:hydro-api", port: 4321, url: "http://127.0.0.1:4321/api/health" },
	web: { script: "dev:hydro-web", port: 5173, url: "http://127.0.0.1:5173/" },
	caddy: { port: 4322, url: "http://127.0.0.1:4322/api/health" },
};
let currentMode = "production";

async function readMode() {
	try {
		const saved = JSON.parse(await readFile(modePath, "utf8"));
		return saved.mode === "dev" ? "dev" : "production";
	} catch { return "production"; }
}

async function saveMode(mode) {
	await mkdir(dataRoot, { recursive: true });
	await writeFile(modePath, JSON.stringify({ mode }) + "\n");
}

function activeServices() {
	return currentMode === "dev" ? ["api", "web"] : deployment.domain ? ["api", "caddy"] : ["api"];
}

function usage() {
	console.log(`Setdraft · 题序 本地管理

  ./install.sh [--mode production|dev] [--dry-run]
                                          安装依赖、构建网页并启动；默认生产模式
  ./upgrade.sh [--mode production|dev] [--dry-run]
                                          从 origin/main 快进升级；默认沿用上次模式
  ./uninstall.sh [--purge-data] [--remove-deps] [--dry-run]
                                          停止服务并移除沙箱镜像
  ./install.ps1 / ./upgrade.ps1 / ./uninstall.ps1
                                          Windows PowerShell 等价入口
  部署参数（install / upgrade / start）：
    --domain <域名> [--email <证书邮箱>]     自动配置同机 Caddy HTTPS
    --proxy-mode off|external|caddy         本机 / 已有代理 / 托管 Caddy
    --network cn|global                    国内或国际网络；默认 cn
    --registry <HTTPS npm 源>              自定义 npm 源
    --docker-registry <镜像仓库>            Docker Hub 镜像，不含协议
    --download-proxy <HTTP(S) 代理>         npm、Git、Caddy 下载代理
    --caddy-archive <官方安装包>            校验后离线安装 Caddy
  node scripts/hydro-local.mjs start [--mode production|dev]|stop|status|doctor
  node scripts/hydro-local.mjs backup <目录>|restore <目录>
  node scripts/hydro-local.mjs prune --older-than-days <天数> [--dry-run]
  node scripts/hydro-local.mjs account setup-code|reset-password <用户名>

部署参数保存到仓库 .env；升级和启动自动加载，命令行 > 环境变量 > .env。
卸载默认保留 .env、证书以及 .hydro-problem-make 中的题目、发布包、对话和 API 配置。
--purge-data 会永久删除这些数据；--remove-deps 额外删除根目录 node_modules。`);
}

function requireRuntime() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) throw new Error("需要 Node.js 22.19 或更新版本。");
}

function run(command, args, environment = process.env) {
	console.log(redact(`$ ${command} ${args.join(" ")}`));
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: environment });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? "未知"}。`);
}

function npmArgs(args) {
	return [...npmPrefix, "--registry", npmRegistry, "--fetch-retries=2", "--fetch-timeout=60000", "--fetch-retry-mintimeout=2000", "--fetch-retry-maxtimeout=10000", ...args];
}

function runNpm(args) {
	run(npm, npmArgs(args), networkEnvironment(deployment));
}

function hasValidModelData() {
	const result = spawnSync(
		npm,
		npmArgs(["run", "check:model-data", "--workspace=@earendil-works/pi-ai"]),
		{ cwd: root, stdio: "ignore" },
	);
	if (result.error) throw result.error;
	return result.status === 0;
}

function output(command, args) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} 退出码 ${result.status}。`);
	return result.stdout.trim();
}

function checkDependencies() {
	output(npm, [...npmPrefix, "--version"]);
	try {
		output("docker", ["info", "--format", "{{.ServerVersion}}"]);
	} catch (error) {
		console.warn(`Docker 未就绪，网页仍可使用；验证前请启动 Docker：${error instanceof Error ? error.message : String(error)}`);
	}
}

function pidPath(name) {
	return join(runtimeRoot, `${name}.pid.json`);
}

async function readManagedPid(name) {
	let value;
	try {
		value = JSON.parse(await readFile(pidPath(name), "utf8"));
	} catch {
		return undefined;
	}
	if (!Number.isSafeInteger(value?.pid) || value.pid < 1) return undefined;
	try {
		process.kill(value.pid, 0);
		return value.pid;
	} catch {
		return undefined;
	}
}

async function portInUse(port) {
	return new Promise((resolvePort) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.setTimeout(1000);
		socket.once("connect", () => {
			socket.destroy();
			resolvePort(true);
		});
		socket.once("error", () => resolvePort(false));
		socket.once("timeout", () => {
			socket.destroy();
			resolvePort(false);
		});
	});
}

async function ready(url) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
		return response.ok;
	} catch {
		return false;
	}
}

async function waitForService(name) {
	const deadline = Date.now() + 45_000;
	const startedAt = Date.now();
	while (Date.now() < deadline) {
		if (await ready(services[name].url)) return;
		if (Date.now() - startedAt > 1000 && !(await readManagedPid(name))) break;
		await new Promise((resolveWait) => setTimeout(resolveWait, 500));
	}
	throw new Error(`${name} 启动失败，请查看 ${join(runtimeRoot, `${name}.log`)}。`);
}

async function startService(name) {
	if (await readManagedPid(name)) {
		await waitForService(name);
		console.log(`${name} 已在运行。`);
		return false;
	}
	await mkdir(runtimeRoot, { recursive: true });
	const log = openSync(join(runtimeRoot, `${name}.log`), "a");
	let child;
	try {
		child = spawn(process.execPath, [scriptPath, "service", name, currentMode], {
			cwd: root,
			detached: true,
			stdio: ["ignore", log, log],
		});
	} finally {
		closeSync(log);
	}
	await new Promise((resolveSpawn, rejectSpawn) => {
		child.once("spawn", resolveSpawn);
		child.once("error", rejectSpawn);
	});
	child.unref();
	const target = pidPath(name);
	const temporary = `${target}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString() }));
	await rename(temporary, target);
	try {
		await waitForService(name);
	} catch (error) {
		stopPid(child.pid, true);
		await rm(target, { force: true });
		throw error;
	}
	console.log(`${name} 已启动：${services[name].url}`);
	return true;
}

async function stopService(name) {
	const pid = await readManagedPid(name);
	if (!pid) {
		await rm(pidPath(name), { force: true });
		return;
	}
	stopPid(pid, false);
	for (let attempt = 0; attempt < 50 && (await readManagedPid(name)); attempt++) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 100));
	}
	if (await readManagedPid(name)) {
		stopPid(pid, true);
	}
	await rm(pidPath(name), { force: true });
	console.log(`${name} 已停止。`);
}

function stopPid(pid, force) {
	if (process.platform === "win32") {
		const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { cwd: root, stdio: "ignore" });
		if (result.status !== 0 && !force) throw new Error(`无法停止进程 ${pid}。`);
		return;
	}
	try {
		process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
		try {
			process.kill(pid, force ? "SIGKILL" : "SIGTERM");
		} catch (fallbackError) {
			if (fallbackError?.code !== "ESRCH") throw fallbackError;
		}
	}
}

async function stopAll() {
	for (const name of Object.keys(services).reverse()) await stopService(name);
}

async function checkPorts() {
	for (const name of activeServices()) {
		const config = services[name];
		if (!(await readManagedPid(name)) && (await portInUse(config.port))) {
			throw new Error(`端口 ${config.port} 已被其他进程占用；请先停止该进程。`);
		}
	}
	if (deployment.domain && !(await readManagedPid("caddy"))) {
		for (const port of [80, 443]) if (await portInUse(port))
			throw new Error(`端口 ${port} 已被占用。已有反向代理请使用 --proxy-mode external；脚本不会覆盖系统代理配置。`);
	}
}

async function startAll() {
	await checkPorts();
	const started = [];
	try {
		for (const name of activeServices()) {
			if (await startService(name)) started.push(name);
		}
	} catch (error) {
		for (const name of started.reverse()) await stopService(name);
		throw error;
	}
	console.log(`打开 ${process.env.HYDRO_PUBLIC_ORIGIN ?? `http://127.0.0.1:${currentMode === "dev" ? "5173" : "4321"}`} 使用制题工作台。`);
	if (deployment.domain) console.log(`Caddy 本机转发已就绪；公网 DNS、80/443 入站和证书签发请用浏览器确认。证书日志：${join(runtimeRoot, "caddy.log")}。`);
	try {
		const session = await fetch("http://127.0.0.1:4321/api/auth/session").then((response) => response.json());
		if (session.setupRequired) await account(["setup-code"]);
	} catch { console.log("首次初始化的安装码见 API 启动日志；也可运行 account setup-code 重新生成。"); }
}

function installDependencies() {
	runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
	if (!hasValidModelData()) {
		console.log("模型数据缺失或校验失败，正在生成模型数据。");
		runNpm(["run", "hydrate-model-data", "--workspace=@earendil-works/pi-ai"]);
	}
	runNpm(["run", "check:model-data", "--workspace=@earendil-works/pi-ai"]);
	runNpm(["run", "build:offline", "--workspace=@earendil-works/pi-ai"]);
	for (const workspace of [
		"@earendil-works/pi-telemetry",
		"@hydro-problem-make/authoring",
		"@hydro-problem-make/server",
		"@hydro-problem-make/web",
	]) runNpm(["run", "build", `--workspace=${workspace}`]);
	try { run("docker", ["build", "-t", image, ...sandboxBuildArgs(process.env), "packages/hydro-server/sandbox"]); }
	catch (error) { console.warn(`沙盒镜像未能构建，网页可继续使用；请检查 Docker Hub 访问或配置 HYDRO_DOCKER_REGISTRY，稍后在管理员设置页重试：${redact(error instanceof Error ? error.message : String(error))}`); }
}

function selectRegistry() {
	const available = (registry) => spawnSync(npm, [...npmPrefix, "ping", "--registry", registry, "--fetch-timeout=15000", "--fetch-retries=1"], {
		cwd: root, env: networkEnvironment(deployment), stdio: "ignore", timeout: 40_000,
	}).status === 0;
	if (available(npmRegistry)) return;
	const fallback = "https://registry.npmjs.org";
	if (!deployment.values.HYDRO_NPM_REGISTRY && npmRegistry !== fallback && available(fallback)) {
		console.warn("默认 npm 镜像不可达，本次安装回退到 npm 官方源；继续保留锁文件完整性校验。");
		npmRegistry = fallback;
		return;
	}
	throw new Error("npm 源不可达。请检查网络，配置 --registry 或 --download-proxy 后重试；不会禁用 TLS 或完整性校验。");
}

function checkUpgrade() {
	if (output("git", ["branch", "--show-current"]) !== "main") {
		throw new Error("升级脚本只支持 main 分支；请先切换到仓库的 main 分支。");
	}
	if (output("git", ["status", "--porcelain", "--untracked-files=normal"])) {
		throw new Error("工作区有未提交改动；请先提交或处理改动，升级不会覆盖它们。");
	}
	output("git", ["remote", "get-url", "origin"]);
}

function printDryRun(command, options) {
	if (["install", "upgrade", "start"].includes(command)) {
		console.log(`将写入 ${deployment.path}（仅项目配置），网络 ${deployment.values.HYDRO_NETWORK}，代理模式 ${deployment.values.HYDRO_PROXY_MODE}。`);
		console.log(`Debian 软件源：${deployment.debianMirror}；Docker 镜像仓库：${deployment.values.HYDRO_DOCKER_REGISTRY || "Docker Hub（可自定义可信镜像）"}。`);
		if (deployment.values.HYDRO_DOWNLOAD_PROXY) console.log("下载代理：已配置（地址不显示）。");
		if (deployment.domain) console.log(`将安装并校验 Caddy、生成反向代理配置，使用 https://${deployment.domain}，托管 80/443 端口；证书持久化保存在 deployment/data。`);
		if (deployment.values.HYDRO_PROXY_MODE === "external") console.log("沿用外部反向代理；不会启动或修改系统 Caddy。");
	}
	if (command === "upgrade") console.log("将检查 main 工作区、执行 git fetch origin main 和 git merge --ff-only FETCH_HEAD。");
	if (command === "install" || command === "upgrade") {
		console.log(`将使用 npm 镜像 ${npmRegistry} 执行 npm ci --ignore-scripts --no-audit --no-fund；模型数据缺失时先补齐，再执行 pi-ai 离线构建、其余工作区构建、docker build -t ${image} packages/hydro-server/sandbox，然后以 ${currentMode} 模式启动。Docker 故障只告警。`);
	} else if (command === "uninstall") {
		console.log(`将停止托管服务、删除 ${image} 镜像及 ${runtimeRoot}。`);
		if (options.has("--purge-data")) console.log(`还将永久删除 ${dataRoot}。`);
		if (options.has("--remove-deps")) console.log(`还将删除 ${join(root, "node_modules")}。`);
	} else console.log(`将${command === "start" ? "启动" : "停止"} API、网页和已配置的托管反向代理。`);
}

function runService(name, mode) {
	const production = name === "api" && mode === "production";
	const proxy = name === "caddy";
	const paths = caddyPaths(deployment);
	const executable = proxy ? paths.binary : production ? process.execPath : npm;
	const args = proxy ? ["run", "--config", paths.file, "--adapter", "caddyfile"] : production ? [join(root, "packages", "hydro-server", "dist", "cli.js")] : [...npmPrefix, "run", services[name].script];
	const child = spawn(executable, args, {
		cwd: root,
		stdio: "inherit",
		env: proxy ? caddyEnvironment(deployment) : production ? { ...process.env, HYDRO_WEB_ROOT: join(root, "packages", "hydro-web", "dist") } : process.env,
	});
	const forward = () => child.kill("SIGTERM");
	process.on("SIGTERM", forward);
	process.on("SIGINT", forward);
	child.once("error", (error) => {
		console.error(error);
		process.exit(1);
	});
	child.once("exit", (code) => process.exit(code ?? 1));
}

async function main() {
	requireRuntime();
	const [command = "help", ...argumentsList] = process.argv.slice(2);
	if (["help", "--help", "-h"].includes(command) || argumentsList.includes("--help")) { usage(); return; }
	const overrides = takeDeploymentOptions(argumentsList, command);
	deployment = await loadDeployment(root, process.env, overrides);
	process.env = deploymentEnvironment(deployment);
	dataRoot = deployment.dataRoot;
	runtimeRoot = join(dataRoot, "runtime");
	modePath = join(dataRoot, "mode.json");
	image = process.env.HYDRO_SANDBOX_IMAGE || "hydro-problem-make/sandbox:local";
	npmRegistry = deployment.registry;
	if (command === "service") {
		if (argumentsList.length !== 2 || !Object.hasOwn(services, argumentsList[0]) || !["dev", "production"].includes(argumentsList[1]))
			throw new Error("无效服务名。");
		runService(argumentsList[0], argumentsList[1]);
		return;
	}
	if (!["install", "upgrade", "uninstall", "start", "stop", "status", "doctor", "backup", "restore", "prune", "account"].includes(command)) {
		throw new Error(`未知命令：${command}。运行 ./install.sh --dry-run 查看用法。`);
	}
	if (command === "account") { await account(argumentsList); return; }
	if (command === "doctor") { await doctor(); return; }
	if (command === "backup" || command === "restore") {
		if (argumentsList.length !== 1) throw new Error(`${command} 需要一个目录参数。`);
		if (command === "backup") await backup(resolve(argumentsList[0]));
		else await restore(resolve(argumentsList[0]));
		return;
	}
	if (command === "prune") { await prune(argumentsList); return; }
	const modeIndex = argumentsList.indexOf("--mode");
	let requestedMode;
	if (modeIndex >= 0) {
		requestedMode = argumentsList[modeIndex + 1];
		argumentsList.splice(modeIndex, 2);
		if (!["dev", "production"].includes(requestedMode) || !["install", "upgrade", "start"].includes(command)) throw new Error("--mode 只能指定 dev 或 production。");
	}
	currentMode = requestedMode ?? (command === "install" ? "production" : await readMode());
	if (["install", "upgrade", "start"].includes(command) && currentMode === "dev" && deployment.values.HYDRO_PROXY_MODE !== "off")
		throw new Error("反向代理仅支持 production 模式；开发环境请使用独立检出并清空 HTTPS 配置。");
	const options = new Set(argumentsList);
	const allowed =
		command === "uninstall"
			? ["--dry-run", "--purge-data", "--remove-deps"]
			: command === "status"
				? []
				: ["--dry-run"];
	if (argumentsList.length !== options.size || [...options].some((value) => !allowed.includes(value))) {
		throw new Error("参数无效或重复，请运行 node scripts/hydro-local.mjs help 查看用法。");
	}
	if (options.has("--dry-run")) {
		printDryRun(command, options);
		return;
	}
	if (command === "status") {
		for (const name of Object.keys(services)) {
			const config = services[name];
			const managed = await readManagedPid(name);
			const status = managed
				? (await ready(config.url))
					? "运行中"
					: "启动中或故障"
				: (await portInUse(config.port))
					? "端口已占用（非脚本托管）"
					: "未运行";
			console.log(`${name}: ${status}`);
		}
		return;
	}
	if (command === "stop") {
		await stopAll();
		return;
	}
	if (command === "start") {
		checkDependencies();
		if (currentMode === "production" && !(await stat(join(root, "packages", "hydro-web", "dist", "index.html")).catch(() => undefined))) throw new Error("生产网页尚未构建，请先运行 ./install.sh。");
		await checkPorts();
		await prepareCaddy(deployment);
		await stopAll();
		await saveDeployment(deployment);
		await startAll();
		await saveMode(currentMode);
		return;
	}
	if (command === "uninstall") {
		await stopAll();
		const inspected = spawnSync("docker", ["image", "inspect", image], { cwd: root, encoding: "utf8" });
		if (inspected.status === 0) {
			try {
				run("docker", ["image", "rm", image]);
			} catch (error) {
				console.warn(`沙箱镜像未删除：${error instanceof Error ? error.message : String(error)}`);
				process.exitCode = 1;
			}
		} else if (inspected.error || !inspected.stderr.includes("No such image")) {
			console.warn(`无法检查沙箱镜像：${inspected.error?.message ?? inspected.stderr.trim()}`);
			process.exitCode = 1;
		}
		await rm(runtimeRoot, { recursive: true, force: true });
		if (options.has("--purge-data")) await rm(dataRoot, { recursive: true, force: true });
		if (options.has("--remove-deps")) await rm(join(root, "node_modules"), { recursive: true, force: true });
		console.log(
			process.exitCode
				? "本地服务已停止，但沙箱镜像未能删除；请检查 Docker 后手动删除。"
				: "本地服务已卸载。仓库源码及 .env 保留；未指定 --purge-data 时制题数据、AI 配置和 Caddy 证书保留。",
		);
		return;
	}
	checkDependencies();
	if (command === "upgrade") checkUpgrade();
	await checkPorts();
	if (command === "upgrade") {
		run("git", ["fetch", "origin", "main"], networkEnvironment(deployment));
		const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { cwd: root });
		if (result.status !== 0) throw new Error("本地 main 与 origin/main 已分叉，无法快进升级。");
		await stopAll();
		run("git", ["merge", "--ff-only", "FETCH_HEAD"]);
		await saveDeployment(deployment);
		// Use the upgraded installer/manifest, including any newer pinned Caddy release.
		run(process.execPath, [scriptPath, "install", "--mode", currentMode], { ...process.env, ...deployment.values });
		return;
	}
	selectRegistry();
	await prepareCaddy(deployment);
	await stopAll();
	await saveDeployment(deployment);
	installDependencies();
	await startAll();
	await saveMode(currentMode);
}

async function account(args) {
	if (!((args.length === 1 && args[0] === "setup-code") || (args.length === 2 && args[0] === "reset-password"))) throw new Error("用法：account setup-code | account reset-password <用户名>");
	const built = join(root, "packages/hydro-server/dist/account-cli.js");
	const command = await stat(built).catch(() => undefined) ? [built, ...args] : ["--import", "tsx", join(root, "packages/hydro-server/src/account-cli.ts"), ...args];
	run(process.execPath, command);
}

async function doctor() {
	console.log(`Node.js ${process.version} · 模式 ${await readMode()}`);
	console.log(`配置：${deployment.path} · 网络 ${deployment.values.HYDRO_NETWORK} · npm ${npmRegistry}`);
	console.log(`站点来源：${deployment.values.HYDRO_PUBLIC_ORIGIN || "本机"} · 代理 ${deployment.values.HYDRO_PROXY_MODE}`);
	if (deployment.domain) {
		console.log(`Caddy 配置：${caddyPaths(deployment).file}；证书位于 deployment/data，日志位于 runtime/caddy.log。`);
		console.log(`公网 HTTPS：${await ready(`${deployment.values.HYDRO_PUBLIC_ORIGIN}/api/health`) ? "可访问" : "未确认，请检查 DNS、80/443、防火墙和证书日志"}`);
	}
	try { console.log(`npm ${output(npm, [...npmPrefix, "--version"])}`); } catch (error) { console.log(`npm 不可用：${error}`); }
	try {
		console.log(`Docker ${output("docker", ["info", "--format", "{{.ServerVersion}}"])}`);
		try { output("docker", ["image", "inspect", image]); console.log("沙盒镜像已就绪。"); }
		catch { console.log("沙盒镜像缺失；可在设置页构建。"); }
	} catch { console.log("Docker 守护进程未运行；网页仍可启动。"); }
	const directories = await workspaceDirectories(dataRoot);
	console.log(`身份库：${await stat(join(dataRoot, "identity.sqlite")).catch(() => undefined) ? "校验通过" : "尚未创建"}`);
	for (const workspace of directories) {
		const databasePath = join(workspace, "workspace.sqlite");
		if (await stat(databasePath).catch(() => undefined)) {
			const database = new DatabaseSync(databasePath, { readOnly: true });
			try { console.log(`SQLite ${workspace}: ${database.prepare("PRAGMA integrity_check").get().integrity_check}`); }
			finally { database.close(); }
		}
	}
	for (const [name, service] of Object.entries(services)) console.log(`${name}: ${await ready(service.url) ? "在线" : "未运行"}`);
}

async function assertOffline() {
	const pid = Number(await readFile(join(dataRoot, "server.pid"), "utf8").catch(() => "0"));
	if (!Number.isSafeInteger(pid) || pid < 1) return;
	try { process.kill(pid, 0); }
	catch (error) { if (error.code === "ESRCH") return; throw error; }
	throw new Error("数据目录仍有直接启动的服务，请先停止该服务后再执行维护。");
}

async function backup(destination) {
	if (resolve(destination) === resolve(dataRoot) || resolve(destination).startsWith(`${resolve(dataRoot)}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("备份目标不能在业务数据目录内。");
	if (await stat(destination).catch(() => undefined)) throw new Error("备份目标已存在，请选择新目录。");
	await stopAll();
	await assertOffline();
	try {
		await cp(dataRoot, destination, { recursive: true, filter: (source) => !source.includes(`${process.platform === "win32" ? "\\" : "/"}runtime${process.platform === "win32" ? "\\" : "/"}`) });
		if (await stat(deployment.path).catch(() => undefined)) await cp(deployment.path, join(destination, "deployment.env"));
		await validateWorkspaceDirectory(destination);
	} catch (error) {
		await rm(destination, { recursive: true, force: true });
		throw error;
	}
	console.log(`备份完成：${destination}，包含部署配置快照与托管 Caddy 证书。服务已停止，可运行 start 重启。`);
}

async function restore(source) {
	if (resolve(source) === resolve(dataRoot) || resolve(source).startsWith(`${resolve(dataRoot)}${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("不能从业务数据目录内部恢复。");
	await validateWorkspaceDirectory(source);
	await stopAll();
	await assertOffline();
	const previous = `${dataRoot}.before-restore-${Date.now()}`;
	if (await stat(dataRoot).catch(() => undefined)) await rename(dataRoot, previous);
	try {
		await cp(source, dataRoot, { recursive: true });
		await validateWorkspaceDirectory(dataRoot);
		const identityPath = join(dataRoot, "identity.sqlite");
		if (await stat(identityPath).catch(() => undefined)) {
			const identity = new DatabaseSync(identityPath);
			try { identity.exec("DELETE FROM sessions; DELETE FROM metadata WHERE key='setup';"); } finally { identity.close(); }
		}
	}
	catch (error) { await rm(dataRoot, { recursive: true, force: true }); if (await stat(previous).catch(() => undefined)) await rename(previous, dataRoot); throw error; }
	console.log(`恢复完成：${dataRoot}。旧数据保存在 ${previous}；本机 .env 保留，迁移时请核对备份中的 deployment.env。运行 start 启动。`);
}

async function workspaceDirectories(directory) {
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

async function validateWorkspaceDirectory(directory) {
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

async function prune(args) {
	if (args.length < 2 || args[0] !== "--older-than-days" || !/^\d+$/u.test(args[1]) || args.slice(2).some((item) => item !== "--dry-run")) throw new Error("用法：prune --older-than-days <天数> [--dry-run]");
	const days = Number(args[1]);
	if (days < 1 || !Number.isSafeInteger(days)) throw new Error("保留天数须为正整数。");
	await stopAll();
	await assertOffline();
	for (const workspace of await workspaceDirectories(dataRoot)) await pruneWorkspace(workspace, days, args.includes("--dry-run"));
}

async function pruneWorkspace(workspace, days, dryRun) {
	const databasePath = join(workspace, "workspace.sqlite");
	if (!(await stat(databasePath).catch(() => undefined))) return;
	const database = new DatabaseSync(databasePath);
	try {
		const readDocs = (kind) => database.prepare("SELECT id,body FROM documents WHERE kind=?").all(kind).map((row) => ({ id: row.id, ...JSON.parse(row.body) }));
		const referenced = new Set(readDocs("contest").flatMap((item) => item.releaseIds ?? []));
		const latest = new Set(readDocs("project").map((item) => item.latestReleaseId).filter(Boolean));
		const limit = Date.now() - days * 24 * 60 * 60 * 1000;
		const expired = readDocs("release").filter((item) => Date.parse(item.createdAt) < limit && !referenced.has(item.id) && !latest.has(item.id));
		console.log(`找到 ${expired.length} 个超过 ${days} 天且未被竞赛引用、不是草稿最新版本的发布包。`);
		if (dryRun) { for (const item of expired) console.log(`${item.id} ${item.title}`); return; }
		for (const item of expired) {
			database.prepare("DELETE FROM files WHERE owner_kind='release-file' AND owner_id=?").run(item.id);
			database.prepare("DELETE FROM documents WHERE kind='release' AND id=?").run(item.id);
			await rm(join(workspace, "releases", item.id), { recursive: true, force: true });
		}
		const referencedHashes = new Set(database.prepare("SELECT DISTINCT hash FROM files").all().map((item) => item.hash));
		for (const shard of await readdir(join(workspace, "blobs"), { withFileTypes: true }).catch(() => [])) {
			if (!shard.isDirectory()) continue;
			for (const blob of await readdir(join(workspace, "blobs", shard.name))) if (!referencedHashes.has(blob)) await rm(join(workspace, "blobs", shard.name, blob));
		}
		console.log(`已清理 ${expired.length} 个过期发布包。服务已停止，可运行 start 重启。`);
	} finally { database.close(); }
}

main().catch((error) => {
	console.error(`Setdraft：${redact(error instanceof Error ? error.message : String(error))}`);
	process.exitCode = 1;
});
