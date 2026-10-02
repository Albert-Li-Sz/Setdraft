import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalPath, containsPath } from "./data-path.mjs";
import { parseEnv } from "node:util";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootFiles = [
 "package.json", "package-lock.json", "tsconfig.json", "tsconfig.base.json", "vitest.base.ts", "playwright.config.mjs", "biome.json",
 "Dockerfile", ".dockerignore", ".gitignore", ".gitattributes", ".npmrc", ".env.example", "compose.yaml", "compose.build.yaml",
 "LICENSE", "COPYING.md", "README.md", "UPSTREAM.md", "CONTRIBUTING.md", "SECURITY.md", "AGENTS.md",
 "install.sh", "upgrade.sh", "uninstall.sh", "backup.sh",
];
const packageNames = ["ai", "telemetry", "hydro-contracts", "hydro-authoring", "hydro-server", "hydro-web"];
const omitted = new Set(["node_modules", "dist", "coverage", ".git", ".setdraft", ".hydro-problem-make", ".artifacts", "playwright-report", "test-results", ".e2e", ".private-reports", ".DS_Store"]);
const extensions = /\.(?:[cm]?[jt]sx?|css|html|json|md|typ|toml|ya?ml|sh|svg|png|jpe?g|gif|wasm|otf|ttf|txt|h|c|cc|cpp|py|java|in|out|ans)$/u;
const privateReport = /(?:^|[-_. ])(?:audit|review|remediation|acceptance)(?:[-_. ]|$)|审计|复审|验收|BUG清单/iu;

export async function collectSourceFiles(root) {
 const files = [];
 const saved = parseEnv(await readFile(join(root, ".env"), "utf8").catch(error => { if (error.code !== "ENOENT") throw error; return ""; }));
 const configured = process.env.SETDRAFT_WORKSPACE_ROOT ?? process.env.HYDRO_WORKSPACE_ROOT ?? saved.SETDRAFT_WORKSPACE_ROOT ?? saved.HYDRO_WORKSPACE_ROOT ?? ".setdraft";
 const dataRoot = resolve(root, configured);
 const physicalDataRoot = await canonicalPath(dataRoot);
 if (containsPath(dataRoot, root) || containsPath(physicalDataRoot, await canonicalPath(root))) throw new Error("Data directory cannot contain source repository");
 async function visit(relative, required = false) {
  const name = relative.split("/").at(-1);
  if (omitted.has(name) || (name.startsWith(".env") && relative !== ".env.example")) return;
  if (/\.(?:md|txt)$/iu.test(name) && privateReport.test(name)) return;
  if (relative.startsWith("packages/hydro-web/public/open-source/") && name !== "index.html") return;
  const info = await lstat(join(root, relative)).catch((error) => {
   if (error.code === "ENOENT" && !required) return undefined;
   throw error;
  });
  if (!info || info.isSymbolicLink()) return;
  if (containsPath(dataRoot, join(root, relative)) || containsPath(physicalDataRoot, await canonicalPath(join(root, relative)))) return;
  if (info.isDirectory()) {
   for (const child of (await readdir(join(root, relative))).sort()) await visit(`${relative}/${child}`);
  } else if (info.isFile() && (required || extensions.test(name) || /^(?:LICENSE|README|Dockerfile|Caddyfile\.example|pre-commit)$/u.test(name))) {
   if (/[\n\r\0]/u.test(relative)) throw new Error("Invalid source archive path");
   files.push(relative);
  }
 }
 for (const name of rootFiles) await visit(name, true);
 for (const directory of ["LICENSES", "scripts", "docs", "deploy", "fixtures", "e2e", ".github", ".husky"]) await visit(directory, true);
 for (const name of packageNames) {
  const directory = `packages/${name}`;
  await visit(`${directory}/package.json`, true);
  for (const entry of await readdir(join(root, directory))) {
   if (["src", "scripts", "test", "assets", "sandbox", "public"].includes(entry) || /^(?:README|LICENSE|tsconfig|vite\.|vitest\.|index\.html)/u.test(entry) || /\.[cm]?[jt]s$/u.test(entry))
    await visit(`${directory}/${entry}`);
  }
 }
 return [...new Set(files)].sort();
}

export async function packageSource(root = repository) {
 const files = await collectSourceFiles(root);
 const output = join(root, "packages/hydro-web/public/open-source");
 await mkdir(output, { recursive: true });
 const archive = join(output, "source.tgz");
 const temporary = `${archive}.${process.pid}.tmp`;
 try {
  await new Promise((resolveArchive, reject) => {
   const child = spawn("tar", ["-czf", temporary, "--null", "--no-recursion", "-T", "-"], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["pipe", "ignore", "pipe"] });
   let diagnostic = "";
   child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk.toString()).slice(0, 4000); });
   child.once("error", reject);
   child.stdin.on("error", reject);
   child.once("close", (code) => code === 0 ? resolveArchive() : reject(new Error(`Source archive failed: ${diagnostic}`)));
   child.stdin.end(`${files.join("\0")}\0`);
  });
  await rename(temporary, archive);
  for (const [source, target] of [
   ["COPYING.md", "COPYING.md"], ["LICENSES/AGPL-3.0.txt", "AGPL-3.0.txt"], ["LICENSE", "MIT.txt"],
   ["packages/hydro-server/assets/xcpc/FONT-NOTICES.md", "FONT-NOTICES.md"],
  ]) await copyFile(join(root, source), join(output, target));
  return archive;
 } finally {
  await rm(temporary, { force: true });
 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 console.log(await packageSource());
}
