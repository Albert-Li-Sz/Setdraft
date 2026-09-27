import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";
const exec=promisify(execFile);
let container;
const environment={...process.env};
try {
 if(!environment.SETDRAFT_TEST_DATABASE_URL){
  const password=randomBytes(24).toString("hex");
  container=`setdraft-test-${process.pid}-${randomBytes(3).toString("hex")}`;
  await exec("docker",["run","--rm","-d","--name",container,"-e",`POSTGRES_PASSWORD=${password}`,"-e","POSTGRES_DB=setdraft_test","-p","127.0.0.1::5432",process.env.SETDRAFT_POSTGRES_IMAGE||"postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650"]);
  const address=(await exec("docker",["port",container,"5432/tcp"])).stdout.trim();
  environment.SETDRAFT_TEST_DATABASE_URL=`postgresql://postgres:${password}@${address}/setdraft_test`;
  environment.SETDRAFT_TEST_APP_PASSWORD=password;
  const pool=new Pool({connectionString:environment.SETDRAFT_TEST_DATABASE_URL,max:1,connectionTimeoutMillis:1000});
  try {
   let ready=false;
   for(let attempt=0;attempt<60;attempt++){try{await pool.query("SELECT 1");ready=true;break;}catch{await setTimeout(500);}}
   if(!ready)throw new Error("Test PostgreSQL did not become ready.");
   await pool.query(`CREATE ROLE setdraft_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`);
  } finally {await pool.end();}
 }
 const child=spawn(process.execPath,["../../node_modules/vitest/vitest.mjs","--run",...process.argv.slice(2)],{env:environment,stdio:"inherit"});
 const stop=()=>child.kill("SIGTERM");process.once("SIGINT",stop);process.once("SIGTERM",stop);
 process.exitCode=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",code=>resolve(code??1));});
}catch{console.error("Server tests require Docker, or SETDRAFT_TEST_DATABASE_URL and SETDRAFT_TEST_APP_PASSWORD for a dedicated test database. See the server README.");process.exitCode=1;}
finally{if(container)await exec("docker",["rm","-f",container]).catch(()=>{});}
