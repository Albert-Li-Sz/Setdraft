import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import test from "node:test";
import { checkSearch } from "./check-search.mjs";

const exec = promisify(execFile);
const compose = await readFile(new URL("../compose.yaml", import.meta.url), "utf8");
const image = /SETDRAFT_SEARCH_IMAGE:-([^}]+)/u.exec(compose)?.[1];
assert.ok(image);
const available = spawnSync("docker", ["image", "inspect", image], { stdio: "ignore", timeout: 5000 }).status === 0;
const nodeImage="node:24.18.0-bookworm-slim";
const nodeAvailable=spawnSync("docker",["image","inspect",nodeImage],{stdio:"ignore",timeout:5000}).status===0;
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
  assert.deepEqual(enabled, ["360search", "bing"]);
  await exec("docker", ["exec", name, "/usr/local/searxng/.venv/bin/python", "/etc/searxng/healthcheck.py"], { timeout: 5000 });
  const logs = await exec("docker", ["logs", name]);
  assert.doesNotMatch(logs.stdout + logs.stderr, /missing config file|X-Forwarded-For nor X-Real-IP/u);
  if (process.env.SETDRAFT_LIVE_SEARCH_TEST === "1") {
   const response = await fetch(`http://${address}/search?q=SearXNG%20documentation&format=json&categories=general`, { headers, signal: AbortSignal.timeout(15000) });
   assert.equal(response.status, 200);
   const result = await response.json();
   assert.ok(result.results?.length, "Live search returned no results; check outbound networking and engine availability");
   context.diagnostic(`Live search returned ${result.results.length} results.`);
   const report=await checkSearch(`http://${address}`,{timeoutMs:30000,attempts:1});
   assert.equal(report.length,2);
   context.diagnostic(`Deployment preflight passed: ${report.map(item=>`${item.language} ${item.candidateCount}/${item.acceptedCount}`).join(", ")}.`);
  }
 } finally {
  await exec("docker", ["rm", "-f", name]).catch(() => {});
 }
});

