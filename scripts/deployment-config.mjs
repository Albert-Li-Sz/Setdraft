import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const fields = [
	"HYDRO_WORKSPACE_ROOT", "HYDRO_HOST", "HYDRO_PUBLIC_ORIGIN",
	"HYDRO_NETWORK", "HYDRO_NPM_REGISTRY", "HYDRO_DOWNLOAD_PROXY",
	"HYDRO_DOCKER_REGISTRY", "HYDRO_DEBIAN_MIRROR",
	"HYDRO_SANDBOX_IMAGE", "HYDRO_TESTCASES_MAX", "HYDRO_TOTAL_TIME_LIMIT_MS",
	"HYDRO_CASE_MAX_BYTES", "HYDRO_PROJECT_MAX_BYTES", "HYDRO_AI_CONFIG_PATH",
];
const retiredFields = ["HYDRO_PROXY_MODE", "HYDRO_ACME_EMAIL", "HYDRO_SSL_CERT", "HYDRO_SSL_KEY", "HYDRO_CADDY_DOWNLOAD_BASE", "HYDRO_CADDY_ARCHIVE", "HYDRO_CADDY_BIN"];
const flags = {
	"--host": "HYDRO_HOST", "--public-origin": "HYDRO_PUBLIC_ORIGIN", "--network": "HYDRO_NETWORK",
	"--download-proxy": "HYDRO_DOWNLOAD_PROXY", "--registry": "HYDRO_NPM_REGISTRY",
	"--docker-registry": "HYDRO_DOCKER_REGISTRY",
};

export function takeDeploymentOptions(args, command) {
	const overrides = {};
	for (let index = 0; index < args.length;) {
		if (["--domain", "--https", "--http", "--ssl-cert", "--ssl-key", "--proxy-mode", "--caddy-archive"].includes(args[index]))
			throw new Error("安装脚本不再管理反向代理或证书；默认监听 0.0.0.0:4321。自建代理请通过 --public-origin 指定浏览器访问来源。");
		const key = Object.hasOwn(flags, args[index]) ? flags[args[index]] : undefined;
		if (!key) { index++; continue; }
		if (!["install", "upgrade", "start"].includes(command) || Object.hasOwn(overrides, key))
			throw new Error("部署参数无效或重复。");
		const value = args[index + 1];
		if (!value || value.startsWith("--")) throw new Error(`${args[index]} 缺少参数值。`);
		overrides[key] = value;
		args.splice(index, 2);
	}
	return overrides;
}

function safeUrl(value, name, { proxy = false } = {}) {
	let url;
	try { url = new URL(value); } catch { throw new Error(`${name} 需要有效的 URL。`); }
	if (!(["https:", ...(proxy ? ["http:"] : [])].includes(url.protocol)) ||
		(!proxy && (url.username || url.password)) || url.hash || url.search || (proxy && url.pathname !== "/"))
		throw new Error(`${name} 需要${proxy ? " HTTP(S) 代理" : "无凭据的 HTTPS"}地址。`);
	return value.replace(/\/$/u, "");
}

function origin(value) {
	if (!value) return "";
	let url;
	try { url = new URL(value); } catch { throw new Error("HYDRO_PUBLIC_ORIGIN 不是有效来源。"); }
	if (url.origin !== value || url.username || url.password ||
		!["http:", "https:"].includes(url.protocol))
		throw new Error("HYDRO_PUBLIC_ORIGIN 需要完整 HTTP(S) 来源，不含路径或末尾斜杠。");
	return value;
}

