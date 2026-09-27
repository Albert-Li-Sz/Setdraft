import { spawn } from "node:child_process";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { Pool } from "pg";
import { migrateDatabase } from "../packages/hydro-server/dist/database-schema.js";
import { fileManifest, validateWorkspaceDirectory } from "./workspace-integrity.mjs";

const root=resolve(process.env.SETDRAFT_WORKSPACE_ROOT);
const [command,directory,...extra]=process.argv.slice(2);
if(!directory||extra.length||!["backup","restore"].includes(command))throw new Error("backup|restore <目录>");
const target=resolve(directory);
if(target===root||target.startsWith(`${root}${sep}`)||root.startsWith(`${target}${sep}`))throw new Error("备份目录不能与数据目录重叠。");
const url=new URL(process.env.SETDRAFT_DATABASE_ADMIN_URL);
const pool=new Pool({connectionString:url.toString(),max:1});const client=await pool.connect();
const pgEnv={...process.env,PGHOST:url.hostname,PGPORT:url.port||"5432",PGUSER:decodeURIComponent(url.username),PGPASSWORD:decodeURIComponent(url.password),PGDATABASE:decodeURIComponent(url.pathname.slice(1))};
const excluded=new Set(["runtime",".tmp",".blob-staging",".service.lock","server.pid"]);
async function copyData(source,destination){await cp(source,destination,{recursive:true,filter:path=>!excluded.has(relative(source,path).split(sep)[0])});}
async function clearData(){await mkdir(root,{recursive:true});for(const entry of await readdir(root))if(entry!==".service.lock")await rm(join(root,entry),{recursive:true,force:true});}
async function verifyReferences(files){
 const {rows}=await client.query("SELECT DISTINCT account_id,hash FROM workspace.files");
 for(const row of rows){
  const path=`files/users/${row.account_id}/blobs/${row.hash.slice(0,2)}/${row.hash}`;
  if(files[path]!==row.hash)throw new Error("数据库引用的文件缺失或内容校验失败。");
 }
}
function run(program,args){return new Promise((resolve,reject)=>{const child=spawn(program,args,{env:pgEnv,stdio:["ignore","ignore","pipe"]});let failed="";child.stderr.on("data",chunk=>{failed+=chunk.toString().slice(0,4000);});child.once("error",reject);child.once("close",code=>code===0?resolve():reject(new Error(`${program} 失败（${code}）：${failed.replaceAll(pgEnv.PGPASSWORD,"***")}`)));});}
async function backup(destination){
 if(await stat(destination).catch(()=>undefined))throw new Error("备份目录已存在，请使用新目录。");
 await mkdir(destination,{recursive:true,mode:0o700});
 try {
  await copyData(root,join(destination,"files"));
  await run("pg_dump",["--format=custom","--schema=identity","--schema=workspace",`--file=${join(destination,"database.dump")}`]);
  const files=await fileManifest(destination);await verifyReferences(files);
  await writeFile(join(destination,"manifest.json"),JSON.stringify({format:"setdraft-postgres-1",createdAt:new Date().toISOString(),files},null,2),{mode:0o600});
  await validateWorkspaceDirectory(destination);
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
}
async function restore(source){
 await run("pg_restore",["--clean","--if-exists","--single-transaction","--no-owner","--no-privileges",`--dbname=${pgEnv.PGDATABASE}`,join(source,"database.dump")]);
 await migrateDatabase(url.toString());
 await verifyReferences(await fileManifest(source));
 await clearData();await copyData(join(source,"files"),root);
 await client.query("DELETE FROM identity.sessions; DELETE FROM identity.metadata WHERE key='setup'");
}
try {
 const result=await client.query("SELECT pg_try_advisory_lock(hashtextextended('setdraft-server',0)) AS locked");
 if(!result.rows[0].locked)throw new Error("服务仍在运行，请先停止所有连接此数据库的 Setdraft 实例。");
 if(command==="backup"){await backup(target);console.log(`PostgreSQL 与全部用户文件已备份并校验：${target}`);}
 else {
  await validateWorkspaceDirectory(target);
  const previous=`${target}.before-restore-${Date.now()}`;await backup(previous);
  try {await restore(target);}catch(error){await restore(previous);throw error;}
  console.log(`恢复完成，旧会话已撤销。恢复前备份：${previous}`);
 }
}finally{client.release();await pool.end();}
