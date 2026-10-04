import { setTimeout } from "node:timers/promises";
import { test, expect, setup } from "./fixtures.mjs";

for (const lateError of [false, true]) {
	test(`task polling serializes a delayed ${lateError ? "error" : "running state"} and recovers on the next response`, async ({ page, app }) => {
		await setup(page, app);
		const task = { id: "polling-task", kind: "generate", resource: "project:polling", resourceTitle: "Polling regression", fingerprint: "test", createdAt: "2026-10-02T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z" };
		let unblock, captured;
		const gate = new Promise(resolve => { unblock = resolve; }), pending = new Promise(resolve => { captured = resolve; });
		let requests = 0;
		await page.route("**/api/tasks", async route => {
			const ordinal = requests++;
			if (lateError && ordinal === 0) return route.fulfill({ status: 500, json: { message: "TEMPORARY_POLL_ERROR" } });
			if (ordinal === (lateError ? 1 : 0)) {
				captured(); await gate;
				await route.fulfill({ status: lateError ? 500 : 200, headers: { "x-test-late": "1" }, json: lateError ? { message: "OLD_POLL_ERROR" } : { tasks: [{ ...task, state: "running" }] } }).catch(() => {});
			} else await route.fulfill({ json: { tasks: [{ ...task, state: "succeeded" }] } });
		});
		try {
			await page.goto(`${app.url}/#tasks`);
			if (lateError) await expect(page.getByRole("alert")).toContainText("TEMPORARY_POLL_ERROR");
			await pending;
			const badge = page.locator(".task-row .status-badge");
			await setTimeout(2200);
			expect(requests).toBe(lateError ? 2 : 1);
			await expect(badge).toHaveCount(0);
			const response = page.waitForResponse(result => result.headers()["x-test-late"] === "1");
			unblock(); await (await response).finished();
			if (lateError) await expect(page.getByRole("alert")).toContainText("OLD_POLL_ERROR");
			else await expect(badge).toHaveText("进行中");
			await expect(badge).toHaveText("已完成");
			await expect(page.getByRole("alert")).toHaveCount(0);
		} finally { unblock(); await page.unrouteAll({ behavior: "ignoreErrors" }); }
	});
}
