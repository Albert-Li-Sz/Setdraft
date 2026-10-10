import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";
import { composeConfiguration } from "./compose-config.mjs";
import { deploymentEnvironment, loadDeployment, redact, resolveSearchDns } from "./deployment-config.mjs";

test("regeneration replaces broad Compose credential permissions without changing secrets", async () => {
 const root=await mkdtemp(join(tmpdir(),"setdraft-private-config-"));
 try {
  await composeConfiguration(root,[],{});
  const path=join(root,".env.compose"), before=parseEnv(await readFile(path,"utf8"));
  await chmod(path,0o644);
  await composeConfiguration(root,[],{});
  assert.equal((await stat(path)).mode & 0o777,0o600);
  const after=parseEnv(await readFile(path,"utf8"));
  for(const key of ["SETDRAFT_DB_ADMIN_PASSWORD","SETDRAFT_DB_APP_PASSWORD","SETDRAFT_SEARCH_SECRET"]) assert.equal(after[key],before[key]);
 } finally {await rm(root,{recursive:true,force:true});}
});

test("reinstallation cannot silently switch existing storage or database secrets",async()=>{
 const root=await mkdtemp(join(tmpdir(),"setdraft-keep-data-"));
 try{
  await composeConfiguration(root,[],{});
  const before=await readFile(join(root,".env.compose"),"utf8");
  for(const environment of [{SETDRAFT_WORKSPACE_ROOT:"different-data"},{SETDRAFT_DB_ADMIN_PASSWORD:"x".repeat(32)},{SETDRAFT_DB_APP_PASSWORD:"y".repeat(32)}]) {
   await assert.rejects(composeConfiguration(root,["--keep-data"],environment),/不能|不一致/u);
   assert.equal(await readFile(join(root,".env.compose"),"utf8"),before);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test("data roots cannot overlap a source distribution directory", async () => {
 const root=await mkdtemp(join(tmpdir(),"setdraft-data-isolation-"));
 try {
  for(const path of ["docs/private","docs/..private","fixtures/private","LICENSES/private","e2e/private",join(root,"docs/absolute")])
   await assert.rejects(loadDeployment(root,{SETDRAFT_WORKSPACE_ROOT:path}),/数据目录/u);
  assert.equal((await loadDeployment(root,{SETDRAFT_WORKSPACE_ROOT:"private-data"})).dataRoot,join(root,"private-data"));
 } finally {await rm(root,{recursive:true,force:true});}
});

test("OTLP configuration survives native and Compose deployment with headers redacted", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-otel-config-"));
 try {
  const settings = { SETDRAFT_OTEL_ENABLED: "1", OTEL_SERVICE_NAME: "setdraft-test", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318", OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20private-token,tenant=secret", OTEL_EXPORTER_OTLP_TRACES_HEADERS: "api-key=private-key", OTEL_TRACES_SAMPLER_ARG: "0.5" };
  await composeConfiguration(root, [], settings);
  await composeConfiguration(root, [], {});
  const compose = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  const native = deploymentEnvironment(await loadDeployment(root, {}), {});
  for (const [key, value] of Object.entries(settings)) { assert.equal(compose[key], value); assert.equal(native[key], value); }
  const logged = redact('OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20private-token,tenant=secret"\nOTEL_EXPORTER_OTLP_TRACES_HEADERS=api-key=private-key\npostgresql://user:db-secret@localhost/db');
  assert.doesNotMatch(logged, /private-token|tenant=secret|private-key|db-secret/u);
  assert.equal((await loadDeployment(await mkdtemp(join(root, "disabled-")), {})).values.SETDRAFT_OTEL_ENABLED, "0");
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("changes to mounted search settings change the Compose service revision", async () => {
 const root=await mkdtemp(join(tmpdir(),"setdraft-search-revision-"));
 try {
  await mkdir(join(root,"deploy/searxng"),{recursive:true});
  await writeFile(join(root,"deploy/searxng/settings.yml"),"engines: [bing]\n");
  await writeFile(join(root,"deploy/searxng/limiter.toml"),"[botdetection.ip_limit]\n");
  const revision=async()=>{await composeConfiguration(root,[],{});return parseEnv(await readFile(join(root,".env.compose"),"utf8")).SETDRAFT_SEARCH_CONFIG_REVISION;};
  const first=await revision();
  assert.match(first,/^[a-f0-9]{64}$/u);
  assert.equal(await revision(),first);
  await writeFile(join(root,"deploy/searxng/settings.yml"),"engines: [bing, 360search]\n");
  const settings=await revision();
  assert.notEqual(settings,first);
  await writeFile(join(root,"deploy/searxng/limiter.toml"),"[botdetection.ip_limit]\nfilter_link_local=true\n");
  const limiter=await revision();assert.notEqual(limiter,settings);
  await writeFile(join(root,"deploy/searxng/healthcheck.py"),"print('ready')\n");
  const health=await revision();assert.notEqual(health,limiter);
  await mkdir(join(root,"scripts"));
  await writeFile(join(root,"scripts/check-search.mjs"),"console.log('probe');\n");
  const checker=await revision();assert.notEqual(checker,health);
  await composeConfiguration(root,[],{SETDRAFT_SEARCH_DNS_PRIMARY:"10.0.0.53"});
  assert.notEqual(parseEnv(await readFile(join(root,".env.compose"),"utf8")).SETDRAFT_SEARCH_CONFIG_REVISION,checker);
 }finally{await rm(root,{recursive:true,force:true});}
});

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

test("explicit search DNS survives upgrades and rejects container loopback resolvers", async () => {
 const root = await mkdtemp(join(tmpdir(), "setdraft-search-dns-"));
 try {
  const settings = { SETDRAFT_SEARCH_DNS_PRIMARY: "10.0.0.53", SETDRAFT_SEARCH_DNS_SECONDARY: "2001:db8::53" };
  await composeConfiguration(root, [], settings);
  await composeConfiguration(root, ["--keep-data"], {});
  const environment = parseEnv(await readFile(join(root, ".env.compose"), "utf8"));
  for (const [key, value] of Object.entries(settings)) assert.equal(environment[key], value);
  for (const value of ["127.0.0.1", "127.0.0.11", "::1", "0.0.0.0", "::", "dns.example.org", "10.0.0.53:53"])
   await assert.rejects(loadDeployment(root, { SETDRAFT_SEARCH_DNS_PRIMARY: value }), /SETDRAFT_SEARCH_DNS_PRIMARY/u);
 } finally { await rm(root, { recursive: true, force: true }); }
});

test("empty or loopback-only host DNS produces explicit resolver addresses for every network profile", async () => {
 assert.deepEqual(resolveSearchDns({SETDRAFT_NETWORK:"cn"},[]), {SETDRAFT_SEARCH_DNS_PRIMARY:"223.5.5.5",SETDRAFT_SEARCH_DNS_SECONDARY:"223.6.6.6"});
 assert.deepEqual(resolveSearchDns({SETDRAFT_NETWORK:"global"},["127.0.0.53","::1","0:0:0:0:0:0:0:1"]), {SETDRAFT_SEARCH_DNS_PRIMARY:"1.1.1.1",SETDRAFT_SEARCH_DNS_SECONDARY:"1.0.0.1"});
 assert.deepEqual(resolveSearchDns({SETDRAFT_NETWORK:"cn"},["127.0.0.1","10.0.0.53","10.0.0.53"]), {SETDRAFT_SEARCH_DNS_PRIMARY:"10.0.0.53",SETDRAFT_SEARCH_DNS_SECONDARY:"10.0.0.53"});
 const root=await mkdtemp(join(tmpdir(),"setdraft-empty-host-dns-"));
 try {
  await composeConfiguration(root,[],{SETDRAFT_BOOTSTRAP_DNS:"",SETDRAFT_NETWORK:"global"});
  await composeConfiguration(root,["--keep-data"],{SETDRAFT_BOOTSTRAP_DNS:""});
  const saved=parseEnv(await readFile(join(root,".env.compose"),"utf8"));
  assert.equal(saved.SETDRAFT_SEARCH_DNS_PRIMARY,"1.1.1.1");
  assert.equal(saved.SETDRAFT_SEARCH_DNS_SECONDARY,"1.0.0.1");
  await composeConfiguration(root,["--keep-data"],{SETDRAFT_BOOTSTRAP_DNS:"10.0.0.53"});
  const refreshed=parseEnv(await readFile(join(root,".env.compose"),"utf8"));
  assert.equal(refreshed.SETDRAFT_SEARCH_DNS_PRIMARY,"10.0.0.53");
  assert.equal(refreshed.SETDRAFT_SEARCH_DNS_SECONDARY,"10.0.0.53");
  const source=parseEnv(await readFile(join(root,".env"),"utf8"));
  assert.equal(source.SETDRAFT_SEARCH_DNS_PRIMARY,"");
  assert.equal(source.SETDRAFT_SEARCH_DNS_SECONDARY,"");
 } finally {await rm(root,{recursive:true,force:true});}
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


test("rejects workspace symlink aliases into distribution roots and leaves credential symlink targets intact", async () => {
 const root=await mkdtemp(join(tmpdir(),"setdraft-path-alias-"));
 try {
  await mkdir(join(root,"docs/private"),{recursive:true});
  await symlink(join(root,"docs/private"),join(root,"data-alias"));
  await assert.rejects(loadDeployment(root,{SETDRAFT_WORKSPACE_ROOT:"data-alias/missing"}),/数据目录/);
  const target=join(root,"private-secret");await writeFile(target,"protected");await symlink(target,join(root,".env.compose"));
  await assert.rejects(composeConfiguration(root,[],{}),/regular file/);assert.equal(await readFile(target,"utf8"),"protected");
 }finally{await rm(root,{recursive:true,force:true});}
});
