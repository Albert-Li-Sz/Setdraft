import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("pre-commit preserves the index with partial staging, spaces, renames and deletions", async () => {
 const root=await mkdtemp(join(tmpdir(),"setdraft-index-"));
 const git = args => execFileSync("git",args,{cwd:root,encoding:"utf8"});
 try {
  await mkdir(join(root,"scripts"));await mkdir(join(root,"bin"));
  await copyFile(new URL("./check-lockfile-commit.mjs",import.meta.url),join(root,"scripts/check-lockfile-commit.mjs"));
  await copyFile(new URL("../.husky/pre-commit",import.meta.url),join(root,"hook"));
  await writeFile(join(root,"bin/npm"),'#!/bin/sh\nprintf "formatter changed worktree\\n" >> "partial file.ts"\n');await chmod(join(root,"bin/npm"),0o755);
  git(["init","-q"]);git(["config","user.email","test@example.test"]);git(["config","user.name","Test"]);
  for(const path of ["partial file.ts","old.ts","deleted.ts"])await writeFile(join(root,path),"initial\n");
  git(["add","--","partial file.ts","old.ts","deleted.ts"]);git(["commit","-qm","fixture"]);
  await writeFile(join(root,"partial file.ts"),"initial\nstaged\n");git(["add","--","partial file.ts"]);await writeFile(join(root,"partial file.ts"),"initial\nstaged\nprivate unstaged\n");
  git(["mv","--","old.ts","renamed space.ts"]);git(["rm","--","deleted.ts"]);
  const before=git(["write-tree"]);
  execFileSync("sh",["hook"],{cwd:root,env:{...process.env,PATH:`${join(root,"bin")}:${process.env.PATH}`},stdio:"pipe"});
  assert.equal(git(["write-tree"]),before);assert.ok((await readFile(join(root,"partial file.ts"),"utf8")).includes("private unstaged"));
 }finally{await rm(root,{recursive:true,force:true});}
});
