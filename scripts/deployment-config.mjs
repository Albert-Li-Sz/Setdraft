import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const fields = [
	"HYDRO_WORKSPACE_ROOT", "HYDRO_PUBLIC_ORIGIN", "HYDRO_PROXY_MODE", "HYDRO_SSL_CERT", "HYDRO_SSL_KEY",
	"HYDRO_NETWORK", "HYDRO_NPM_REGISTRY", "HYDRO_DOWNLOAD_PROXY", "HYDRO_CADDY_DOWNLOAD_BASE",
	"HYDRO_CADDY_ARCHIVE", "HYDRO_CADDY_BIN", "HYDRO_DOCKER_REGISTRY", "HYDRO_DEBIAN_MIRROR",
	"HYDRO_SANDBOX_IMAGE", "HYDRO_TESTCASES_MAX", "HYDRO_TOTAL_TIME_LIMIT_MS",
	"HYDRO_CASE_MAX_BYTES", "HYDRO_PROJECT_MAX_BYTES", "HYDRO_AI_CONFIG_PATH",
];
const flags = {
	"--domain": "domain", "--ssl-cert": "HYDRO_SSL_CERT", "--ssl-key": "HYDRO_SSL_KEY", "--network": "HYDRO_NETWORK",
	"--proxy-mode": "HYDRO_PROXY_MODE", "--download-proxy": "HYDRO_DOWNLOAD_PROXY",
	"--registry": "HYDRO_NPM_REGISTRY", "--docker-registry": "HYDRO_DOCKER_REGISTRY",
	"--caddy-archive": "HYDRO_CADDY_ARCHIVE",
};

