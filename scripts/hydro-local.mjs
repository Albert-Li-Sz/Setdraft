#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const dataRoot = join(root, ".hydro-problem-make");
const runtimeRoot = join(dataRoot, "runtime");
const image = "hydro-problem-make/sandbox:local";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const services = {
	api: { script: "dev:hydro-api", port: 4321, url: "http://127.0.0.1:4321/api/health" },
	web: { script: "dev:hydro-web", port: 5173, url: "http://127.0.0.1:5173/" },
};

function usage() {
	console.log(`Hydro Problem Make 本地管理

  ./install.sh [--dry-run]                 安装依赖、构建沙箱并启动
  ./upgrade.sh [--dry-run]                 从 origin/main 快进升级并重启
  ./uninstall.sh [--purge-data] [--remove-deps] [--dry-run]
                                          停止服务并移除沙箱镜像
  ./install.ps1 / ./upgrade.ps1 / ./uninstall.ps1
                                          Windows PowerShell 等价入口
  node scripts/hydro-local.mjs start|stop|status

卸载默认保留 .hydro-problem-make 中的题目、发布包、对话和 API 配置。
--purge-data 会永久删除这些数据；--remove-deps 额外删除根目录 node_modules。`);
}

function requireRuntime() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	if (major < 22 || (major === 22 && minor < 19)) throw new Error("需要 Node.js 22.19 或更新版本。");
}

function run(command, args) {
	console.log(`$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status ?? "未知"}。`);
}

function output(command, args) {
	const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(result.stderr.trim() || `${command} 退出码 ${result.status}。`);
	return result.stdout.trim();
}

function checkDependencies() {
	output(npm, ["--version"]);
	try {
		output("docker", ["info", "--format", "{{.ServerVersion}}"]);
	} catch (error) {
		throw new Error(`Docker 未就绪：${error instanceof Error ? error.message : String(error)}`);
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
		child = spawn(process.execPath, [scriptPath, "service", name], {
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
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch (signalError) {
			if (signalError?.code !== "ESRCH") throw signalError;
		}
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
	await stopService("web");
	await stopService("api");
}

async function checkPorts() {
	for (const [name, config] of Object.entries(services)) {
		if (!(await readManagedPid(name)) && (await portInUse(config.port))) {
			throw new Error(`端口 ${config.port} 已被其他进程占用；请先停止该进程。`);
		}
	}
}

async function startAll() {
	await checkPorts();
	const started = [];
	try {
		for (const name of Object.keys(services)) {
			if (await startService(name)) started.push(name);
		}
	} catch (error) {
		for (const name of started.reverse()) await stopService(name);
		throw error;
	}
	console.log("打开 http://127.0.0.1:5173/ 使用制题工作台。");
}

function installDependencies() {
	run(npm, ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
	run("docker", ["build", "-t", image, "packages/hydro-server/sandbox"]);
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
	if (command === "upgrade") console.log("将检查 main 工作区、执行 git fetch origin main 和 git merge --ff-only FETCH_HEAD。");
	if (command === "install" || command === "upgrade") {
		console.log(`将执行 npm ci --ignore-scripts --no-audit --no-fund、docker build -t ${image} packages/hydro-server/sandbox，然后启动 API 与网页。`);
	} else if (command === "uninstall") {
		console.log(`将停止托管服务、删除 ${image} 镜像及 ${runtimeRoot}。`);
		if (options.has("--purge-data")) console.log(`还将永久删除 ${dataRoot}。`);
		if (options.has("--remove-deps")) console.log(`还将删除 ${join(root, "node_modules")}。`);
	} else console.log(`将${command === "start" ? "启动" : "停止"} API 与网页。`);
}

function runService(name) {
	const child = spawn(npm, ["run", services[name].script], { cwd: root, stdio: "inherit" });
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
	if (command === "service") {
		if (argumentsList.length !== 1 || !Object.hasOwn(services, argumentsList[0]))
			throw new Error("无效服务名。");
		runService(argumentsList[0]);
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		usage();
		return;
	}
	if (!["install", "upgrade", "uninstall", "start", "stop", "status"].includes(command)) {
		throw new Error(`未知命令：${command}。运行 ./install.sh --dry-run 查看用法。`);
	}
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
		for (const [name, config] of Object.entries(services)) {
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
		output("docker", ["image", "inspect", image]);
		await startAll();
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
				: "本地服务已卸载。仓库源码保留；未指定 --purge-data 时制题数据与 AI 配置保留。",
		);
		return;
	}
	checkDependencies();
	if (command === "upgrade") checkUpgrade();
	await checkPorts();
	if (command === "upgrade") {
		run("git", ["fetch", "origin", "main"]);
		const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { cwd: root });
		if (result.status !== 0) throw new Error("本地 main 与 origin/main 已分叉，无法快进升级。");
	}
	await stopAll();
	if (command === "upgrade") run("git", ["merge", "--ff-only", "FETCH_HEAD"]);
	installDependencies();
	await startAll();
}

main().catch((error) => {
	console.error(`Hydro Problem Make：${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
