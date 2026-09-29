import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { composeConfiguration } from "./compose-config.mjs";
import { deploymentEnvironment, loadDeployment } from "./deployment-config.mjs";

test("Compose uses a fresh workspace and stable generated database credentials", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-config-"));
 try {
  await mkdir(join(root, ".hydro-problem-make"));
  await writeFile(join(root, ".env"), 'HYDRO_PUBLIC_ORIGIN="http://192.0.2.10:4321"\nHYDRO_NETWORK="global"\nUNRELATED="keep"\n');
  assert.equal((await loadDeployment(root, {})).dataRoot, join(root, ".setdraft"));
  await composeConfiguration(root, ["--host", "127.0.0.1"], {});
  const saved = await readFile(join(root, ".env"), "utf8");
  assert.doesNotMatch(saved, /HYDRO_/u);
  assert.match(saved, /UNRELATED="keep"/u);
  const compose = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(compose.SETDRAFT_DATA_PATH, join(root, ".setdraft"));
  assert.equal(compose.SETDRAFT_PUBLIC_ORIGIN, "http://192.0.2.10:4321");
  assert.equal(compose.SETDRAFT_BIND_ADDRESS, "127.0.0.1");
  assert.equal(compose.SETDRAFT_NPM_REGISTRY, "https://registry.npmjs.org");
  assert.match(compose.SETDRAFT_DB_APP_PASSWORD,/^[a-f0-9]{64}$/u);
  assert.notEqual(compose.SETDRAFT_DB_APP_PASSWORD,compose.SETDRAFT_DB_ADMIN_PASSWORD);
  await composeConfiguration(root,[],{});
  const again=parseEnv(await readFile(join(root,".env.compose"),"utf8"));
  assert.equal(again.SETDRAFT_DB_APP_PASSWORD,compose.SETDRAFT_DB_APP_PASSWORD);
  assert.equal(again.SETDRAFT_DB_ADMIN_PASSWORD,compose.SETDRAFT_DB_ADMIN_PASSWORD);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("explicit Setdraft config wins and mirror choices cover every Docker base image", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-config-"));
 try {
  await composeConfiguration(root, ["--docker-registry", "mirror.example.org", "--public-origin", "https://setdraft.example.org"], { HYDRO_HOST: "127.0.0.1", SETDRAFT_HOST: "0.0.0.0" });
  const env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_BIND_ADDRESS, "0.0.0.0");
  for (const key of ["NODE", "DOCKER_CLI", "PYTHON", "GCC", "POSTGRES"]) assert.match(env[`SETDRAFT_${key}_IMAGE`], /^mirror\.example\.org\/library\//u);
  assert.match(env.SETDRAFT_GCC_IMAGE, /@sha256:/u);
  assert.match(env.SETDRAFT_SEARCH_IMAGE, /^mirror\.example\.org\/searxng\/searxng@sha256:/u);
  await assert.rejects(composeConfiguration(root, ["--https"], {}), /反向代理/u);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleared modern options cannot be restored by legacy process variables", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-config-"));
 try {
  const base = { HYDRO_PUBLIC_ORIGIN: "https://old.example.org" };
  const config = await loadDeployment(root, base, { SETDRAFT_PUBLIC_ORIGIN: "" });
  const env = deploymentEnvironment(config, base);
  assert.equal(env.HYDRO_PUBLIC_ORIGIN, undefined);
  assert.equal(env.SETDRAFT_PUBLIC_ORIGIN, undefined);
  for (const directory of ["packages/private-data", "scripts/workspace", ".git/private"]) {
   await assert.rejects(loadDeployment(root, { SETDRAFT_WORKSPACE_ROOT: directory }), /数据目录/u);
  }
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("search proxy is validated and survives Compose regeneration separately from download proxies", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-search-proxy-"));
 try {
  await composeConfiguration(root, [], { SETDRAFT_SEARCH_PROXY: "http://proxy.example.org:7890", SETDRAFT_DOWNLOAD_PROXY: "http://downloads.example.org:8080" });
  await composeConfiguration(root, [], {});
  const environment = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(environment.SETDRAFT_SEARCH_PROXY, "http://proxy.example.org:7890");
  assert.equal(environment.SETDRAFT_DOWNLOAD_PROXY, "http://downloads.example.org:8080");
  for (const proxy of ["not-a-url", "file:///tmp/proxy", "http://proxy.example.org/path", "http://proxy.example.org#fragment"])
   await assert.rejects(loadDeployment(root, { SETDRAFT_SEARCH_PROXY: proxy }), /SETDRAFT_SEARCH_PROXY/u);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("sandbox scheduling options survive Compose generation and environment loading", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-scheduling-config-"));
 try {
  const limits = {
   SETDRAFT_SANDBOX_CONCURRENCY: "1", SETDRAFT_SANDBOX_MAX_OUTSTANDING: "12", SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER: "3",
   SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS: "60000", SETDRAFT_SANDBOX_RUN_TIMEOUT_MS: "120000", SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS: "180000",
   SETDRAFT_SANDBOX_CONCURRENCY_PER_USER: "4", SETDRAFT_SANDBOX_CPUS: "2", SETDRAFT_SANDBOX_MEMORY_MB: "4096",
   SETDRAFT_AI_CONCURRENCY: "8", SETDRAFT_AI_MAX_OUTSTANDING: "32", SETDRAFT_AI_MAX_OUTSTANDING_PER_USER: "4",
   SETDRAFT_AI_QUEUE_TIMEOUT_MS: "60000", SETDRAFT_AI_RUN_TIMEOUT_MS: "300000",
  };
  await composeConfiguration(root, [], limits);
  const compose = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  const native = deploymentEnvironment(await loadDeployment(root, {}), {});
  for (const [key,value] of Object.entries(limits)) { assert.equal(compose[key], value); assert.equal(native[key], value); }
  await assert.rejects(loadDeployment(root, {SETDRAFT_SANDBOX_CONCURRENCY: "0"}), /正整数/u);
  for (const invalid of [{SETDRAFT_SANDBOX_CONCURRENCY: "65"}, {SETDRAFT_SANDBOX_CPUS: "1.5"}, {SETDRAFT_AI_MAX_OUTSTANDING: "0"}, {SETDRAFT_AI_RUN_TIMEOUT_MS: "86400001"}])
   await assert.rejects(loadDeployment(root, invalid), /需要/u);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("prebuilt images share a release tag and custom registry choices survive regeneration", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-release-config-"));
 try {
  await composeConfiguration(root, [], {});
  let env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_IMAGE_MODE, "prebuilt");
  assert.equal(env.SETDRAFT_WEB_IMAGE, "ghcr.io/albert-li-sz/setdraft:latest");
  assert.equal(env.SETDRAFT_SANDBOX_IMAGE, "ghcr.io/albert-li-sz/setdraft-sandbox:latest");
  assert.equal(env.SETDRAFT_MAINTENANCE_IMAGE, "ghcr.io/albert-li-sz/setdraft-maintenance:latest");
  await composeConfiguration(root, [], {
   SETDRAFT_IMAGE_NAMESPACE: "registry.example.com/team", SETDRAFT_IMAGE_TAG: "1.2.3",
   SETDRAFT_DOCKER_REGISTRY: "hub.example.com",
   SETDRAFT_MAINTENANCE_IMAGE: `registry.example.com/backup@sha256:${"a".repeat(64)}`,
  });
  await composeConfiguration(root, [], {});
  env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_WEB_IMAGE, "registry.example.com/team/setdraft:1.2.3");
  assert.equal(env.SETDRAFT_SANDBOX_IMAGE, "registry.example.com/team/setdraft-sandbox:1.2.3");
  assert.equal(env.SETDRAFT_MAINTENANCE_IMAGE, `registry.example.com/backup@sha256:${"a".repeat(64)}`);
  assert.match(env.SETDRAFT_POSTGRES_IMAGE, /^hub\.example\.com\/library\//u);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("source builds use local tags, persist across upgrades and can switch back to releases", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-source-config-"));
 try {
  await composeConfiguration(root, ["--build"], {});
  await composeConfiguration(root, [], {});
  let env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_IMAGE_MODE, "source");
  for(const component of ["web", "sandbox", "maintenance"]) assert.equal(env[`SETDRAFT_${component.toUpperCase()}_IMAGE`], `setdraft/${component}:local`);
  await composeConfiguration(root, ["--prebuilt"], {});
  env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_IMAGE_MODE, "prebuilt");
  assert.equal(env.SETDRAFT_WEB_IMAGE, "ghcr.io/albert-li-sz/setdraft:latest");
  const before = await readFile(join(root, ".env.compose"), "utf8");
  for(const args of [["--build","--prebuilt"], ["--build","--build"]]) await assert.rejects(composeConfiguration(root,args,{}), /不能重复/u);
  for(const overrides of [
   {SETDRAFT_IMAGE_MODE:"unknown"}, {SETDRAFT_IMAGE_TAG:"bad/tag"},
   {SETDRAFT_IMAGE_NAMESPACE:"https://ghcr.io/albert-li-sz"}, {SETDRAFT_IMAGE_NAMESPACE:"ghcr.io/Team"},
  ]) await assert.rejects(composeConfiguration(root,[],overrides));
  assert.equal(await readFile(join(root,".env.compose"),"utf8"),before);
 } finally { await rm(root, { recursive: true, force: true }); }
});
