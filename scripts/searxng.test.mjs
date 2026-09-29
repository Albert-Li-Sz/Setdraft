import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const image = /SETDRAFT_SEARCH_IMAGE:-([^}]+)/u.exec(compose)?.[1];
assert.ok(image);
const available = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5000 }).status === 0;
const headers = { accept: "application/json", "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" };

test("bundled SearXNG enables its fallback engines and starts without bot-detection configuration warnings", { skip: !available, timeout: 45000 }, async (context) => {
 const name = `setdraft-search-test-${randomUUID()}`;
 try {
  await exec("docker", ["run", "--rm", "-d", "--name", name, "-p", "127.0.0.1::8080", "-e", `SEARXNG_SECRET=${randomBytes(32).toString("hex")}`,
   "--mount", `type=bind,source=${fileURLToPath(new URL("../deploy/searxng", import.meta.url))},target=/etc/searxng,readonly`, image], { timeout: 15000 });
  const address = (await exec("docker", ["port", name, "8080/tcp"])).stdout.trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/u);
  let config;
  for (let attempt = 0; attempt < 60; attempt++) {
   try {
    const response = await fetch(`http://${address}/config`, { headers, signal: AbortSignal.timeout(1000) });
    if (response.ok) { config = await response.json(); break; }
   } catch {}
   await setTimeout(250);
  }
  assert.ok(config, "SearXNG did not become ready");
  const enabled = config.engines.filter(engine => engine.enabled).map(engine => engine.name).sort();
  assert.deepEqual(enabled, ["baidu", "bing", "brave", "duckduckgo"]);
  const logs = await exec("docker", ["logs", name]);
  assert.doesNotMatch(logs.stdout + logs.stderr, /missing config file|X-Forwarded-For nor X-Real-IP/u);
  if (process.env.SETDRAFT_LIVE_SEARCH_TEST === "1") {
   const response = await fetch(`http://${address}/search?q=SearXNG%20documentation&format=json&categories=general`, { headers, signal: AbortSignal.timeout(15000) });
   assert.equal(response.status, 200);
   const result = await response.json();
   assert.ok(result.results?.length, "Live search returned no results; check outbound networking and engine availability");
   context.diagnostic(`Live search returned ${result.results.length} results.`);
  }
 } finally {
  await exec("docker", ["rm", "-f", name]).catch(() => {});
 }
});

test("Compose passes the dedicated search proxy only to SearXNG", { skip: !available, timeout: 15000 }, async () => {
 const proxy = "http://proxy.example.org:7890";
 const output = await exec("docker", ["compose", "--env-file", "/dev/null", "-f", fileURLToPath(new URL("../compose.yaml", import.meta.url)), "config", "--format", "json"], {
  env: { ...process.env, SETDRAFT_SEARCH_PROXY: proxy, SETDRAFT_DOWNLOAD_PROXY: "http://downloads.example.org:8080",
   SETDRAFT_DATA_PATH: "/tmp/setdraft-search-config-test", SETDRAFT_DB_ADMIN_PASSWORD: "test-admin-password", SETDRAFT_DB_APP_PASSWORD: "test-app-password", SETDRAFT_SEARCH_SECRET: "test-search-secret" },
  timeout: 10000,
 });
 const services = JSON.parse(output.stdout).services;
 for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
  assert.equal(services.search.environment[key], proxy);
  assert.equal(services.web.environment[key], undefined);
 }
 assert.equal(services.search.environment.NO_PROXY, "localhost,127.0.0.1,::1");
 assert.equal(services.search.ports, undefined);
});

test("the pinned SearXNG network client honors the search proxy environment", { skip: !available, timeout: 20000 }, async () => {
 const name = `setdraft-search-proxy-test-${randomUUID()}`;
 const source = `import asyncio, os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from curl_cffi.requests.exceptions import RequestException
from searx.network.client import new_client
requests = []
class Proxy(BaseHTTPRequestHandler):
    def do_CONNECT(self):
        requests.append(self.path)
        self.send_error(502)
    def log_message(self, *args):
        pass
server = HTTPServer(('127.0.0.1', 0), Proxy)
worker = threading.Thread(target=server.handle_request, daemon=True)
worker.start()
os.environ['https_proxy'] = 'http://127.0.0.1:' + str(server.server_port)
os.environ['NO_PROXY'] = 'localhost,127.0.0.1,::1'
os.environ['no_proxy'] = os.environ['NO_PROXY']
async def check():
    client = new_client(enable_http=False, verify=True, enable_http2=True, enable_http3=False, max_connections=1, proxies={}, local_address=None, max_redirects=0)
    try:
        await client.get('https://proxy-check.invalid/', timeout=3)
    except RequestException:
        pass
    finally:
        await client.aclose()
asyncio.run(check())
worker.join(timeout=1)
server.server_close()
assert requests == ['proxy-check.invalid:443'], requests
`;
 try {
  await exec("docker", ["run", "--rm", "--name", name, "--network", "none", "--entrypoint", "/usr/local/searxng/.venv/bin/python", image, "-c", source], { timeout: 15000 });
 } finally {
  await exec("docker", ["rm", "-f", name]).catch(() => {});
 }
});
