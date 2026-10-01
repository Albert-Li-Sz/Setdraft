import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	testMatch: "**/*.spec.mjs",
	grepInvert: process.env.SETDRAFT_E2E_FULL === "1" ? undefined : /@sandbox|@layout-full/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	forbidOnly: Boolean(process.env.CI),
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		actionTimeout: 30_000,
		...devices["Desktop Chrome"],
		locale: "zh-CN",
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
