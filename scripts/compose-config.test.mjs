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

test("sandbox scheduling options survive Compose generation and environment loading", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-scheduling-config-"));
 try {
  const limits = {
   SETDRAFT_SANDBOX_CONCURRENCY: "1", SETDRAFT_SANDBOX_MAX_OUTSTANDING: "12", SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER: "3",
   SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS: "60000", SETDRAFT_SANDBOX_RUN_TIMEOUT_MS: "120000", SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS: "180000",
  };
  await composeConfiguration(root, [], limits);
  const compose = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  const native = deploymentEnvironment(await loadDeployment(root, {}), {});
  for (const [key,value] of Object.entries(limits)) { assert.equal(compose[key], value); assert.equal(native[key], value); }
  await assert.rejects(loadDeployment(root, {SETDRAFT_SANDBOX_CONCURRENCY: "0"}), /正整数/u);
 } finally { await rm(root, { recursive: true, force: true }); }
});