test("Compose passes the dedicated search proxy only to SearXNG", { skip: !available, timeout: 15000 }, async () => {
 const proxy = "http://proxy.example.org:7890";
 const output = await exec("docker", ["compose", "--env-file", "/dev/null", "-f", fileURLToPath(new URL("../compose.yaml", import.meta.url)), "config", "--format", "json"], {
  env: { ...process.env, SETDRAFT_SEARCH_PROXY: proxy, SETDRAFT_DOWNLOAD_PROXY: "http://downloads.example.org:8080",
   SETDRAFT_SEARCH_DNS_PRIMARY: "10.0.0.53", SETDRAFT_SEARCH_DNS_SECONDARY: "10.0.0.54",
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
 assert.deepEqual(services.search.dns, ["10.0.0.53", "10.0.0.54"]);
 assert.equal(services.web.dns, undefined);
 assert.equal(services.web.depends_on.search.condition, "service_healthy");
 assert.equal(services.web.depends_on["search-check"].condition, "service_completed_successfully");
 assert.deepEqual(services["search-check"].entrypoint,["node","/app/scripts/check-search.mjs"]);
 assert.equal(services["search-check"].environment.SETDRAFT_SEARCH_URL,"http://search:8080");
 assert.equal(services["search-check"].environment.SETDRAFT_DATABASE_URL,undefined);
 assert.equal(services["search-check"].ports,undefined);
 assert.deepEqual(services.search.healthcheck.test, ["CMD", "/usr/local/searxng/.venv/bin/python", "/etc/searxng/healthcheck.py"]);
});

test("container bootstrap persists explicit DNS when host DHCP has no resolver yet",{skip:!nodeAvailable,timeout:15000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"setdraft-dns-bootstrap-"));
 try {
  await mkdir(join(root,"scripts"));
  for(const name of ["compose-config.mjs","deployment-config.mjs","private-file.mjs","data-path.mjs"])
   await cp(new URL(`./${name}`,import.meta.url),join(root,"scripts",name));
  await exec("docker",["run","--rm","--network","none","--user",`${process.getuid()}:${process.getgid()}`,"-v",`${root}:${root}`,"-w",root,
   "-e","SETDRAFT_BOOTSTRAP_DNS=","-e","SETDRAFT_NETWORK=global",nodeImage,"node","scripts/compose-config.mjs"],{timeout:10000});
  const config=parseEnv(await readFile(join(root,".env.compose"),"utf8"));
  assert.equal(config.SETDRAFT_SEARCH_DNS_PRIMARY,"1.1.1.1");
  assert.equal(config.SETDRAFT_SEARCH_DNS_SECONDARY,"1.0.0.1");
 } finally {await rm(root,{recursive:true,force:true});}
});

test("real Compose preflight rejects engine failures and recovers without stopping search",{skip:!available||!nodeAvailable,timeout:45000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"setdraft-compose-search-")), project=`setdraft-search-gate-${randomUUID()}`;
 const source=`import json,os
from http.server import BaseHTTPRequestHandler,HTTPServer
calls=0
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global calls
        if self.path.startswith('/config'):
            body={'engines':[{'name':'bing','enabled':True,'categories':['general']}]}
        else:
            calls+=1
            reason='captcha fake-secret' if os.environ['FIXTURE_MODE']=='fail' else 'HTTP connection error'
            body={'results':[],'unresponsive_engines':[['bing',reason]]} if os.environ['FIXTURE_MODE']=='fail' or calls==1 else {'results':[{'title':'Official docs','url':'https://example.org/docs','content':'Public reference'}]}
        self.send_response(200)
        self.send_header('content-type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def log_message(self,*args): pass
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
`;
 const env={...process.env};
 for(const key of Object.keys(env))if(key.startsWith("SETDRAFT_")||key.startsWith("HYDRO_"))delete env[key];
 Object.assign(env,{SETDRAFT_DATA_PATH:root,SETDRAFT_WEB_IMAGE:nodeImage,SETDRAFT_SEARCH_IMAGE:image,SETDRAFT_SEARCH_SECRET:"test-search-secret",
  SETDRAFT_DB_APP_PASSWORD:"test-app-password",SETDRAFT_DB_ADMIN_PASSWORD:"test-admin-password",SETDRAFT_SEARCH_FIXTURE_MODE:"fail"});
 const override=join(root,"override.json");
 await writeFile(override,JSON.stringify({services:{search:{entrypoint:["/usr/local/searxng/.venv/bin/python","-c",source],environment:{FIXTURE_MODE:"${SETDRAFT_SEARCH_FIXTURE_MODE}"},healthcheck:{interval:"250ms",start_period:"0s",retries:10}}}}));
 const args=["compose","--env-file","/dev/null","-f",fileURLToPath(new URL("../compose.yaml",import.meta.url)),"-f",override,"-p",project];
 const run=(command,timeout=20000)=>exec("docker",[...args,...command],{env,timeout});
 try {
  await run(["up","-d","--no-deps","--no-build","--pull","never","--wait","--wait-timeout","15","search"]);
  await assert.rejects(run(["up","--no-deps","--no-build","--pull","never","--abort-on-container-exit","--exit-code-from","search-check","search-check"]),error=>{
   assert.equal(error.code,1);
   assert.match(error.stdout+error.stderr,/上游引擎要求验证/u);
   assert.doesNotMatch(error.stdout+error.stderr,/fake-secret/u);
   return true;
  });
  assert.ok((await run(["ps","--status","running","-q","search"])).stdout.trim());
  env.SETDRAFT_SEARCH_FIXTURE_MODE="recover";
  await run(["up","-d","--no-deps","--no-build","--pull","never","--wait","--wait-timeout","15","search"]);
  await run(["rm","-f","search-check"]);
  const recovered=await run(["up","--no-deps","--no-build","--pull","never","--abort-on-container-exit","--exit-code-from","search-check","search-check"]);
  assert.match(recovered.stdout,/搜索预检通过/u);
  assert.ok((await run(["ps","--status","running","-q","search"])).stdout.trim());
 } finally {
  await run(["down","--volumes","--remove-orphans"]).catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});

