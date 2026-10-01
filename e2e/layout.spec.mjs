import { test, expect, setup, json, newProject } from "./fixtures.mjs";

async function overflow(page) {
	const size = await page.evaluate(() => {
		const root = document.documentElement, main = document.querySelector(".shell-main");
		const offenders = [...main.querySelectorAll("*")].filter(element => { const r = element.getBoundingClientRect(); return r.width && r.right > main.getBoundingClientRect().right + 1 && !element.closest("dialog, .tabs, .statement-tabs, .manual-program-menu, .cm-scroller"); }).slice(0, 8).map(element => ({ element: `${element.tagName}.${element.className}`, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right }));
		return { document: root.scrollWidth - root.clientWidth, main: main.scrollWidth - main.clientWidth, offenders };
	});
	expect(size.document).toBeLessThanOrEqual(1);
	expect(size.main, JSON.stringify(size.offenders)).toBeLessThanOrEqual(1);
}
async function frame(page, testInfo, key) {
	await expect(page.locator("#workspace")).toBeVisible();
	await expect.poll(() => page.locator(".manual-layout").getAttribute("data-compact")).toBeTruthy();
	const before = await page.locator(".workspace-card").boundingBox();
	for (const tab of ["statement", "generator", "programs", "validation", "releases"]) {
		await page.locator(`#authoring-tab-${tab}`).click();
		await expect(page.locator(`#authoring-panel-${tab}`)).toBeVisible();
		await overflow(page);
		if (await page.locator(".manual-layout").getAttribute("data-compact") === "false" && page.viewportSize().height > 650) {
			const card = await page.locator(".workspace-card").boundingBox(), runtime = await page.locator(".manual-runtime").boundingBox();
			expect(Math.abs(card.y + card.height - runtime.y - runtime.height), key).toBeLessThanOrEqual(2);
			expect(Math.abs(card.height - before.height), key).toBeLessThanOrEqual(2);
			if (["generator", "programs"].includes(tab)) expect((await page.locator(".cm-editor").first().boundingBox()).height).toBeGreaterThan(120);
		}
	}
	await page.locator("#authoring-tab-statement").click();
	if (key.includes("1920-1-zh-open")) {
		const separator = page.locator(".editor-resizer");
		await expect(separator).toHaveAttribute("aria-valuenow", "50");
		await separator.focus();
		await page.keyboard.press("ArrowRight");
		await expect(separator).toHaveAttribute("aria-valuenow", "52");
		const divider = await separator.boundingBox(), grid = await page.locator(".statement-split .editor-grid").boundingBox();
		await page.mouse.move(divider.x + divider.width / 2, divider.y + 30);
		await page.mouse.down();
		await page.mouse.move(grid.x + grid.width * .6, divider.y + 30);
		await page.mouse.up();
		await expect(separator).toHaveAttribute("aria-valuenow", "60");
		await separator.dblclick();
		await expect(separator).toHaveAttribute("aria-valuenow", "50");
		await page.screenshot({ path: testInfo.outputPath("workspace-1920.png") });
	}
}

