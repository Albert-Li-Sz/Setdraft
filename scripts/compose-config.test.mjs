import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { composeConfiguration } from "./compose-config.mjs";
import { deploymentEnvironment, loadDeployment } from "./deployment-config.mjs";

test("Compose migration preserves old workspace ownership and uses new configuration names", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-config-"));
 try {
  await mkdir(join(root, ".hydro-problem-make"));
  await writeFile(join(root, ".env"), 'HYDRO_PUBLIC_ORIGIN="http://192.0.2.10:4321"\nHYDRO_NETWORK="global"\nUNRELATED="keep"\n');
  assert.equal((await loadDeployment(root, {})).dataRoot, join(root, ".hydro-problem-make"));
  await composeConfiguration(root, ["--host", "127.0.0.1"], {});
  const saved = await readFile(join(root, ".env"), "utf8");
  assert.doesNotMatch(saved, /HYDRO_/u);
  assert.match(saved, /UNRELATED="keep"/u);
  const compose = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(compose.SETDRAFT_DATA_PATH, join(root, ".hydro-problem-make"));
  assert.equal(compose.SETDRAFT_PUBLIC_ORIGIN, "http://192.0.2.10:4321");
  assert.equal(compose.SETDRAFT_BIND_ADDRESS, "127.0.0.1");
  assert.equal(compose.SETDRAFT_NPM_REGISTRY, "https://registry.npmjs.org");
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("explicit Setdraft config wins and mirror choices cover every Docker base image", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-config-"));
 try {
  await composeConfiguration(root, ["--docker-registry", "mirror.example.org", "--public-origin", "https://setdraft.example.org"], { HYDRO_HOST: "127.0.0.1", SETDRAFT_HOST: "0.0.0.0" });
  const env = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  assert.equal(env.SETDRAFT_BIND_ADDRESS, "0.0.0.0");
  for (const key of ["NODE", "DOCKER_CLI", "PYTHON", "GCC"]) assert.match(env[`SETDRAFT_${key}_IMAGE`], /^mirror\.example\.org\/library\//u);
  assert.match(env.SETDRAFT_GCC_IMAGE, /@sha256:/u);
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
