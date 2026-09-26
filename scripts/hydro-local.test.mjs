import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(executable, args) {
	return spawnSync(executable, args, { cwd: root, encoding: "utf8" });
}

test("quick install and upgrade dry runs list the exact preparation steps", () => {
	const install = command("sh", [join(root, "install.sh"), "--dry-run"]);
	assert.equal(install.status, 0, install.stderr);
	assert.match(install.stdout, /npm ci --ignore-scripts/);
	assert.match(install.stdout, /npm 镜像 https:\/\/registry\.npmmirror\.com/);
	assert.match(install.stdout, /模型数据缺失时先补齐/);
	assert.match(install.stdout, /docker build -t hydro-problem-make\/sandbox:local/);
	const upgrade = command("sh", [join(root, "upgrade.sh"), "--dry-run"]);
	assert.equal(upgrade.status, 0, upgrade.stderr);
	assert.match(upgrade.stdout, /git fetch origin main/);
	assert.match(upgrade.stdout, /git merge --ff-only FETCH_HEAD/);
});

test("model catalog loads its JSON snapshot before the API starts", () => {
	const models = command(process.execPath, [
		"--import",
		"tsx",
		"--input-type=module",
		"-e",
		'import { MODELS } from "./packages/ai/src/models.generated.ts"; if (!MODELS["amazon-bedrock"]) throw new Error("Bedrock models missing");',
	]);
	assert.equal(models.status, 0, models.stderr);
});

test("uninstall dry run makes data and dependency deletion explicit", () => {
	const defaultRun = command("sh", [join(root, "uninstall.sh"), "--dry-run"]);
	assert.equal(defaultRun.status, 0, defaultRun.stderr);
	assert.doesNotMatch(defaultRun.stdout, /永久删除/);
	const purge = command("sh", [
		join(root, "uninstall.sh"),
		"--purge-data",
		"--remove-deps",
		"--dry-run",
	]);
	assert.equal(purge.status, 0, purge.stderr);
	assert.match(purge.stdout, /永久删除/);
	assert.match(purge.stdout, /node_modules/);
});

test("invalid and duplicate options do not run maintenance commands", () => {
	const duplicate = command(process.execPath, [join(root, "scripts/hydro-local.mjs"), "install", "--dry-run", "--dry-run"]);
	assert.equal(duplicate.status, 1);
	assert.match(duplicate.stderr, /参数无效或重复/);
	const invalidService = command(process.execPath, [join(root, "scripts/hydro-local.mjs"), "service", "toString"]);
	assert.equal(invalidService.status, 1);
	assert.match(invalidService.stderr, /无效服务名/);
});

test("uninstall preserves project data unless purge is requested", () => {
	const fixture = mkdtempSync(join(tmpdir(), "hydro-local-uninstall-"));
	try {
		mkdirSync(join(fixture, "scripts"));
		mkdirSync(join(fixture, "bin"));
		mkdirSync(join(fixture, ".hydro-problem-make", "runtime"), { recursive: true });
		copyFileSync(join(root, "scripts/hydro-local.mjs"), join(fixture, "scripts/hydro-local.mjs"));
		writeFileSync(join(fixture, ".hydro-problem-make", "project.txt"), "keep");
		writeFileSync(join(fixture, ".hydro-problem-make", "runtime", "api.log"), "temporary log");
		writeFileSync(join(fixture, "bin", "docker"), "#!/bin/sh\necho 'No such image' >&2\nexit 1\n", {
			mode: 0o755,
		});
		const env = { ...process.env, PATH: `${join(fixture, "bin")}:${process.env.PATH ?? ""}` };
		const uninstall = spawnSync(process.execPath, [join(fixture, "scripts/hydro-local.mjs"), "uninstall"], {
			cwd: fixture,
			encoding: "utf8",
			env,
		});
		assert.equal(uninstall.status, 0, uninstall.stderr);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "project.txt")), true);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make", "runtime")), false);
		const purge = spawnSync(
			process.execPath,
			[join(fixture, "scripts/hydro-local.mjs"), "uninstall", "--purge-data"],
			{ cwd: fixture, encoding: "utf8", env },
		);
		assert.equal(purge.status, 0, purge.stderr);
		assert.equal(existsSync(join(fixture, ".hydro-problem-make")), false);
	} finally {
		rmSync(fixture, { recursive: true, force: true });
	}
});
