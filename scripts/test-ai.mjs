import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const online = process.env.SETDRAFT_AI_ONLINE_TESTS === "1";
const directory = await mkdtemp(join(tmpdir(), "setdraft-ai-test-"));
const environment = online ? { ...process.env } : Object.fromEntries(["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "CI", "GITHUB_ACTIONS", "SYSTEMROOT"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
if (!online) {
 environment.HOME = directory;
 environment.USERPROFILE = directory;
 environment.PI_CODING_AGENT_DIR = directory;
 environment.PI_NO_LOCAL_LLM = "1";
 environment.NODE_OPTIONS = `--import=${JSON.stringify(fileURLToPath(new URL("./offline-network.mjs", import.meta.url)))}`;
}
try {
 const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(root, "node_modules/vitest/dist/cli.js"), "--run", ...process.argv.slice(2)], { cwd: join(root, "packages/ai"), env: environment, stdio: "inherit" });
  child.once("error", reject);
  child.once("exit", code => resolve(code ?? 1));
 });
 process.exitCode = code;
} finally { await rm(directory, { recursive: true, force: true }); }
