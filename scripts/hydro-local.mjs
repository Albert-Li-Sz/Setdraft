#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, stat, writeFile, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxBuildArgs } from "../packages/hydro-server/sandbox/build-args.mjs";
import { deploymentEnvironment, loadDeployment, networkEnvironment, redact, saveDeployment, takeDeploymentOptions } from "./deployment-config.mjs";


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
	return currentMode === "dev" ? ["api", "web"] : ["api"];
}

function usage() {
	console.log(`Setdraft · 题序 本地管理

  ./install.sh --native [--mode production|dev] [--dry-run]
                                          安装依赖、构建网页并启动；默认生产模式
  ./upgrade.sh --native [--mode production|dev] [--dry-run]
                                          从 origin/main 快进升级；默认沿用上次模式
  ./uninstall.sh --native [--purge-data] [--remove-deps] [--dry-run]
                                          停止服务并移除沙箱镜像
  部署参数（install / upgrade / start）：
    --host 0.0.0.0|127.0.0.1              生产模式监听地址；默认 0.0.0.0
    --public-origin <HTTP(S) URL>          自建反向代理后的浏览器访问来源
    --network cn|global                    国内或国际网络；默认 cn
    --registry <HTTPS npm 源>              自定义 npm 源
    --docker-registry <镜像仓库>            Docker Hub 镜像，不含协议
    --download-proxy <HTTP(S) 代理>         npm、Git 下载代理
  node scripts/hydro-local.mjs start [--mode production|dev]|stop|status|doctor
  node scripts/hydro-local.mjs backup <目录>|restore <目录>
  node scripts/hydro-local.mjs prune --older-than-days <天数> [--dry-run]
  node scripts/hydro-local.mjs account setup-code|reset-password <用户名>

部署参数保存到仓库 .env；升级和启动自动加载，命令行 > 环境变量 > .env。
卸载默认保留 .env 以及 .setdraft 中的题目、发布包、对话和 API 配置。
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
	// Stop a proxy managed by older installers; never touch a system proxy.
	for (const name of ["caddy", ...Object.keys(services).reverse()]) await stopService(name);
}

async function checkPorts() {
	for (const name of activeServices()) {
		const config = services[name];
		if (!(await readManagedPid(name)) && (await portInUse(config.port))) {
			throw new Error(`端口 ${config.port} 已被其他进程占用；请先停止该进程。`);
		}
	}
}

async function startAll() {
 if(!process.env.SETDRAFT_DATABASE_URL)throw new Error("原生开发需要配置 SETDRAFT_DATABASE_URL；默认部署请运行 ./install.sh 使用 PostgreSQL Compose。");
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
	console.log(`打开 ${process.env.SETDRAFT_PUBLIC_ORIGIN ?? `http://127.0.0.1:${currentMode === "dev" ? "5173" : "4321"}`} 使用制题工作台。`);
	if (currentMode === "production") console.log(`Web/API 监听 ${deployment.values.SETDRAFT_HOST}:4321；${deployment.values.SETDRAFT_HOST === "0.0.0.0" ? "可通过 http://服务器IP:4321 访问" : "仅本机可直接访问"}。反向代理由使用者自行配置。`);
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
	// AI imports telemetry declarations from dist, which is absent on first installation.
	runNpm(["run", "build", "--workspace=@earendil-works/pi-telemetry"]);
	runNpm(["run", "build:offline", "--workspace=@earendil-works/pi-ai"]);
	for (const workspace of [
		"@setdraft/authoring",
		"@setdraft/server",
		"@setdraft/web",
	]) runNpm(["run", "build", `--workspace=${workspace}`]);
	try { run("docker", ["build", "-t", image, ...sandboxBuildArgs(process.env), "packages/hydro-server/sandbox"]); }
	catch (error) { console.warn(`沙盒镜像未能构建，网页可继续使用；请检查 Docker Hub 访问或配置 SETDRAFT_DOCKER_REGISTRY，稍后在管理员设置页重试：${redact(error instanceof Error ? error.message : String(error))}`); }
}

function selectRegistry() {
	const available = (registry) => spawnSync(npm, [...npmPrefix, "ping", "--registry", registry, "--fetch-timeout=15000", "--fetch-retries=1"], {
		cwd: root, env: networkEnvironment(deployment), stdio: "ignore", timeout: 40_000,
	}).status === 0;
	if (available(npmRegistry)) return;
	const fallback = "https://registry.npmjs.org";
	if (!deployment.values.SETDRAFT_NPM_REGISTRY && npmRegistry !== fallback && available(fallback)) {
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
		console.log(`将写入 ${deployment.path}（仅项目配置），网络 ${deployment.values.SETDRAFT_NETWORK}，生产监听 ${deployment.values.SETDRAFT_HOST}:4321。`);
		console.log(`Debian 软件源：${deployment.debianMirror}；Docker 镜像仓库：${deployment.values.SETDRAFT_DOCKER_REGISTRY || "Docker Hub（可自定义可信镜像）"}。`);
		if (deployment.values.SETDRAFT_DOWNLOAD_PROXY) console.log("下载代理：已配置（地址不显示）。");
		if (deployment.values.SETDRAFT_PUBLIC_ORIGIN) console.log(`浏览器访问来源：${deployment.values.SETDRAFT_PUBLIC_ORIGIN}。`);
		console.log("不安装或托管反向代理；可自行将代理指向 Web/API 的 4321 端口。");
	}
	if (command === "upgrade") console.log("将检查 main 工作区、执行 git fetch origin main 和 git merge --ff-only FETCH_HEAD。");
	if (command === "install" || command === "upgrade") {
		console.log(`将使用 npm 镜像 ${npmRegistry} 执行 npm ci --ignore-scripts --no-audit --no-fund；模型数据缺失时先补齐，再依次构建 telemetry、pi-ai（离线）、其余工作区、docker build -t ${image} packages/hydro-server/sandbox，然后以 ${currentMode} 模式启动。Docker 故障只告警。`);
	} else if (command === "uninstall") {
		console.log(`将停止托管服务、删除 ${image} 镜像及 ${runtimeRoot}。`);
		if (options.has("--purge-data")) console.log(`还将永久删除 ${dataRoot}。`);
		if (options.has("--remove-deps")) console.log(`还将删除 ${join(root, "node_modules")}。`);
	} else console.log(`将${command === "start" ? "启动" : "停止"} API 和网页。`);
}

function runService(name, mode) {
	const production = name === "api" && mode === "production";
	const executable = production ? process.execPath : npm;
	const args = production ? [join(root, "packages", "hydro-server", "dist", "cli.js")] : [...npmPrefix, "run", services[name].script];
	const child = spawn(executable, args, {
		cwd: root,
		stdio: "inherit",
		env: production ? { ...process.env, SETDRAFT_WEB_ROOT: join(root, "packages", "hydro-web", "dist") } : { ...process.env, SETDRAFT_HOST: "127.0.0.1" },
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
	image = process.env.SETDRAFT_SANDBOX_IMAGE || "setdraft/sandbox:local";
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
	if (["install", "upgrade", "start"].includes(command) && currentMode === "dev" && deployment.values.SETDRAFT_PUBLIC_ORIGIN)
		throw new Error("反向代理仅支持 production 模式；开发环境请使用独立检出并清空公开站点配置。");
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
				: "本地服务已卸载。仓库源码及 .env 保留；未指定 --purge-data 时制题数据与 AI 配置保留。",
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
		// Use the upgraded installer/manifest, including its updated build order.
		run(process.execPath, [scriptPath, "install", "--mode", currentMode], { ...process.env, ...deployment.values });
		return;
	}
	selectRegistry();
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
	console.log(`配置：${deployment.path} · 网络 ${deployment.values.SETDRAFT_NETWORK} · npm ${npmRegistry}`);
	console.log(`生产监听：${deployment.values.SETDRAFT_HOST}:4321 · 站点来源：${deployment.values.SETDRAFT_PUBLIC_ORIGIN || "通过服务器 IP 直接访问"}`);
	if (deployment.values.SETDRAFT_PUBLIC_ORIGIN)
		console.log(`外部站点：${await ready(`${deployment.values.SETDRAFT_PUBLIC_ORIGIN}/api/health`) ? "可访问" : "未确认，请检查自建反向代理配置"}`);
	try { console.log(`npm ${output(npm, [...npmPrefix, "--version"])}`); } catch (error) { console.log(`npm 不可用：${error}`); }
	try {
		console.log(`Docker ${output("docker", ["info", "--format", "{{.ServerVersion}}"])}`);
		try { output("docker", ["image", "inspect", image]); console.log("沙盒镜像已就绪。"); }
		catch { console.log("沙盒镜像缺失；可在设置页构建。"); }
	} catch { console.log("Docker 守护进程未运行；网页仍可启动。"); }
	console.log(`PostgreSQL：${process.env.SETDRAFT_DATABASE_URL ? "已配置" : "未配置 SETDRAFT_DATABASE_URL"}`);
	for (const [name, service] of Object.entries(services)) console.log(`${name}: ${await ready(service.url) ? "在线" : "未运行"}`);
}

async function assertOffline() {
	const pid = Number(await readFile(join(dataRoot, "server.pid"), "utf8").catch(() => "0"));
	if (!Number.isSafeInteger(pid) || pid < 1) return;
	try { process.kill(pid, 0); }
	catch (error) { if (error.code === "ESRCH") return; throw error; }
	throw new Error("数据目录仍有直接启动的服务，请先停止该服务后再执行维护。");
}

async function maintenance(command,directory) {
 await stopAll();await assertOffline();
 run("sh",[join(root,"scripts/setdraft-compose.sh"),command,directory]);
}
async function backup(directory){await maintenance("backup",directory);}
async function restore(directory){await maintenance("restore",directory);}
async function prune(){throw new Error("请在题目内部管理发布包；不再提供 SQLite 离线清理命令。");}

main().catch((error) => {
	console.error(`Setdraft：${redact(error instanceof Error ? error.message : String(error))}`);
	process.exitCode = 1;
});