test("the real controller starts web without replaying a completed search preflight",{skip:!available||!nodeAvailable,timeout:45000},async()=>{
 const root=await mkdtemp(join(tmpdir(),"setdraft-compose-start-")), project=`setdraft-start-gate-${randomUUID()}`;
 const source=`import json
from http.server import BaseHTTPRequestHandler,HTTPServer
calls=0
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        global calls
        if self.path.startswith('/config'):
            body={'engines':[{'name':'bing','enabled':True,'categories':['general']}]}
        elif self.path.startswith('/calls'):
            body={'calls':calls}
        else:
            calls+=1
            body={'results':[{'title':'Official docs','url':'https://example.org/docs','content':'Public reference'}]} if calls<=2 else {'results':[],'unresponsive_engines':[['bing','captcha']]}
        self.send_response(200)
        self.send_header('content-type','application/json')
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())
    def log_message(self,*args): pass
HTTPServer(('0.0.0.0',8080),Handler).serve_forever()
`;
 const ready={test:["CMD","node","-e","process.exit(0)"],interval:"250ms",timeout:"2s",retries:10};
 const live={image:nodeImage,entrypoint:["node","-e","setInterval(()=>{},1000)"],healthcheck:ready};
 const configuration={services:{
  database:live,
  migrate:{image:nodeImage,entrypoint:["node","-e","process.exit(0)"],depends_on:{database:{condition:"service_healthy"}},restart:"no"},
  search:{image,entrypoint:["/usr/local/searxng/.venv/bin/python","-c",source],volumes:[`${fileURLToPath(new URL("../deploy/searxng",import.meta.url))}:/etc/searxng:ro`],
   healthcheck:{test:["CMD","/usr/local/searxng/.venv/bin/python","/etc/searxng/healthcheck.py"],interval:"250ms",timeout:"5s",retries:10}},
  "search-check":{image:nodeImage,entrypoint:["node","/app/scripts/check-search.mjs"],environment:{SETDRAFT_SEARCH_URL:"http://search:8080"},
   volumes:[`${fileURLToPath(new URL("./check-search.mjs",import.meta.url))}:/app/scripts/check-search.mjs:ro`],depends_on:{search:{condition:"service_healthy"}},restart:"no"},
  web:{...live,depends_on:{database:{condition:"service_healthy"},migrate:{condition:"service_completed_successfully"},search:{condition:"service_healthy"},"search-check":{condition:"service_completed_successfully"}}},
 }};
 const env={...process.env,COMPOSE_PROJECT_NAME:project};
 for(const key of Object.keys(env))if(key.startsWith("SETDRAFT_")||key.startsWith("HYDRO_")||key==="PORT")delete env[key];
 const args=["compose","--env-file",join(root,".env.compose"),"-f",join(root,"compose.yaml")];
 try {
  await mkdir(join(root,"scripts"));
  for(const name of ["setdraft-compose.sh","compose-config.mjs","deployment-config.mjs","private-file.mjs","data-path.mjs"])
   await cp(new URL(`./${name}`,import.meta.url),join(root,"scripts",name));
  await writeFile(join(root,"compose.yaml"),JSON.stringify(configuration));
  await writeFile(join(root,".env.compose"),"SETDRAFT_IMAGE_MODE='prebuilt'\n");
  await exec("sh",[join(root,"scripts/setdraft-compose.sh"),"start"],{cwd:root,env,timeout:30000});
  const running=await exec("docker",[...args,"ps","--status","running","--format","json"],{env});
  const services=running.stdout.trim().split("\n").map(line=>JSON.parse(line).Service).sort();
  assert.deepEqual(services,["database","search","web"]);
  const calls=await exec("docker",[...args,"exec","-T","search","/usr/local/searxng/.venv/bin/python","-c","import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8080/calls').read().decode())"],{env});
  assert.equal(JSON.parse(calls.stdout).calls,2,"Web startup replayed the preflight after it had already succeeded");
  const migration=await exec("docker",[...args,"ps","--all","--format","json","migrate"],{env});
  assert.equal(JSON.parse(migration.stdout).ExitCode,0);
 } finally {
  await exec("docker",[...args,"down","--timeout","1","--volumes","--remove-orphans"],{env,timeout:15000}).catch(()=>{});
  await rm(root,{recursive:true,force:true});
 }
});

