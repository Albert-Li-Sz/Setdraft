import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

import { canonicalPath, containsPath } from "./data-path.mjs";
import { writePrivateFile } from "./private-file.mjs";

const sourceDirectories = ["packages", "scripts", "deploy", "docs", "fixtures", "LICENSES", "e2e", ".github", ".husky"];

const fields = [
	"SETDRAFT_IMAGE_MODE", "SETDRAFT_IMAGE_NAMESPACE", "SETDRAFT_IMAGE_TAG", "SETDRAFT_WEB_IMAGE", "SETDRAFT_MAINTENANCE_IMAGE",
	"SETDRAFT_DATABASE_URL", "SETDRAFT_DATABASE_ADMIN_URL", "SETDRAFT_SEARCH_URL", "SETDRAFT_SEARCH_IMAGE", "SETDRAFT_SEARCH_PROXY", "SETDRAFT_POSTGRES_IMAGE", "SETDRAFT_WORKSPACE_ROOT", "SETDRAFT_HOST", "SETDRAFT_PORT", "SETDRAFT_PUBLIC_ORIGIN",
	"SETDRAFT_SEARCH_DNS_PRIMARY", "SETDRAFT_SEARCH_DNS_SECONDARY",
	"SETDRAFT_NETWORK", "SETDRAFT_NPM_REGISTRY", "SETDRAFT_DOWNLOAD_PROXY",
	"SETDRAFT_DOCKER_REGISTRY", "SETDRAFT_DEBIAN_MIRROR",
	"SETDRAFT_SANDBOX_IMAGE", "SETDRAFT_TESTCASES_MAX", "SETDRAFT_TOTAL_TIME_LIMIT_MS",
	"SETDRAFT_CASE_MAX_BYTES", "SETDRAFT_PROJECT_MAX_BYTES", "SETDRAFT_AI_CONFIG_PATH",
	"SETDRAFT_SANDBOX_CONCURRENCY", "SETDRAFT_SANDBOX_MAX_OUTSTANDING", "SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER",
	"SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS", "SETDRAFT_SANDBOX_RUN_TIMEOUT_MS", "SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS",
	"SETDRAFT_SANDBOX_CONCURRENCY_PER_USER", "SETDRAFT_SANDBOX_CPUS", "SETDRAFT_SANDBOX_MEMORY_MB",
	"SETDRAFT_AI_CONCURRENCY", "SETDRAFT_AI_MAX_OUTSTANDING", "SETDRAFT_AI_MAX_OUTSTANDING_PER_USER",
	"SETDRAFT_AI_QUEUE_TIMEOUT_MS", "SETDRAFT_AI_RUN_TIMEOUT_MS",
	"SETDRAFT_OTEL_ENABLED", "OTEL_SERVICE_NAME", "OTEL_TRACES_SAMPLER", "OTEL_TRACES_SAMPLER_ARG",
	"OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
	"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_METRICS_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
];
const retiredFields = ["SETDRAFT_PROXY_MODE", "SETDRAFT_ACME_EMAIL", "SETDRAFT_SSL_CERT", "SETDRAFT_SSL_KEY", "SETDRAFT_CADDY_DOWNLOAD_BASE", "SETDRAFT_CADDY_ARCHIVE", "SETDRAFT_CADDY_BIN"];
const flags = {
	"--host": "SETDRAFT_HOST", "--public-origin": "SETDRAFT_PUBLIC_ORIGIN", "--network": "SETDRAFT_NETWORK",
	"--download-proxy": "SETDRAFT_DOWNLOAD_PROXY", "--registry": "SETDRAFT_NPM_REGISTRY",
	"--docker-registry": "SETDRAFT_DOCKER_REGISTRY",
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
	try { url = new URL(value); } catch { throw new Error("SETDRAFT_PUBLIC_ORIGIN 不是有效来源。"); }
	if (url.origin !== value || url.username || url.password ||
		!["http:", "https:"].includes(url.protocol))
		throw new Error("SETDRAFT_PUBLIC_ORIGIN 需要完整 HTTP(S) 来源，不含路径或末尾斜杠。");
	return value;
}

function searchDnsAddress(value) {
	if (typeof value !== "string" || !isIP(value) || value.includes("%")) return false;
	const normalized = isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
	return !/^(?:127\.|0\.0\.0\.0$|255\.255\.255\.255$|::(?:1)?$|::ffff:(?:7f[0-9a-f]{2}:|0:0$))/u.test(normalized);
}

