import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

export function containsPath(parent, child) {
 const path=relative(parent,child);
 return !path || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
export async function canonicalPath(path) {
 try { return await realpath(path); }
 catch(error) {
  if(error.code!=="ENOENT")throw error;
  const parent=dirname(path);
  return parent===path ? path : join(await canonicalPath(parent),basename(path));
 }
}
