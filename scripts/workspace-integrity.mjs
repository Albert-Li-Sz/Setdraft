import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export async function hashFile(path) {
 const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");
}
export async function fileManifest(root, directory="") {
 const files={};
 for(const entry of await readdir(join(root,directory),{withFileTypes:true})) {
  const relative=directory ? `${directory}/${entry.name}` : entry.name;
  if(!directory && entry.name==="manifest.json")continue;
  if(entry.isSymbolicLink())throw new Error("备份不能包含符号链接。");
  if(entry.isDirectory())Object.assign(files,await fileManifest(root,relative));
  else if(entry.isFile())files[relative]=await hashFile(join(root,relative));
  else throw new Error("备份只能包含普通文件。");
 }
 return files;
}
export async function validateWorkspaceDirectory(directory) {
 const manifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
 if(manifest.format!=="setdraft-postgres-1" || !manifest.files || !manifest.files["database.dump"])throw new Error("不是完整的 PostgreSQL 备份。");
 if(!(await lstat(directory)).isDirectory())throw new Error("备份路径不是目录。");
 const actual=await fileManifest(directory);
 if(Object.keys(actual).length!==Object.keys(manifest.files).length)throw new Error("备份文件数量不匹配。");
 for(const [path,hash] of Object.entries(actual))if(manifest.files[path]!==hash)throw new Error(`备份文件校验失败：${path}`);
 return manifest;
}
