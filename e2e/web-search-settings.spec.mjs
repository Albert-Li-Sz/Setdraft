import { test, expect, setup } from "./fixtures.mjs";

test("keeps search provider settings stable during diagnostics and saving", async ({ page, app }, testInfo) => {
	const health = {
		status: "healthy", checkedAt: "2026-10-18T00:00:00.000Z", durationMs: 12,
		candidateCount: 10, acceptedCount: 10, engines: [],
	};
	const configuration = {
		enabled: true, provider: "tavily", dailyLimit: 20,
		available: true, apiKeyConfigured: true, health,
	};
	const diagnosticGate = Promise.withResolvers(), diagnosticStarted = Promise.withResolvers();
	const saveGate = Promise.withResolvers(), saveStarted = Promise.withResolvers();
	await page.route("**/api/ai/search", async route => {
		if (route.request().method() === "GET") return route.fulfill({ json: configuration });
		expect(route.request().method()).toBe("PUT");
		const submitted = route.request().postDataJSON();
		saveStarted.resolve(submitted);
		await saveGate.promise;
		await route.fulfill({ json: { ...configuration, provider: submitted.provider, dailyLimit: submitted.dailyLimit, health: undefined } });
	});
	await page.route("**/api/ai/search/diagnostics", async route => {
		diagnosticStarted.resolve(route.request().postDataJSON());
		await diagnosticGate.promise;
		await route.fulfill({ json: { provider: "tavily", language: "zh", aggregate: health, engines: [{ name: "Tavily", diagnostics: health }] } });
	});
	try {
		await setup(page, app);
		await page.goto(`${app.url}/#admin`);
		const card = page.locator(".search-settings-card");
		const provider = card.getByRole("combobox", { name: "搜索服务", exact: true });
		const apiKey = card.getByLabel("API Key", { exact: true });
		const enabled = card.getByLabel("启用联网搜索", { exact: true });
		const dailyLimit = card.getByLabel("每人每日搜索次数", { exact: true });
		const diagnostic = card.getByRole("button", { name: "中文诊断", exact: true });
		const readiness = card.locator("form > .settings-help");
		await expect(provider).toHaveValue("tavily");
		await expect(readiness).toContainText("搜索健康");
		await diagnostic.click();
		expect(await diagnosticStarted.promise).toEqual({ language: "zh" });
		for (const control of [provider, apiKey, enabled, dailyLimit]) await expect(control).toBeDisabled();
		diagnosticGate.resolve();
		await expect(card.locator(".search-diagnostics")).toContainText("Tavily");
		for (const control of [provider, apiKey, enabled, dailyLimit]) await expect(control).toBeEnabled();
		await provider.selectOption("deepseek");
		await expect(apiKey).toBeEmpty();
		await expect(apiKey).toHaveAttribute("placeholder", "sk-…");
		await expect(card.locator(".search-diagnostics")).toHaveCount(0);
		await expect(readiness).toHaveText("配置未就绪");
		await expect(diagnostic).toBeDisabled();
		await apiKey.fill("faux-search-key");
		await dailyLimit.fill("77");
		await card.getByRole("button", { name: "保存", exact: true }).click();
		expect(await saveStarted.promise).toMatchObject({ provider: "deepseek", apiKey: "faux-search-key", dailyLimit: 77 });
		for (const control of [provider, apiKey, enabled, dailyLimit]) await expect(control).toBeDisabled();
		saveGate.resolve();
		await expect(card.getByText("搜索配置已保存。", { exact: true })).toBeVisible();
		await expect(provider).toHaveValue("deepseek");
		await expect(apiKey).toBeEmpty();
		await expect(apiKey).toHaveAttribute("placeholder", "已配置，留空保留");
		await expect(dailyLimit).toHaveValue("77");
		for (const control of [provider, apiKey, enabled, dailyLimit, diagnostic]) await expect(control).toBeEnabled();
		await card.screenshot({ path: testInfo.outputPath("search-settings-saved.png") });
	} finally {
		diagnosticGate.resolve();
		saveGate.resolve();
		await page.unrouteAll({ behavior: "wait" });
	}
});