// Persist concrete upstreams so Docker never snapshots an empty DHCP resolver at boot.
export function resolveSearchDns(values, servers, previous = {}) {
	let available = [...new Set(servers.filter(searchDnsAddress))];
	if (!available.length) available = [...new Set([previous.SETDRAFT_SEARCH_DNS_PRIMARY, previous.SETDRAFT_SEARCH_DNS_SECONDARY].filter(searchDnsAddress))];
	const defaults = values.SETDRAFT_NETWORK === "global" ? ["1.1.1.1", "1.0.0.1"] : ["223.5.5.5", "223.6.6.6"];
	const primary = values.SETDRAFT_SEARCH_DNS_PRIMARY || available[0] || defaults[0];
	const secondary = values.SETDRAFT_SEARCH_DNS_SECONDARY || (values.SETDRAFT_SEARCH_DNS_PRIMARY ? primary : available[1] || available[0] || defaults[1]);
	return { SETDRAFT_SEARCH_DNS_PRIMARY: primary, SETDRAFT_SEARCH_DNS_SECONDARY: secondary };
}

// Read a dedicated allowlist, never evaluate .env as shell code or import NODE_OPTIONS/PATH from it.
export async function loadDeployment(root, environment = process.env, overrides = {}) {
	const path = join(root, ".env");
	let source = "";
	try { source = await readFile(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	const saved = parseEnv(source);
	const values = {};
	for (const key of fields) {
		const legacy = key.replace(/^SETDRAFT_/u, "HYDRO_");
		values[key] = overrides[key] ?? environment[key] ?? environment[legacy] ?? saved[key] ?? saved[legacy] ?? "";
	}
	values.SETDRAFT_IMAGE_MODE ||= "prebuilt";
	values.SETDRAFT_OTEL_ENABLED ||= "0";
	if (!["prebuilt", "source"].includes(values.SETDRAFT_IMAGE_MODE)) throw new Error("SETDRAFT_IMAGE_MODE 需要 prebuilt 或 source。");
	if (values.SETDRAFT_IMAGE_TAG && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/u.test(values.SETDRAFT_IMAGE_TAG))
		throw new Error("SETDRAFT_IMAGE_TAG 不是有效的镜像标签。");
	if (values.SETDRAFT_IMAGE_NAMESPACE && !/^[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u.test(values.SETDRAFT_IMAGE_NAMESPACE))
		throw new Error("SETDRAFT_IMAGE_NAMESPACE 需要小写的仓库主机/命名空间，不含协议或末尾斜杠。");
	values.SETDRAFT_HOST ||= "0.0.0.0";
	if (!["0.0.0.0", "127.0.0.1"].includes(values.SETDRAFT_HOST)) throw new Error("--host 只能是 0.0.0.0 或 127.0.0.1。");
	const network = values.SETDRAFT_NETWORK || "cn";
	if (!["cn", "global"].includes(network)) throw new Error("--network 只能是 cn 或 global。");
	values.SETDRAFT_NETWORK = network;
	// Empty mirror values follow the network profile; explicit choices survive upgrades/profile changes.
	const registry = safeUrl(values.SETDRAFT_NPM_REGISTRY || (network === "cn" ? "https://registry.npmmirror.com" : "https://registry.npmjs.org"), "SETDRAFT_NPM_REGISTRY");
	const debianMirror = safeUrl(values.SETDRAFT_DEBIAN_MIRROR || (network === "cn" ? "https://mirrors.tuna.tsinghua.edu.cn" : "https://deb.debian.org"), "SETDRAFT_DEBIAN_MIRROR");
	values.SETDRAFT_PUBLIC_ORIGIN = origin(values.SETDRAFT_PUBLIC_ORIGIN);
	if (values.SETDRAFT_DOWNLOAD_PROXY) safeUrl(values.SETDRAFT_DOWNLOAD_PROXY, "SETDRAFT_DOWNLOAD_PROXY", { proxy: true });
	if (values.SETDRAFT_SEARCH_PROXY) safeUrl(values.SETDRAFT_SEARCH_PROXY, "SETDRAFT_SEARCH_PROXY", { proxy: true });
	for (const key of ["SETDRAFT_SEARCH_DNS_PRIMARY", "SETDRAFT_SEARCH_DNS_SECONDARY"])
		if (values[key] && !searchDnsAddress(values[key])) throw new Error(`${key} 需要容器可访问的 DNS IP 地址，不能使用回环或未指定地址。`);
	if (values.SETDRAFT_DOCKER_REGISTRY && !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-zA-Z0-9._-]+)*$/u.test(values.SETDRAFT_DOCKER_REGISTRY))
		throw new Error("SETDRAFT_DOCKER_REGISTRY 需要仓库主机及可选路径，不含协议、凭据或末尾斜杠。");
	if (environment.PORT && environment.PORT !== "4321") throw new Error("托管服务固定使用 PORT=4321；请取消其他 PORT 设置。");
	for (const key of ["SETDRAFT_TESTCASES_MAX", "SETDRAFT_TOTAL_TIME_LIMIT_MS", "SETDRAFT_CASE_MAX_BYTES", "SETDRAFT_PROJECT_MAX_BYTES", "SETDRAFT_SANDBOX_CONCURRENCY", "SETDRAFT_SANDBOX_MAX_OUTSTANDING", "SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER", "SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS", "SETDRAFT_SANDBOX_RUN_TIMEOUT_MS", "SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS"]) {
		if (values[key] && (!/^\d+$/u.test(values[key]) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < 1))
			throw new Error(`${key} 需要正整数。`);
	}
	for (const [key, value] of Object.entries(values)) {
		const max = {
			SETDRAFT_SANDBOX_CONCURRENCY: 64, SETDRAFT_SANDBOX_CONCURRENCY_PER_USER: 64,
			SETDRAFT_SANDBOX_CPUS: 64, SETDRAFT_SANDBOX_MEMORY_MB: 131072,
			SETDRAFT_SANDBOX_MAX_OUTSTANDING: 1024, SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER: 128,
			SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS: 86400000, SETDRAFT_SANDBOX_RUN_TIMEOUT_MS: 86400000, SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS: 86400000,
			SETDRAFT_AI_CONCURRENCY: 64, SETDRAFT_AI_MAX_OUTSTANDING: 1024, SETDRAFT_AI_MAX_OUTSTANDING_PER_USER: 128,
			SETDRAFT_AI_QUEUE_TIMEOUT_MS: 86400000, SETDRAFT_AI_RUN_TIMEOUT_MS: 86400000,
		}[key];
		const min = key === "SETDRAFT_SANDBOX_MEMORY_MB" ? 512 : 1;
		if (value && max && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max))
			throw new Error(`${key} 需要 ${min}–${max} 的整数。`);
		if (/[\r\n\0]/u.test(value) || (value.includes('"') && value.includes("'"))) throw new Error(`${key} 含不支持的字符。`);
	}
	const dataRoot = resolve(root, values.SETDRAFT_WORKSPACE_ROOT || ".setdraft");
	const physicalRoot = await canonicalPath(root);
	const physicalData = await canonicalPath(dataRoot);
	if (containsPath(dataRoot, root) || containsPath(physicalData, physicalRoot)) throw new Error("工作区不能是仓库根目录或其父目录。");
	for (const directory of [...sourceDirectories, "node_modules", ".git"]) {
		if (containsPath(join(root, directory), dataRoot) || containsPath(await canonicalPath(join(root, directory)), physicalData)) throw new Error("数据目录不能放在源代码、部署脚本或依赖目录中。");
	}
	return { path, source, values, registry, debianMirror, dataRoot, root };
}

