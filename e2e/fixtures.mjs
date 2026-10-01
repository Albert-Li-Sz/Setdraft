import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test as base, expect } from "@playwright/test";
import { redact } from "../scripts/deployment-config.mjs";

export const password = "setdraft e2e password 123";
export const test = base.extend({
	app: async ({}, use, testInfo) => {
		const child = fork("scripts/e2e-server.mjs", { stdio: ["ignore", "pipe", "pipe", "ipc"] });
		let log = "";
		for (const stream of [child.stdout, child.stderr]) stream.on("data", bytes => { log = (log + bytes.toString()).slice(-100_000); });
		try {
			const ready = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("E2E server startup timed out")), 30_000);
				child.once("error", reject);
				child.once("exit", () => { clearTimeout(timer); reject(new Error("E2E server exited during startup; see redacted server.log")); });
				child.once("message", value => { clearTimeout(timer); resolve(value); });
			});
			await use({
				...ready,
				control: (action, payload) => new Promise((resolve, reject) => {
					const id = randomUUID();
					const timer = setTimeout(() => { child.off("message", listener); reject(new Error("Fixture action timed out")); }, 30_000);
					const listener = value => { if (value.id === id) { clearTimeout(timer); child.off("message", listener); value.error ? reject(new Error(value.error)) : resolve(value.result); } };
					child.on("message", listener);
					child.send({ id, action, payload });
				}),
			});
		} finally {
			if (child.exitCode === null) { const exited = once(child, "exit"); const kill = setTimeout(() => child.kill("SIGKILL"), 15_000); child.kill("SIGTERM"); await exited; clearTimeout(kill); }
			if (testInfo.status !== testInfo.expectedStatus) {
				let safe = redact(log).replaceAll(password, "[redacted]").replaceAll("faux-key", "[redacted]");
				for (const key of ["SETDRAFT_E2E_APP_PASSWORD", "SETDRAFT_E2E_DATABASE_URL", "OTEL_EXPORTER_OTLP_HEADERS", "OTEL_EXPORTER_OTLP_TRACES_HEADERS", "OTEL_EXPORTER_OTLP_METRICS_HEADERS"])
					if (process.env[key]) safe = safe.replaceAll(process.env[key], "[redacted]");
				await testInfo.attach("server.log", { body: Buffer.from(safe), contentType: "text/plain" });
			}
		}
	},
});
export { expect };

export async function setup(page, app) {
	await page.goto(app.url);
	await page.getByLabel("安装码", { exact: true }).fill(app.setupToken);
	await page.getByLabel("用户名", { exact: true }).fill("e2e-admin");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByRole("button", { name: "创建并进入", exact: true }).click();
	await expect(page.getByRole("button", { name: "新建题目", exact: true })).toBeVisible();
}

export async function api(page, app, path, options = {}) {
	const session = await (await page.request.get(`${app.url}/api/auth/session`)).json();
	return page.request.fetch(`${app.url}/api${path}`, { ...options, headers: { origin: app.url, "x-csrf-token": session.csrfToken ?? "", ...options.headers } });
}
export async function json(page, app, path, options = {}) {
	const response = await api(page, app, path, options);
	expect(response.ok(), `${options.method ?? "GET"} ${path}: ${await response.text()}`).toBeTruthy();
	return response.json();
}
export async function newProject(page) {
	await page.getByRole("button", { name: "新建题目", exact: true }).click();
	const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/projects" && response.request().method() === "POST");
	await page.getByRole("dialog").getByRole("button", { name: /ACM/ }).click();
	const project = await (await created).json();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await expect(page.getByLabel("题目标题", { exact: true })).toBeVisible();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("");
	return project;
}
export async function saved(page, app, id, expected) {
	await expect.poll(async () => {
		const project = await json(page, app, `/projects/${id}`);
		return Object.fromEntries(Object.keys(expected).map(key => [key, project[key]]));
	}).toEqual(expected);
}
