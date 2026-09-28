import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function fixture() {
 const root = await mkdtemp(join(tmpdir(), "setdraft-compose-install-"));
 await mkdir(join(root,"scripts")); await mkdir(join(root,"bin"));
 for(const file of ["install.sh","scripts/setdraft-compose.sh","scripts/compose-config.mjs","scripts/deployment-config.mjs"])
  await cp(new URL(`../${file}`,import.meta.url),join(root,file));
 await writeFile(join(root,"bin/docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
 *' pull '*) [ "\${FAIL_PULL:-no}" != yes ] || exit 42 ;;
esac
`, {mode:0o755});
 const environment = {...process.env, PATH:`${join(root,"bin")}:${process.env.PATH}`,COMMAND_LOG:join(root,"commands.log")};
 for(const key of Object.keys(environment)) if(key.startsWith("SETDRAFT_")||key.startsWith("HYDRO_")||key==="PORT") delete environment[key];
 const run=(args,extra={})=>spawnSync("sh",[join(root,"scripts/setdraft-compose.sh"),...args],{cwd:root,env:{...environment,...extra},encoding:"utf8"});
 return {root,run,log:()=>readFile(environment.COMMAND_LOG,"utf8"),clear:()=>writeFile(environment.COMMAND_LOG,"")};
}

test("installation pulls every image before stopping the web service and never builds by default",async()=>{
 const f=await fixture();
 try{
  const result=f.run(["install"]); assert.equal(result.status,0,result.stderr);
  const log=await f.log();
  assert.match(log,/pull web sandbox maintenance database search/u);
  assert.ok(log.indexOf("pull web")<log.indexOf("stop web"));
  assert.match(log,/up -d --no-build --pull never --wait/u);
  assert.doesNotMatch(log,/ build |compose\.build\.yaml/u);
  await f.clear();
  const failed=f.run(["install"],{FAIL_PULL:"yes"}); assert.equal(failed.status,42,failed.stderr);
  assert.doesNotMatch(await f.log(),/ stop | up /u);
  await f.clear();
  assert.equal(f.run(["start"]).status,0);
  assert.doesNotMatch(await f.log(),/ pull | build /u);
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("explicit source builds persist and switching to prebuilt removes the build override",async()=>{
 const f=await fixture();
 try{
  assert.equal(f.run(["install","--build"]).status,0);
  assert.match(await f.log(),/compose\.build\.yaml build web sandbox maintenance/u);
  await f.clear();assert.equal(f.run(["install"]).status,0);
  assert.match(await f.log(),/compose\.build\.yaml build web sandbox maintenance/u);
  await f.clear();assert.equal(f.run(["install","--prebuilt"]).status,0);
  assert.doesNotMatch(await f.log(),/compose\.build\.yaml/u);
  assert.match(await f.log(),/pull web sandbox maintenance database search/u);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