for (const full of [false, true]) test(full ? "responsive matrix 320–3840, DPR 1/2, Chinese/English, navigation open/closed @layout-full" : "responsive workspace, contests and chat at mobile and desktop sizes", async ({ page, browser, app }, testInfo) => {
	test.setTimeout(full ? 360_000 : 180_000);
	await setup(page, app);
	const project = await newProject(page);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key" } });
	const session = await json(page, app, "/auth/session");
	const release = await app.control("seed-release", { userId: session.user.id });
	await json(page, app, `/releases/${release.id}`, { method: "PATCH", data: { name: "Published A + B with a deliberately long version name to verify alignment" } });
	const contest = await json(page, app, "/contests", { method: "POST", data: { title: "Alignment contest with a long title", slug: "layout-contest" } });
	await json(page, app, `/contests/${contest.id}`, { method: "PUT", data: { ...contest, expectedRevision: contest.revision, releaseIds: [release.id] } });
	await page.goto(`${app.url}/#chat`);
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_LAYOUT");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".manual-chat-markdown").last()).toContainText("LAYOUT_END");
	const state = await page.context().storageState();
	const records = [];
	for (const dpr of full ? [1, 2] : [1]) for (const language of full ? ["zh", "en"] : ["zh"]) {
		const context = await browser.newContext({ storageState: state, deviceScaleFactor: dpr, reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
		const current = await context.newPage();
		try {
			await current.goto(`${app.url}/#workspace`);
			await current.locator(".sidebar-recents button").first().click();
			await expect(current.locator("#workspace")).toBeVisible();
			await current.locator(`.locale-switcher button[lang="${language === "zh" ? "zh-CN" : "en"}"]`).click();
			for (const width of full ? [320, 375, 768, 1024, 1280, 1920, 2560, 3840] : [320, 768, 1920]) {
				await current.setViewportSize({ width, height: width < 800 ? 800 : 1080 });
				for (const navigation of ["open", "closed"]) {
					const toggle = current.locator(".sidebar-toggle");
					const expanded = await toggle.getAttribute("aria-expanded");
					if ((expanded === "true") !== (navigation === "open")) await toggle.click();
					await overflow(current);
					// Mobile navigation is an overlay. Close it before exercising the content.
					if (await current.locator("dialog.app-sidebar").isVisible()) {
						await current.keyboard.press("Escape");
						await expect(current.locator("dialog.app-sidebar")).not.toBeVisible();
					}
					await current.goto(`${app.url}/#workspace`);
					await frame(current, testInfo, `${width}-${dpr}-${language}-${navigation}`);
					if (await current.locator(".manual-layout").getAttribute("data-compact") === "true") {
						await current.locator("#workspace > .page-heading button").first().click();
						await expect(current.locator(".workspace-settings-drawer")).toBeVisible();
						await current.locator(".workspace-settings-drawer .confirmation-heading button").click();
					}
					await current.goto(`${app.url}/#contests`);
					await current.locator(".contest-list button").first().click();
					await expect(current.locator(".contest-main")).toBeVisible();
					await overflow(current);
					await current.goto(`${app.url}/#chat`);
					await expect(current.locator(".manual-chat-composer")).toBeVisible();
					const toolbar = await current.locator(".chat-toolbar").boundingBox(), composer = await current.locator(".manual-chat-composer").boundingBox();
					expect(Math.abs(toolbar.x - composer.x)).toBeLessThanOrEqual(2);
					expect(Math.abs(toolbar.width - composer.width)).toBeLessThanOrEqual(2);
					expect(composer.width).toBeLessThanOrEqual(1120);
					await current.locator(".chat-toolbar .button").first().click();
					await expect(current.locator("#chat")).toHaveAttribute("data-wide", "true");
					const wide = await current.locator(".manual-chat-composer").boundingBox();
					expect(wide.width).toBeLessThanOrEqual(1600);
					expect(wide.width).toBeGreaterThanOrEqual(composer.width);
					await current.locator(".chat-toolbar .button").first().click();
					await expect(current.locator("#chat")).toHaveAttribute("data-wide", "false");
					await overflow(current);
					records.push({ width, dpr, language, navigation, chatWidth: composer.width, wideChatWidth: wide.width });
				}
			}
			if (full) for (const width of [1280, 1920]) {
				await current.setViewportSize({ width, height: 600 });
				await current.goto(`${app.url}/#workspace`);
				await expect(current.locator("#workspace")).toHaveAttribute("data-natural-flow", "true");
				await frame(current, testInfo, `${width}-600-${dpr}-${language}`);
				records.push({ width, height: 600, dpr, language, naturalFlow: true });
			}
		} finally { await context.close(); }
	}
	expect((await json(page, app, `/projects/${project.id}`)).id).toBe(project.id);
	await testInfo.attach("layout-matrix.json", { body: Buffer.from(JSON.stringify(records, null, 2)), contentType: "application/json" });
});
