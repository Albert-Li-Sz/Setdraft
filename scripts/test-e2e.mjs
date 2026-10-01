import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { Pool } from "pg";

const exec = promisify(execFile);
const environment = { ...process.env, SETDRAFT_OTEL_ENABLED: "0" };
const args = process.argv.slice(2);
if (args.includes("--full")) {
	environment.SETDRAFT_E2E_FULL = "1";
	args.splice(args.indexOf("--full"), 1);
}
let container;
try {
	await access("packages/hydro-web/dist/index.html");
	await access("packages/hydro-server/dist/index.js");
	if (!environment.SETDRAFT_E2E_DATABASE_URL) {
		const password = randomBytes(24).toString("hex");
		container = `setdraft-e2e-${process.pid}-${randomBytes(3).toString("hex")}`;
		await exec("docker", ["run", "--rm", "-d", "--name", container, "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_DB=setdraft_e2e", "-p", "127.0.0.1::5432", environment.SETDRAFT_POSTGRES_IMAGE || "postgres:18-bookworm@sha256:3725f4e2499eef5134592b3b4ab79a543ed7f8e533b05b5b637af926630f6650"]);
		const address = (await exec("docker", ["port", container, "5432/tcp"])).stdout.trim();
		environment.SETDRAFT_E2E_DATABASE_URL = `postgresql://postgres:${password}@${address}/setdraft_e2e`;
	}
	environment.SETDRAFT_E2E_APP_PASSWORD ||= randomBytes(24).toString("hex");
	const pool = new Pool({ connectionString: environment.SETDRAFT_E2E_DATABASE_URL, max: 1, connectionTimeoutMillis: 1000 });
	try {
		let ready = false;
		for (let attempt = 0; attempt < 60; attempt++) {
			try { await pool.query("SELECT 1"); ready = true; break; } catch { await setTimeout(500); }
		}
		if (!ready) throw new Error("Test PostgreSQL did not become ready.");
	} finally { await pool.end(); }
	if (environment.SETDRAFT_E2E_FULL === "1") await exec("docker", ["image", "inspect", environment.SETDRAFT_SANDBOX_IMAGE || "setdraft/sandbox:local"]);
	const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test", ...args], { env: environment, stdio: "inherit" });
	const stop = () => child.kill("SIGTERM");
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", code => resolve(code ?? 1));
	});
} catch (error) {
	console.error(`E2E setup failed (${error instanceof Error ? error.name : "unknown"}). Build production assets, install Playwright Chromium, and provide Docker or a dedicated SETDRAFT_E2E_DATABASE_URL.`);
	process.exitCode = 1;
} finally {
	if (container) await exec("docker", ["rm", "-f", container]).catch(() => {});
}
