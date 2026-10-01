import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// Exercise native maintenance inside the built release image, without a Docker socket.
const exec = promisify(execFile);
const image = process.argv[2];
if (!image) throw new Error("Usage: node scripts/test-maintenance.mjs <maintenance image>");
const name = `setdraft-maintenance-test-${process.pid}-${randomBytes(3).toString("hex")}`;
const root = await mkdtemp(join(tmpdir(), "setdraft-maintenance-test-"));
const password = randomBytes(24).toString("hex");
const account = randomUUID();
const environment = {
	SETDRAFT_WORKSPACE_ROOT: "/scenario/workspace",
	SETDRAFT_DATABASE_ADMIN_URL: `postgresql://postgres:${password}@database:5432/setdraft_test`,
	SETDRAFT_DATABASE_URL: `postgresql://native_test:${password}@database:5432/setdraft_test`,
	SETDRAFT_OTEL_ENABLED: "0",
	SETDRAFT_MAINTENANCE_TEST_ACCOUNT: account,
};
const docker = (args) => exec("docker", args, { maxBuffer: 1024 * 1024, timeout: 60_000 });
const inImage = (args, overrides = {}) => docker(["run", "--rm", "--network", name, "--mount", `type=bind,source=${root},target=/scenario`, ...Object.entries({ ...environment, ...overrides }).flatMap(([key, value]) => ["-e", `${key}=${value}`]), "--entrypoint", "node", image, ...args]);
const native = (command, target) => inImage(["scripts/hydro-local.mjs", command, `/scenario/${target}`]);
const sql = async (statement) => (await docker(["exec", name, "psql", "--no-psqlrc", "-qAt", "-U", "postgres", "-d", "setdraft_test", "-c", statement])).stdout.trim();
try {
	await docker(["network", "create", name]);
	await docker(["run", "--rm", "-d", "--name", name, "--network", name, "--network-alias", "database", "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=setdraft_test", "-p", "127.0.0.1::5432", process.env.SETDRAFT_POSTGRES_IMAGE || "postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650"]);
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) { try { await sql("SELECT 1"); ready = true; break; } catch { await setTimeout(500); } }
	assert.ok(ready, "Dedicated PostgreSQL did not start");
	const initialized = await inImage(["--input-type=module", "-e", `
import {migrateDatabase} from './packages/hydro-server/dist/database-schema.js';
import {closeDatabasePools} from './packages/hydro-server/dist/postgres.js';
import {WorkspaceDatabase} from './packages/hydro-server/dist/workspace-db.js';
await migrateDatabase(process.env.SETDRAFT_DATABASE_ADMIN_URL,'native_test','',new URL(process.env.SETDRAFT_DATABASE_URL).password);
const id=process.env.SETDRAFT_MAINTENANCE_TEST_ACCOUNT;
const db=new WorkspaceDatabase('/scenario/workspace/users/'+id,id);
await db.commitFiles([{ownerKind:'manual',ownerId:'fixture',name:'answer.out',source:{bytes:Buffer.from('healthy answer\\n')}}],()=>db.put('project','fixture',{title:'healthy'}));
console.log(JSON.stringify({path:await db.filePath('manual','fixture','answer.out')}));
await closeDatabasePools();`]);
	const blob = join(root, JSON.parse(initialized.stdout).path.slice("/scenario/".length));
	await sql(`INSERT INTO identity.users(id,username,password_hash,role,created_at) VALUES('${account}','maintenance-test','test-only','admin',0)`);
	await sql(`INSERT INTO identity.sessions VALUES('test-session','${account}','test-csrf',0,0,9999999999999)`);
	await native("backup", "healthy");
	assert.equal(JSON.parse(await readFile(join(root, "healthy/manifest.json"), "utf8")).format, "setdraft-postgres-1");
	// A reference to a now-missing blob must not prevent a known healthy restore.
	await rm(blob);
	await sql("UPDATE workspace.documents SET body='{\"title\":\"damaged current\"}' WHERE id='fixture'");
	await assert.rejects(native("backup", "invalid-backup"));
	await assert.rejects(readFile(join(root, "invalid-backup/manifest.json")));
	await native("restore", "healthy");
	assert.equal(await readFile(blob, "utf8"), "healthy answer\n");
	assert.equal(await sql("SELECT body->>'title' FROM workspace.documents WHERE id='fixture'"), "healthy");
	assert.equal(await sql("SELECT count(*) FROM identity.sessions"), "0");
	const archived = (await readdir(root)).find((entry) => entry.startsWith("healthy.before-restore-"));
	assert.ok(archived, "Damaged scene archive missing");
	const damage = JSON.parse(await readFile(join(root, archived, "manifest.json"), "utf8"));
	assert.equal(damage.format, "setdraft-damaged-snapshot-1");
	assert.equal(damage.issues[0].code, "BLOB_MISSING");
	assert.equal(await sql("SELECT has_table_privilege('native_test','workspace.documents','SELECT')"), "t");
	// Preflight rejects a damaged archive and a different administrator database.
	await writeFile(join(root, "healthy/database.dump"), "corrupt archive");
	await assert.rejects(native("restore", "healthy"));
	assert.equal(await sql("SELECT body->>'title' FROM workspace.documents WHERE id='fixture'"), "healthy");
	await assert.rejects(inImage(["scripts/hydro-local.mjs", "backup", "/scenario/mismatch"], { SETDRAFT_DATABASE_ADMIN_URL: environment.SETDRAFT_DATABASE_ADMIN_URL.replace("/setdraft_test", "/wrong_database") }));
	const lease = docker(["exec", "-e", "PGAPPNAME=maintenance-lock-test", name, "psql", "--no-psqlrc", "-qAt", "-U", "postgres", "-d", "setdraft_test", "-c", "SELECT pg_advisory_lock(hashtextextended('setdraft-server',0));SELECT pg_sleep(55)"]).catch(() => {});
	try {
		let held = false;
		for (let attempt = 0; attempt < 30; attempt++) { if (await sql("SELECT pg_try_advisory_lock(hashtextextended('setdraft-server',0))") === "f") { held = true; break; } await setTimeout(100); }
		assert.ok(held, "Active-service database lease not acquired");
		await assert.rejects(native("backup", "while-active"));
	} finally { await sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='maintenance-lock-test'"); await lease; }
	console.log("Native backup/restore passed: damaged scene recovery, custom DB role, session revocation, invalid archive/database preflight and active-service exclusion.");
} finally {
	await docker(["rm", "-f", name]).catch(() => {});
	await docker(["network", "rm", name]).catch(() => {});
	await rm(root, { recursive: true, force: true });
}
