import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

let server, origin;
test.beforeAll(async () => {
	server = await createServer({ configFile: false, appType: "custom", root: fileURLToPath(new URL("../packages/hydro-web", import.meta.url)), plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
	server.middlewares.use(async (request, response, next) => {
		if (request.url !== "/__tasks_test__") return next();
		const html = await server.transformIndexHtml(request.url, `<!doctype html><html><body><div id="root"></div><script type="module">
			import { createElement as h, useState } from "react";
			import { createRoot } from "react-dom/client";
			import { TasksPage } from "/src/TasksPage.tsx";
			import { LocaleProvider } from "/src/i18n.tsx";
			function Harness() {
				const [paused, setPaused] = useState(false);
				return h(LocaleProvider, null, h("button", { id: "pause", onClick: () => setPaused(value => !value) }, paused ? "Resume" : "Pause"), h(TasksPage, { apiOrigin: "", paused }));
			}
			createRoot(document.getElementById("root")).render(h(Harness));
		</script></body></html>`);
		response.setHeader("content-type", "text/html");
		response.end(html);
	});
	await server.listen();
	origin = `http://127.0.0.1:${server.httpServer.address().port}`;
});
test.afterAll(async () => { await server?.close(); });

const task = (state, title = "Polling project", id = "task-1") => ({ id, kind: "generate", resource: "project:1", resourceTitle: title, state, fingerprint: "test", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" });
function gate() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
async function mount(page, handler) {
	await page.route("**/api/**", async route => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/events")) return route.fulfill({ contentType: "text/event-stream", body: 'event: log\ndata: {"sequence":1,"type":"succeeded","message":"Fixture event","createdAt":"2026-10-02T00:00:00Z"}\n\n' });
		if (path.startsWith("/api/tasks")) return handler(route, path);
		return route.fulfill({ status: 404, contentType: "application/json", body: '{"message":"No fixture route"}' });
	});
	await page.goto(`${origin}/__tasks_test__`);
}
async function painted(page) {
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("serializes healthy task polls with 2500 ms responses", async ({ page }) => {
	let started = 0, active = 0, maximumActive = 0;
	await mount(page, async route => {
		const revision = ++started;
		maximumActive = Math.max(maximumActive, ++active);
		try {
			await setTimeout(2500);
			await route.fulfill({ json: { tasks: [task(revision < 3 ? "running" : "succeeded", `Slow response ${revision}`)] } });
		} finally { --active; }
	});
	await expect(page.getByRole("heading", { name: "Slow response 1", exact: true })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Slow response 2", exact: true })).toBeVisible();
	await expect(page.locator(".task-row")).toContainText("已完成");
	expect(started).toBe(3);
	expect(maximumActive).toBe(1);
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

for (const kind of ["cancel", "retry"]) test(`keeps ${kind} responses ahead of slow in-flight polls and duplicate clicks`, async ({ page }) => {
	const action = gate(), secondPoll = gate(), secondReturned = gate();
	let current = task(kind === "cancel" ? "running" : "failed"), calls = 0, polls = 0;
	await mount(page, async (route, path) => {
		if (path.endsWith(`/${kind}`)) {
			++calls;
			await action.promise;
			current = task(kind === "cancel" ? "cancelled" : "queued", "Polling project", kind === "cancel" ? "task-1" : "task-2");
			return route.fulfill({ json: { task: current } });
		}
		const snapshot = current, revision = ++polls;
		if (revision > 1) {
			if (revision === 2) secondPoll.resolve();
			await setTimeout(2500);
		}
		await route.fulfill({ json: { tasks: [snapshot] } });
		if (revision === 2) secondReturned.resolve();
	});
	await page.locator(".task-row").click();
	const button = page.getByRole("button", { name: kind === "cancel" ? "取消任务" : "重试", exact: true });
	await button.click();
	await expect(button).toBeDisabled();
	await button.evaluate(element => element.click());
	await secondPoll.promise;
	action.resolve();
	const state = kind === "cancel" ? "已取消" : "等待中";
	await expect(page.getByRole("dialog").locator(".status-badge")).toHaveText(state);
	await secondReturned.promise;
	await painted(page);
	await expect(page.getByRole("dialog").locator(".status-badge")).toHaveText(state);
	expect(calls).toBe(1);
	await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("waits for the current poll before requesting the next task state", async ({ page }) => {
	const older = gate(), started = gate(), returned = gate();
	let polls = 0;
	await mount(page, async route => {
		const first = ++polls === 1;
		if (first) { started.resolve(); await older.promise; }
		await route.fulfill({ json: { tasks: [task(first ? "running" : "succeeded")] } });
		if (first) returned.resolve();
	});
	await started.promise;
	await setTimeout(2200);
	expect(polls).toBe(1);
	await expect(page.locator(".task-row")).toHaveCount(0);
	older.resolve();
	await returned.promise;
	await expect(page.locator(".task-row")).toContainText("进行中");
	await expect(page.locator(".task-row")).toContainText("已完成");
});

test("discards paused requests and resumes with a fresh task response", async ({ page }) => {
	const older = gate(), started = gate();
	let polls = 0;
	await mount(page, async route => {
		const first = ++polls === 1;
		if (first) { started.resolve(); await older.promise; }
		await route.fulfill({ json: { tasks: [task(first ? "running" : "succeeded")] } }).catch(() => {});
	});
	await started.promise;
	await page.locator("#pause").click();
	older.resolve();
	await painted(page);
	await expect(page.locator(".task-row")).toHaveCount(0);
	await page.locator("#pause").click();
	await expect(page.locator(".task-row")).toContainText("已完成");
	expect(polls).toBe(2);
});
