import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDeployment, saveDeployment, takeDeploymentOptions } from "./deployment-config.mjs";

export async function composeConfiguration(root, args, environment = process.env) {
	const remaining = [...args];
	const overrides = takeDeploymentOptions(remaining, "install");
	for (let i = 0; i < remaining.length;) {
		if (!["--build", "--prebuilt"].includes(remaining[i])) { i++; continue; }
		if (overrides.SETDRAFT_IMAGE_MODE) throw new Error("--build / --prebuilt 不能重复或同时使用。");
		overrides.SETDRAFT_IMAGE_MODE = remaining[i] === "--build" ? "source" : "prebuilt";
		remaining.splice(i, 1);
	}
	if (remaining.length) throw new Error(`未知部署参数：${remaining.join(" ")}`);
	const config = await loadDeployment(root, environment, overrides);
	if (config.values.SETDRAFT_AI_CONFIG_PATH) throw new Error("Docker 部署请将旧 AI 配置复制到数据目录的 ai-config.json，并清空 SETDRAFT_AI_CONFIG_PATH；已初始化的团队配置保存在身份库中。");
	const prefix = config.values.SETDRAFT_DOCKER_REGISTRY ? `${config.values.SETDRAFT_DOCKER_REGISTRY}/library/` : "";
	const port = config.values.SETDRAFT_PORT || "4321";
	if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("SETDRAFT_PORT 需要 1–65535。");
	config.values.SETDRAFT_WORKSPACE_ROOT = config.dataRoot;
	config.values.SETDRAFT_PORT = port;
	const previous=parseEnv(await readFile(join(root,".env.compose"),"utf8").catch(()=>""));
 const secret=key=>environment[key] || previous[key] || randomBytes(32).toString("hex");
 const namespace = config.values.SETDRAFT_IMAGE_NAMESPACE || "ghcr.io/albert-li-sz";
	const tag = config.values.SETDRAFT_IMAGE_TAG || "latest";
	const image = (name, local) => config.values.SETDRAFT_IMAGE_MODE === "source" ? `setdraft/${local}:local` : `${namespace}/${name}:${tag}`;
	const searchRevision = createHash("sha256");
	for (const name of ["settings.yml", "limiter.toml"]) {
		const bytes = await readFile(join(root, "deploy/searxng", name)).catch((error) => {
			if (error.code !== "ENOENT") throw error;
			return Buffer.from("missing");
		});
		searchRevision.update(name).update("\0").update(bytes).update("\0");
	}
	const values = {
		...config.values,
		SETDRAFT_SEARCH_CONFIG_REVISION: searchRevision.digest("hex"),
		SETDRAFT_WEB_IMAGE: config.values.SETDRAFT_WEB_IMAGE || image("setdraft", "web"),
		SETDRAFT_SANDBOX_IMAGE: config.values.SETDRAFT_SANDBOX_IMAGE || image("setdraft-sandbox", "sandbox"),
		SETDRAFT_MAINTENANCE_IMAGE: config.values.SETDRAFT_MAINTENANCE_IMAGE || image("setdraft-maintenance", "maintenance"),
        SETDRAFT_DB_ADMIN_PASSWORD: secret("SETDRAFT_DB_ADMIN_PASSWORD"),
        SETDRAFT_DB_APP_PASSWORD: secret("SETDRAFT_DB_APP_PASSWORD"),
        SETDRAFT_SEARCH_SECRET: secret("SETDRAFT_SEARCH_SECRET"),
        SETDRAFT_POSTGRES_IMAGE: config.values.SETDRAFT_POSTGRES_IMAGE || `${prefix}postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650`,
        SETDRAFT_SEARCH_IMAGE: config.values.SETDRAFT_SEARCH_IMAGE || `${config.values.SETDRAFT_DOCKER_REGISTRY ? `${config.values.SETDRAFT_DOCKER_REGISTRY}/` : ""}searxng/searxng@sha256:5286edb35782454ab8a102c5eff6b54bff745853191b46aeead95f225aa6dfb6`,
		SETDRAFT_DATA_PATH: config.dataRoot,
		SETDRAFT_BIND_ADDRESS: config.values.SETDRAFT_HOST,
		SETDRAFT_PORT: port,
		SETDRAFT_NPM_REGISTRY: config.registry,
		SETDRAFT_DEBIAN_MIRROR: config.debianMirror,
		SETDRAFT_NODE_IMAGE: environment.SETDRAFT_NODE_IMAGE || `${prefix}node:24.18.0-bookworm-slim`,
		SETDRAFT_DOCKER_CLI_IMAGE: environment.SETDRAFT_DOCKER_CLI_IMAGE || `${prefix}docker:29-cli`,
		SETDRAFT_PYTHON_IMAGE: `${prefix}python:3.14-slim-trixie`,
		SETDRAFT_GCC_IMAGE: `${prefix}gcc:16.2.0-trixie@sha256:28365a1efe31883fd29f9fce27811b731e815f9f9b2db16b0e1f0d99fcb3dae5`,
	};
	for(const key of ["SETDRAFT_DB_ADMIN_PASSWORD","SETDRAFT_DB_APP_PASSWORD","SETDRAFT_SEARCH_SECRET"]) if(!/^[a-zA-Z0-9_-]{24,128}$/u.test(values[key]))throw new Error(`${key} 必须是 24–128 位字母、数字、下划线或短横线。`);
 for (const value of Object.values(values)) if (/[\r\n\0']/u.test(value)) throw new Error("Compose 配置不能包含单引号或换行。");
	await saveDeployment(config);
	await writeFile(join(root, ".env.compose"), Object.entries(values).map(([key, value]) => `${key}='${value}'\n`).join(""), { mode: 0o600 });
	console.log(`Setdraft 数据目录：${config.dataRoot}\nWeb：${values.SETDRAFT_BIND_ADDRESS}:${port}（反向代理自行配置）`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await composeConfiguration(resolve(fileURLToPath(new URL("..", import.meta.url))), process.argv.slice(2)).catch((error) => {
		console.error(error.message); process.exitCode = 1;
	});
}
