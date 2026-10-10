import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { checkSearch } from "./check-search.mjs";

const results = [
 { title:"Official docs",url:"https://example.org/docs",content:"Public documentation" },
 { title:"Duplicate",url:"https://example.org/docs",content:"Duplicate source" },
 { title:"Blocked",url:"javascript:alert(1)",content:"Invalid source" },
];
async function fixture(handler) {
 const server=createServer(handler);
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 return {endpoint:`http://127.0.0.1:${server.address().port}`,close:async()=>{
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
 }};
}

test("a running JSON API with HTTP connection errors fails the deployment search gate",async()=>{
 const f=await fixture((req,res)=>{
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify({results:[],unresponsive_engines:[["bing","HTTP connection error"],["360search","HTTP connection error"]]}));
 });
 try {await assert.rejects(checkSearch(f.endpoint,{attempts:1}),{category:"network"});}
 finally {await f.close();}
});

test("preflight retries transient failures and verifies both languages without caches or credentials",async()=>{
 const calls=[];
 const f=await fixture((req,res)=>{
  calls.push({url:new URL(req.url,"http://localhost"),headers:req.headers});
  if(calls.length===1){res.statusCode=503;res.end("fake-secret upstream failure");return;}
  res.setHeader("content-type","application/json");
  res.end(JSON.stringify({results,unresponsive_engines:[["360search","captcha fake-secret"]]}));
 });
 try {
  assert.deepEqual(await checkSearch(f.endpoint,{attempts:2,retryDelayMs:0}),[
   {language:"zh-CN",candidateCount:3,acceptedCount:1},{language:"en",candidateCount:3,acceptedCount:1},
  ]);
  assert.equal(calls.length,3);
  for(const {url,headers} of calls){
   assert.equal(url.pathname,"/search");
   assert.equal(url.searchParams.get("categories"),"general");
   assert.equal(headers["cache-control"],"no-cache, no-store");
   assert.equal(headers["x-forwarded-for"],"127.0.0.1");
   assert.equal(headers.cookie,undefined);
   assert.equal(headers.authorization,undefined);
  }
  assert.equal(calls[1].url.searchParams.get("language"),"zh-CN");
  assert.equal(calls[2].url.searchParams.get("language"),"en");
 } finally {await f.close();}
});

test("HTTP rejection, CAPTCHA and malformed or oversized responses cannot report success",async()=>{
 for(const [status,body,category] of [
  [403,"fake-secret","http"],
  [200,JSON.stringify({results:[],unresponsive_engines:[["bing","captcha fake-secret"]]}),"captcha"],
  [200,JSON.stringify({error:"fake-secret"}),"invalid-response"],
  [200,"x".repeat(1_000_001),"invalid-response"],
  [200,JSON.stringify({results:[{title:"\u0000",url:"https://example.org",content:"\u0000"}]}),"no-match"],
 ]) {
  const f=await fixture((req,res)=>{res.statusCode=status;res.end(body);});
  try {await assert.rejects(checkSearch(f.endpoint,{attempts:1}),error=>{
   assert.equal(error.category,category);
   assert.doesNotMatch(error.message,/fake-secret/u);
   return true;
  });} finally {await f.close();}
 }
});

test("preflight enforces its total deadline and does not follow redirects",async()=>{
 const stalled=await fixture(()=>{});
 try {await assert.rejects(checkSearch(stalled.endpoint,{timeoutMs:100,retryDelayMs:0}),{category:"timeout"});}
 finally {await stalled.close();}
 let followed=0;
 const target=await fixture((req,res)=>{followed++;res.end(JSON.stringify({results}));});
 const redirect=await fixture((req,res)=>{res.statusCode=302;res.setHeader("location",target.endpoint);res.end();});
 try {
  await assert.rejects(checkSearch(redirect.endpoint,{attempts:1}),{category:"network"});
  assert.equal(followed,0);
 } finally {await redirect.close();await target.close();}
});

test("the CLI exits nonzero for credentialed endpoints without exposing secrets",async()=>{
 const exec=promisify(execFile);
 await assert.rejects(exec(process.execPath,[fileURLToPath(new URL("./check-search.mjs",import.meta.url))],{
  env:{...process.env,SETDRAFT_SEARCH_URL:"https://user:fake-secret@example.org"},
 }),error=>{
  assert.equal(error.code,1);
  assert.match(error.stderr,/搜索预检失败/u);
  assert.doesNotMatch(error.stdout+error.stderr,/fake-secret|example.org/u);
  return true;
 });
});