export function deploymentEnvironment(config, base = process.env) {
	const environment = { ...base };
	for (const key of [...fields, ...retiredFields].filter(key => key.startsWith("SETDRAFT_"))) delete environment[key.replace(/^SETDRAFT_/u, "HYDRO_")];
	for (const key of retiredFields) delete environment[key];
	for (const [key, value] of Object.entries(config.values)) {
		if (value) environment[key] = value;
		else delete environment[key];
	}
	environment.SETDRAFT_WORKSPACE_ROOT = config.dataRoot;
	environment.SETDRAFT_DEBIAN_MIRROR = config.debianMirror;
	return environment;
}

export function networkEnvironment(config, base = process.env) {
	const environment = { ...base };
	if (config.values.SETDRAFT_DOWNLOAD_PROXY) {
		for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"])
			environment[key] = config.values.SETDRAFT_DOWNLOAD_PROXY;
	}
	const exclusions = ["127.0.0.1", "localhost", "::1", base.NO_PROXY, base.no_proxy].filter(Boolean).join(",");
	environment.NO_PROXY = exclusions;
	environment.no_proxy = exclusions;
	return environment;
}

export async function saveDeployment(config) {
	let source = config.source;
	for (const key of [...retiredFields, ...[...fields, ...retiredFields].filter(field => field.startsWith("SETDRAFT_")).map((field) => field.replace(/^SETDRAFT_/u, "HYDRO_"))]) source = source.replace(new RegExp(`^(?:export\\s+)?${key}\\s*=.*(?:\\n|$)`, "gmu"), "");
	// Replace only known keys, preserving unrelated variables and comments.
	for (const key of fields) {
		const value = config.values[key];
		const quote = value.includes('"') ? "'" : '"';
		const line = `${key}=${quote}${value}${quote}`;
		const pattern = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, "gmu");
		if (pattern.test(source)) source = source.replace(pattern, () => line);
		else source += `${source.endsWith("\n") || !source ? "" : "\n"}${line}\n`;
	}
	await writePrivateFile(config.path, source);
	config.source = source;
}

export function redact(value) {
	return String(value)
		.replace(/((?:https?|postgresql):\/\/)[^\s/@]+@/gu, "$1***@")
		.replace(/(OTEL_EXPORTER_OTLP(?:_TRACES|_METRICS)?_HEADERS\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gu, "$1[redacted]");
}