// Read a dedicated allowlist, never evaluate .env as shell code or import NODE_OPTIONS/PATH from it.
export async function loadDeployment(root, environment = process.env, overrides = {}) {
	const path = join(root, ".env");
	let source = "";
	try { source = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	const saved = parseEnv(source);
	const values = {};
	for (const key of fields) values[key] = overrides[key] ?? environment[key] ?? saved[key] ?? "";
	values.HYDRO_HOST ||= "0.0.0.0";
	if (!["0.0.0.0", "127.0.0.1"].includes(values.HYDRO_HOST)) throw new Error("--host 只能是 0.0.0.0 或 127.0.0.1。");
	const network = values.HYDRO_NETWORK || "cn";
	if (!["cn", "global"].includes(network)) throw new Error("--network 只能是 cn 或 global。");
	values.HYDRO_NETWORK = network;
	// Empty mirror values follow the network profile; explicit choices survive upgrades/profile changes.
	const registry = safeUrl(values.HYDRO_NPM_REGISTRY || (network === "cn" ? "https://registry.npmmirror.com" : "https://registry.npmjs.org"), "HYDRO_NPM_REGISTRY");
	const debianMirror = safeUrl(values.HYDRO_DEBIAN_MIRROR || (network === "cn" ? "https://mirrors.tuna.tsinghua.edu.cn" : "https://deb.debian.org"), "HYDRO_DEBIAN_MIRROR");
	values.HYDRO_PUBLIC_ORIGIN = origin(values.HYDRO_PUBLIC_ORIGIN);
	if (values.HYDRO_DOWNLOAD_PROXY) safeUrl(values.HYDRO_DOWNLOAD_PROXY, "HYDRO_DOWNLOAD_PROXY", { proxy: true });
	if (values.HYDRO_DOCKER_REGISTRY && !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._-]+)*$/u.test(values.HYDRO_DOCKER_REGISTRY))
		throw new Error("HYDRO_DOCKER_REGISTRY 需要仓库主机及可选路径，不含协议、凭据或末尾斜杠。");
	if (environment.PORT && environment.PORT !== "4321") throw new Error("托管服务固定使用 PORT=4321；请取消其他 PORT 设置。");
	for (const key of ["HYDRO_TESTCASES_MAX", "HYDRO_TOTAL_TIME_LIMIT_MS", "HYDRO_CASE_MAX_BYTES", "HYDRO_PROJECT_MAX_BYTES"]) {
		if (values[key] && (!/^\d+$/u.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1))
			throw new Error(`${key} 需要正整数。`);
	}
	for (const [key, value] of Object.entries(values)) {
		if (/[\r\n\0]/u.test(value) || (value.includes('"') && value.includes("'"))) throw new Error(`${key} 含不支持的字符。`);
	}
	const dataRoot = resolve(root, values.HYDRO_WORKSPACE_ROOT || ".hydro-problem-make");
	const toRoot = relative(dataRoot, root);
	if (!toRoot || (!toRoot.startsWith("..") && !isAbsolute(toRoot))) throw new Error("工作区不能是仓库根目录或其父目录。");
	return { path, source, values, registry, debianMirror, dataRoot, root };
}

export function deploymentEnvironment(config, base = process.env) {
	const environment = { ...base };
	for (const key of retiredFields) delete environment[key];
	for (const [key, value] of Object.entries(config.values)) {
		if (value) environment[key] = value;
		else delete environment[key];
	}
	environment.HYDRO_WORKSPACE_ROOT = config.dataRoot;
	environment.HYDRO_DEBIAN_MIRROR = config.debianMirror;
	return environment;
}

export function networkEnvironment(config, base = process.env) {
	const environment = { ...base };
	if (config.values.HYDRO_DOWNLOAD_PROXY) {
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
			environment[key] = config.values.HYDRO_DOWNLOAD_PROXY;
	}
	const exclusions = ["127.0.0.1", "localhost", "::1", base.NO_PROXY, base.no_proxy].filter(Boolean).join(",");
	environment.NO_PROXY = exclusions;
	environment.no_proxy = exclusions;
	return environment;
}

export async function saveDeployment(config) {
	let source = config.source;
	for (const key of retiredFields) source = source.replace(new RegExp(`^(?:export\\s+)?${key}\\s*=.*(?:\\n|$)`, "gmu"), "");
	// Replace only known keys, preserving unrelated variables and comments.
	for (const key of fields) {
		const value = config.values[key];
		const quote = value.includes('"') ? "'" : '"';
		const line = `${key}=${quote}${value}${quote}`;
		const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gmu");
		if (pattern.test(source)) source = source.replace(pattern, () => line);
		else source += `${source.endsWith("\n") || !source ? "" : "\n"}${line}\n`;
	}
	const temporary = `${config.path}.${process.pid}.tmp`;
	await writeFile(temporary, source, { mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, config.path);
	config.source = source;
}

export function redact(value) {
	return String(value).replace(/(https?:\/\/)[^\s/@]+@/gu, "$1***@");
}