export function takeDeploymentOptions(args, command) {
	const overrides = {};
	for (let index = 0; index < args.length;) {
		if (["--https", "--http"].includes(args[index])) {
			if (!["install", "upgrade", "start"].includes(command) || Object.hasOwn(overrides, "https"))
				throw new Error("--http 和 --https 不能重复或同时指定。");
			overrides.https = args[index] === "--https";
			args.splice(index, 1);
			continue;
		}
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

function siteHost(value) {
	const ip = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
	const version = isIP(ip);
	if (version && !ip.includes("%") && (version === 6 || ip === value)) {
		const hostname = new URL(`http://${version === 6 ? `[${ip}]` : ip}`).hostname;
		if (["0.0.0.0", "[::]", "255.255.255.255"].includes(hostname)) throw new Error("请填写服务器的访问 IP，不能使用未指定或广播地址。");
		return hostname;
	}
	const domain = value.toLowerCase();
	if (domain.length > 253 || !domain.includes(".") || /^\d+$/u.test(domain.split(".").at(-1)) ||
		!domain.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)) ||
		/\.(localhost|local|internal|test|invalid)$/u.test(domain))
		throw new Error("--domain 需要域名或有效 IPv4 / IPv6 地址，不含协议、端口或路径；国际域名请使用 Punycode。");
	return domain;
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
	if (overrides.domain) {
		values.HYDRO_PUBLIC_ORIGIN = `http://${siteHost(overrides.domain)}`;
		values.HYDRO_PROXY_MODE = overrides.HYDRO_PROXY_MODE ?? "caddy";
	}
	if (overrides.https !== undefined) {
		if (!values.HYDRO_PUBLIC_ORIGIN) throw new Error("请先使用 --domain 指定域名或 IP。");
		const url = new URL(origin(values.HYDRO_PUBLIC_ORIGIN));
		url.protocol = overrides.https ? "https:" : "http:";
		values.HYDRO_PUBLIC_ORIGIN = url.origin;
	}
	const network = values.HYDRO_NETWORK || "cn";
	if (!["cn", "global"].includes(network)) throw new Error("--network 只能是 cn 或 global。");
	values.HYDRO_NETWORK = network;
	// Empty mirror values follow the network profile; explicit choices survive upgrades/profile changes.
	const registry = safeUrl(values.HYDRO_NPM_REGISTRY || (network === "cn" ? "https://registry.npmmirror.com" : "https://registry.npmjs.org"), "HYDRO_NPM_REGISTRY");
	const debianMirror = safeUrl(values.HYDRO_DEBIAN_MIRROR || (network === "cn" ? "https://mirrors.tuna.tsinghua.edu.cn" : "https://deb.debian.org"), "HYDRO_DEBIAN_MIRROR");
	values.HYDRO_PUBLIC_ORIGIN = origin(values.HYDRO_PUBLIC_ORIGIN);
	values.HYDRO_PROXY_MODE ||= values.HYDRO_PUBLIC_ORIGIN ? "external" : "off";
	if (!["off", "external", "caddy"].includes(values.HYDRO_PROXY_MODE)) throw new Error("--proxy-mode 只能是 off、external 或 caddy。");
	if (values.HYDRO_PROXY_MODE === "off" && values.HYDRO_PUBLIC_ORIGIN &&
		!(["127.0.0.1", "localhost", "[::1]"].includes(new URL(values.HYDRO_PUBLIC_ORIGIN).hostname) && values.HYDRO_PUBLIC_ORIGIN.startsWith("http://")))
		throw new Error("公开站点需要 caddy 或 external 代理模式；本机模式请清空 HYDRO_PUBLIC_ORIGIN。");
	if (values.HYDRO_PROXY_MODE === "external" && !values.HYDRO_PUBLIC_ORIGIN)
		throw new Error("external 模式需要设置 HYDRO_PUBLIC_ORIGIN=http://域名或IP，或实际使用的 HTTPS 来源。");
	let domain;
	const https = values.HYDRO_PUBLIC_ORIGIN.startsWith("https://");
	if (values.HYDRO_PROXY_MODE === "caddy") {
		if (!values.HYDRO_PUBLIC_ORIGIN) throw new Error("Caddy 模式需要 --domain 或 HYDRO_PUBLIC_ORIGIN。");
		const url = new URL(values.HYDRO_PUBLIC_ORIGIN);
		domain = siteHost(url.hostname);
		if (url.port) throw new Error("托管 Caddy 使用标准 80/443 端口，来源不能包含自定义端口。");
		if (https) {
			if (isIP(domain.replace(/^\[|\]$/gu, ""))) throw new Error("IP 部署使用 HTTP；--https 用于域名并需要提供 SSL 证书和私钥。");
			if (!values.HYDRO_SSL_CERT || !values.HYDRO_SSL_KEY) throw new Error("开启 HTTPS 需要提供 --ssl-cert 证书链文件和 --ssl-key 私钥文件；默认使用 HTTP。");
		}
	}
	if (values.HYDRO_DOWNLOAD_PROXY) safeUrl(values.HYDRO_DOWNLOAD_PROXY, "HYDRO_DOWNLOAD_PROXY", { proxy: true });
	if (values.HYDRO_CADDY_DOWNLOAD_BASE) safeUrl(values.HYDRO_CADDY_DOWNLOAD_BASE, "HYDRO_CADDY_DOWNLOAD_BASE");
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
	const tls = domain && https ? {
		certificate: join(dataRoot, "deployment", "tls", "fullchain.pem"),
		privateKey: join(dataRoot, "deployment", "tls", "privkey.pem"),
	} : undefined;
	return { path, source, values, registry, debianMirror, domain, https, tls, ports: https ? [80, 443] : [80], dataRoot, root };
}

export function deploymentEnvironment(config, base = process.env) {
	const environment = { ...base };
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

export function caddyfile(config) {
	if (!config.domain) throw new Error("未配置托管 Caddy 的域名或 IP。");
	const tls = config.tls ? `\ttls ${JSON.stringify(config.tls.certificate)} ${JSON.stringify(config.tls.privateKey)}\n` : "";
	return `# Managed by Setdraft. Edit .env, then run hydro-local.mjs start.\n{\n\tadmin off\n\tauto_https disable_certs\n}\n\n${config.values.HYDRO_PUBLIC_ORIGIN} {\n${tls}\treverse_proxy 127.0.0.1:4321 {\n\t\theader_up Host {hostport}\n\t\theader_up X-Forwarded-For {remote_host}\n\t\tflush_interval -1\n\t}\n}\n\n# Local readiness checks do not prove public reachability.\nhttp://127.0.0.1:4322 {\n\tbind 127.0.0.1\n\thandle /api/health {\n\t\treverse_proxy 127.0.0.1:4321 {\n\t\t\theader_up Host {upstream_hostport}\n\t\t}\n\t}\n\thandle {\n\t\trespond 404\n\t}\n}\n`;
}