test("explicit Docker DNS restores the real SearXNG client and survives container restarts", { skip: !available, timeout: 45000 }, async () => {
 const id=randomUUID(), network=`setdraft-search-dns-${id}`, server=`${network}-server`, client=`${network}-client`;
 const source=`import socket,struct,threading
from http.server import BaseHTTPRequestHandler,HTTPServer
address=socket.gethostbyname(socket.gethostname())
dns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
dns.bind(('0.0.0.0',53))
def resolve():
    while True:
        data,peer=dns.recvfrom(4096)
        offset=12
        while data[offset]: offset+=data[offset]+1
        end=offset+5
        qtype=struct.unpack('!H',data[offset+1:offset+3])[0]
        answer=b'\\xc0\\x0c'+struct.pack('!HHIH',1,1,5,4)+socket.inet_aton(address) if qtype==1 else b''
        dns.sendto(data[:2]+struct.pack('!HHHHH',0x8180,1,int(bool(answer)),0,0)+data[12:end]+answer,peer)
threading.Thread(target=resolve,daemon=True).start()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'local DNS upstream ready')
    def log_message(self,*args): pass
http=HTTPServer(('0.0.0.0',8081),Handler)
print('Ready',flush=True)
http.serve_forever()
`;
 const probe=expected=>`import asyncio
from curl_cffi.requests.exceptions import RequestException
from searx.network.client import new_client
async def check():
    client=new_client(enable_http=True,verify=True,enable_http2=True,enable_http3=False,max_connections=1,proxies={},local_address=None,max_redirects=0)
    success=False
    try:
        response=await client.get('http://dns-check.invalid:8081/',timeout=2)
        success=response.status_code==200
    except RequestException: pass
    finally: await client.aclose()
    assert success==${expected ? "True" : "False"}, success
    print('DNS probe passed')
asyncio.run(check())
`;
 try {
  await exec("docker",["network","create","--internal",network]);
  await exec("docker",["run","--rm","-d","--name",server,"--network",network,"--user","0","--entrypoint","/usr/local/searxng/.venv/bin/python",image,"-u","-c",source]);
  let ready=false;
  for(let attempt=0;attempt<30;attempt++){
   if((await exec("docker",["logs",server])).stdout.includes("Ready")){ready=true;break;}
   await setTimeout(100);
  }
  assert.ok(ready,"Local DNS fixture did not become ready");
  const address=(await exec("docker",["inspect","--format",`{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,server])).stdout.trim();
  await exec("docker",["run","--rm","--network",network,"--dns","127.0.0.1","--entrypoint","/usr/local/searxng/.venv/bin/python",image,"-c",probe(false)],{timeout:15000});
  await exec("docker",["create","--name",client,"--network",network,"--dns",address,"--dns",address,"--entrypoint","/usr/local/searxng/.venv/bin/python",image,"-c",probe(true)]);
  for(let attempt=0;attempt<2;attempt++){
   const result=await exec("docker",["start","--attach",client],{timeout:15000});
   assert.match(result.stdout,/DNS probe passed/u);
   assert.equal((await exec("docker",["inspect","--format","{{.State.ExitCode}}",client])).stdout.trim(),"0");
  }
  assert.deepEqual(JSON.parse((await exec("docker",["inspect","--format","{{json .HostConfig.Dns}}",client])).stdout),[address,address]);
 } finally {
  await exec("docker",["rm","-f",client]).catch(()=>{});
  await exec("docker",["rm","-f",server]).catch(()=>{});
  await exec("docker",["network","rm",network]).catch(()=>{});
 }
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
