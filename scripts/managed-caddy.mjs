import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import release from "./caddy-release.json" with { type: "json" };
import { caddyfile, networkEnvironment, redact } from "./deployment-config.mjs";

export function caddyAsset(platform = process.platform, architecture = process.arch) {
	const os = { linux: "linux", darwin: "mac", win32: "windows" }[platform];
	const arch = { x64: "amd64", arm64: "arm64" }[architecture];
	const name = `caddy_${release.version}_${os}_${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
	if (!release.sha256[name]) throw new Error("此平台没有内置 Caddy 下载包；请设置 HYDRO_CADDY_BIN 使用自行安装的 Caddy 2。");
	return { name, sha256: release.sha256[name], version: release.version };
}

export async function verifyArchive(path, expected) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	if (hash.digest("hex") !== expected) throw new Error("Caddy 安装包 SHA-256 不匹配，已拒绝解压和执行。请重新下载对应版本。");
}

export function caddyPaths(config) {
	const directory = join(config.dataRoot, "deployment");
	const binary = config.values.HYDRO_CADDY_BIN
		? resolve(config.root, config.values.HYDRO_CADDY_BIN)
		: join(directory, "bin", release.version, process.platform === "win32" ? "caddy.exe" : "caddy");
	return { directory, binary, file: join(directory, "Caddyfile") };
}

export function caddyEnvironment(config, base = process.env) {
	const { directory } = caddyPaths(config);
	return { ...networkEnvironment(config, base), XDG_DATA_HOME: join(directory, "data"), XDG_CONFIG_HOME: join(directory, "config") };
}

function execute(command, args, config, { quiet = false } = {}) {
	const result = spawnSync(command, args, {
		cwd: config.root, env: caddyEnvironment(config), encoding: "utf8", stdio: quiet ? "pipe" : "inherit",
	});
	if (result.error || result.status !== 0)
		throw new Error(redact(result.error?.message ?? result.stderr?.trim() ?? `${command} 执行失败。`));
	return result.stdout?.trim();
}

async function download(config, asset, destination) {
	const base = config.values.HYDRO_CADDY_DOWNLOAD_BASE?.replace(/\/$/u, "") || `https://github.com/caddyserver/caddy/releases/download/v${release.version}`;
	const temporary = `${destination}.${process.pid}.part`;
	console.log(`下载 Caddy ${release.version}（固定 SHA-256 校验）。`);
	try {
		execute(process.platform === "win32" ? "curl.exe" : "curl", [
			"--fail", "--location", "--show-error", "--silent", "--proto", "=https", "--proto-redir", "=https",
			"--connect-timeout", "15", "--max-time", "180", "--retry", "2", "--retry-delay", "2",
			"--output", temporary, `${base}/${asset.name}`,
		], config);
		await verifyArchive(temporary, asset.sha256);
		await rename(temporary, destination);
	} catch (error) {
		throw new Error(`${error.message}\nCaddy 下载失败。国内网络可设置 HYDRO_DOWNLOAD_PROXY、HYDRO_CADDY_DOWNLOAD_BASE，或用 --caddy-archive 指定官方离线安装包 ${asset.name}。`);
	} finally { await rm(temporary, { force: true }); }
}

async function installBinary(config) {
	const paths = caddyPaths(config);
	if (config.values.HYDRO_CADDY_BIN) {
		const version = execute(paths.binary, ["version"], config, { quiet: true });
		if (!version.startsWith("v2.")) throw new Error("HYDRO_CADDY_BIN 必须指向 Caddy 2 可执行文件。");
		return;
	}
	const asset = caddyAsset();
	const marker = `${paths.binary}.sha256`;
	if (await stat(paths.binary).catch(() => undefined)) {
		const expected = (await readFile(marker, "utf8").catch(() => "")).trim();
		if (!/^[a-f0-9]{64}$/u.test(expected)) throw new Error(`Caddy 校验文件缺失；请移除 ${paths.binary} 后重新安装。`);
		await verifyArchive(paths.binary, expected);
		return;
	}
	const downloads = join(paths.directory, "downloads");
	await mkdir(downloads, { recursive: true, mode: 0o700 });
	const archive = config.values.HYDRO_CADDY_ARCHIVE
		? resolve(config.root, config.values.HYDRO_CADDY_ARCHIVE)
		: join(downloads, asset.name);
	if (!(await stat(archive).catch(() => undefined))) {
		if (config.values.HYDRO_CADDY_ARCHIVE) throw new Error(`离线 Caddy 包不存在；需要 ${asset.name}。`);
		await download(config, asset, archive);
	}
	await verifyArchive(archive, asset.sha256);
	const temporary = await mkdtemp(join(downloads, "extract-"));
	try {
		const executable = process.platform === "win32" ? "caddy.exe" : "caddy";
		// Extract only the expected executable, from an archive verified against the committed release digest.
		execute("tar", ["-xf", archive, "-C", temporary, executable], config);
		await mkdir(join(paths.directory, "bin", release.version), { recursive: true });
		const staged = join(temporary, executable);
		await chmod(staged, 0o755);
		const hash = createHash("sha256").update(await readFile(staged)).digest("hex");
		await writeFile(marker, `${hash}\n`, { mode: 0o600 });
		await rename(staged, paths.binary);
	} finally { await rm(temporary, { recursive: true, force: true }); }
}

async function canBind(port) {
	return new Promise((accept, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(port, "0.0.0.0", () => server.close(() => accept(true)));
	});
}

async function checkBinding(config) {
	if (process.platform !== "linux") return;
	const threshold = Number(await readFile("/proc/sys/net/ipv4/ip_unprivileged_port_start", "utf8").catch(() => "1024"));
	if (threshold <= 80 || process.getuid?.() === 0) return;
	// Probe another privileged port, since an older managed Caddy may still own 80/443 during upgrades.
	try { await canBind(79); }
	catch (error) {
		if (error.code !== "EACCES") throw error;
		const { binary } = caddyPaths(config);
		const existing = spawnSync("getcap", [binary], { encoding: "utf8" });
		if (/cap_net_bind_service[=+][a-z]*ep/u.test(existing.stdout ?? "")) return;
		if (process.stdin.isTTY) {
			console.log("Caddy 绑定 80/443 需要权限；仅为 Caddy 可执行文件授权，可能需要 sudo 密码。");
			execute("sudo", ["setcap", "cap_net_bind_service=+ep", binary], config);
			return;
		}
		const quoted = `'${binary.replaceAll("'", "'\\''")}'`;
		throw new Error(`Caddy 缺少低端口权限。请运行 sudo setcap cap_net_bind_service=+ep ${quoted}，再重试；无需以 root 运行 Setdraft。`);
	}
}

export async function prepareCaddy(config) {
	if (!config.domain) return;
	const { directory, binary, file } = caddyPaths(config);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
	await installBinary(config);
	await checkBinding(config);
	const temporary = `${file}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, caddyfile(config), { mode: 0o600 });
		execute(binary, ["validate", "--config", temporary, "--adapter", "caddyfile"], config, { quiet: true });
		if (await stat(file).catch(() => undefined)) await copyFile(file, `${file}.previous`);
		await rename(temporary, file);
	} finally { await rm(temporary, { force: true }); }
}
