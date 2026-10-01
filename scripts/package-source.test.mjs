import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { collectSourceFiles, packageSource } from "./package-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);

test("corresponding source includes application, notices, tests and installation inputs", async () => {
 const files = await collectSourceFiles(root);
 for (const required of [
  "Dockerfile", "compose.yaml", ".env.example", "package-lock.json", "scripts/package-source.mjs", ".husky/pre-commit",
  "LICENSE", "COPYING.md", "LICENSES/AGPL-3.0.txt", "docs/authoring-guide.md", "fixtures/hydro/a-plus-b/README.md",
  "fixtures/hydro/a-plus-b/authoring/reference.cc", "packages/ai/scripts/check-model-data.ts",
  "deploy/Caddyfile.example", "packages/ai/bedrock-provider.d.ts", "packages/ai/bedrock-provider.js",
  "packages/hydro-server/src/contest-pdf-worker.ts", "packages/hydro-server/assets/xcpc/lib.typ",
  "packages/hydro-server/assets/xcpc/fonts/FZSSK.ttf", "packages/hydro-server/test/contest-pdf-template.test.ts",
  "packages/hydro-web/vite.config.ts", "packages/hydro-web/public/open-source/index.html",
  "playwright.config.mjs", "e2e/fixtures.mjs", "e2e/core.spec.mjs", "e2e/full.spec.mjs", "fixtures/markdown/statement.md",
 ]) assert.ok(files.includes(required), required);
 assert.ok(files.every((path) => !/(?:^|\/)(?:node_modules|dist|\.git|\.setdraft|\.artifacts)(?:\/|$)/u.test(path)));
});

test("published archive omits secrets, outputs, user data and symlinks and is reproducible without itself", async () => {
 const temporary = await mkdtemp(join(tmpdir(), "setdraft-source-test-"));
 try {
  const actual = await collectSourceFiles(root);
  const inputs = actual.filter((path) => !path.includes("/") || path.endsWith("/package.json"));
  inputs.push("LICENSES/AGPL-3.0.txt", "scripts/build.mjs", "docs/build.md", "deploy/entry.sh", "fixtures/example.in", "e2e/smoke.spec.mjs",
   ".github/workflows/ci.yml", ".husky/pre-commit", "packages/hydro-server/src/example.ts", "packages/hydro-server/src/audit.ts",
   "packages/hydro-server/assets/xcpc/FONT-NOTICES.md", "packages/hydro-web/public/open-source/index.html");
  const excluded = [".env", ".env.compose", ".git/config", ".setdraft/user.json", "private.json",
   "playwright-report/index.html", "test-results/credentials.json", ".e2e/workspace/user.json",
   "packages/hydro-web/public/open-source/source.tgz", "packages/hydro-server/node_modules/private.json",
   "packages/hydro-server/src/.env.local", "packages/hydro-server/dist/example.js", "packages/hydro-server/src/credentials.pem",
   "docs/rev0.5-acceptance-2026-10-01.md", "docs/rev0.4-remediation-plan-2026-10-01.md",
   "docs/security-audit-report.txt", "docs/Setdraft-review.md", "docs/Setdraft-Bug审计报告.md",
   "docs/.private-reports/internal.md"];
  for (const path of [...inputs, ...excluded]) {
   await mkdir(dirname(join(temporary, path)), { recursive: true });
   await writeFile(join(temporary, path), path);
  }
  await symlink(join(temporary, ".env"), join(temporary, "packages/hydro-server/src/linked.json"));
  const archive = await packageSource(temporary);
  const listing = (await exec("tar", ["-tzf", archive])).stdout.trim().split("\n");
  for (const path of inputs) assert.ok(listing.includes(path), path);
  for (const path of [...excluded, "packages/hydro-server/src/linked.json"]) assert.ok(!listing.includes(path), path);
  assert.equal(await readFile(join(temporary, "packages/hydro-web/public/open-source/COPYING.md"), "utf8"), "COPYING.md");
  await packageSource(temporary);
  assert.deepEqual((await exec("tar", ["-tzf", archive])).stdout.trim().split("\n"), listing);
 } finally {
  await rm(temporary, { recursive: true, force: true });
 }
});
