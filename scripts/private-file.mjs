import { randomUUID } from "node:crypto";
import { lstat, open, rename, rm, stat } from "node:fs/promises";

export async function writePrivateFile(path, content) {
 const existing = await lstat(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
 if (existing && !existing.isFile()) throw new Error("Credential file must be a regular file");
 const temporary = `${path}.${randomUUID()}.tmp`;
 try {
  const file = await open(temporary, "wx", 0o600);
  try { await file.chmod(0o600); await file.writeFile(content, "utf8"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error("Credential file permissions must be 0600");
 } finally { await rm(temporary, { force: true }); }
}
