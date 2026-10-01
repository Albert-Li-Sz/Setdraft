import { test, expect, setup, json } from "./fixtures.mjs";

for (const rejectCreation of [false, true]) {
	test(`preserves independent catalogs while initial GETs race with ${rejectCreation ? "failed" : "successful"} contest creation`, async ({ page, app }) => {
		await setup(page, app);
		const session = await json(page, app, "/auth/session");
		const release = await app.control("seed-release", { userId: session.user.id });
		const contest = await json(page, app, "/contests", { method: "POST", data: { title: "Existing contest", slug: "existing-contest" } });
		await json(page, app, `/contests/${contest.id}`, { method: "PUT", data: { ...contest, expectedRevision: contest.revision, releaseIds: [release.id] } });
		const accepted = await json(page, app, `/contests/${contest.id}/export`, { method: "POST", data: { format: "hydro", name: "Existing historical bundle" } });
		await expect.poll(async () => (await json(page, app, `/tasks/${accepted.task.id}`)).state).toBe("succeeded");

		let unblock;
		const gate = new Promise(resolve => { unblock = resolve; });
		let captured = 0;
		for (const path of ["contests", "releases", "contest-releases"]) {
			let first = true;
			await page.route(`**/api/${path}`, async route => {
				if (route.request().method() !== "GET" || !first) return route.continue();
				first = false;
				const response = await route.fetch();
				captured++;
				await gate;
				await route.fulfill({ response }).catch(() => {});
			});
		}
		if (rejectCreation) await page.route("**/api/contests", async route => {
			if (route.request().method() !== "POST") return route.fallback();
			await route.fulfill({ status: 500, json: { message: "CREATE_REJECTED" } });
		});
		try {
			await page.goto(`${app.url}/#contests`);
			await expect.poll(() => captured).toBe(3);
			await page.getByRole("button", { name: "新建竞赛", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("竞赛名称", { exact: true }).fill("New contest");
			await dialog.getByLabel("目录标识", { exact: true }).fill("new-contest");
			await dialog.getByRole("button", { name: "创建竞赛", exact: true }).click();
			if (rejectCreation) {
				await expect(page.locator(".notice")).toContainText("CREATE_REJECTED");
				await dialog.getByRole("button", { name: "取消", exact: true }).click();
			} else await expect(page.getByRole("heading", { name: "New contest", exact: true })).toBeVisible();
			unblock();
			const existing = page.locator(".contest-sidebar").getByRole("button", { name: /Existing contest/ });
			await expect(existing).toBeVisible();
			if (!rejectCreation) await expect(page.locator(".contest-sidebar").getByRole("button", { name: /New contest/ })).toBeVisible();
			await existing.click();
			await expect(page.getByLabel("选择已验证题目").locator("option")).toHaveCount(1);
			await expect(page.locator(".history-table")).toContainText("A + B");
			await page.getByRole("button", { name: /^历史竞赛包/ }).click();
			await expect(page.getByRole("dialog")).toContainText("Existing historical bundle");
		} finally { unblock(); }
	});
}
