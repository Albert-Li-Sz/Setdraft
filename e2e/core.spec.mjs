import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { test, expect, setup, password, api, json, newProject, saved } from "./fixtures.mjs";
import { inspectZip, inspectPdf } from "./files.mjs";
import { defaultContestPdfOptions } from "@setdraft/contracts";

test("creates an administrator and synchronizes logout across tabs", async ({ page, context, app }) => {
	await setup(page, app);
	const other = await context.newPage();
	await other.goto(app.url);
	await expect(other.getByRole("button", { name: "新建题目", exact: true })).toBeVisible();
	await page.locator("summary").filter({ hasText: "e2e-admin" }).click();
	await page.getByRole("button", { name: "退出登录", exact: true }).click();
	await expect(other.getByRole("heading", { name: "登录 Setdraft" })).toBeVisible();
	await page.getByLabel("用户名", { exact: true }).fill("e2e-admin");
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(page.getByRole("button", { name: "新建题目", exact: true })).toBeVisible();
});

test("autosaves draft content and restores the session after refresh and server restart", async ({ page, app }) => {
	await setup(page, app);
	const project = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Saved A + B");
	await page.getByLabel("标签", { exact: true }).pressSequentially("dp, graphs, simulation");
	await expect(page.getByLabel("标签", { exact: true })).toHaveValue("dp, graphs, simulation");
	await saved(page, app, project.id, { tags: ["dp", "graphs", "simulation"] });
	await page.getByLabel("描述 · Markdown", { exact: true }).fill("求 $a+b$，保存 **原文**。");
	await saved(page, app, project.id, { title: "Saved A + B", statementSections: { description: "求 $a+b$，保存 **原文**。", input: "", output: "", interaction: "", notes: "" } });
	await page.reload();
	await page.locator(".sidebar-recents").getByRole("button", { name: "Saved A + B", exact: true }).click();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Saved A + B");
	await expect(page.getByLabel("描述 · Markdown", { exact: true })).toHaveValue("求 $a+b$，保存 **原文**。");
	await app.control("restart");
	await page.reload();
	await page.locator(".sidebar-recents").getByRole("button", { name: "Saved A + B", exact: true }).click();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Saved A + B");
	await app.control("expire");
	await page.reload();
	await expect(page.getByRole("heading", { name: "登录 Setdraft" })).toBeVisible();
	expect((await page.request.get(`${app.url}/api/projects`)).status()).toBe(401);
});

test("reloads server revisions, cases and contest catalogs when the same account reauthenticates", async ({ page, app }) => {
	await setup(page, app);
	const project = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Before reauthentication");
	await saved(page, app, project.id, { title: "Before reauthentication" });
	await page.goto(`${app.url}/#contests`);
	await expect(page.locator(".contest-sidebar")).toBeVisible();
	await json(page, app, "/contests", { method: "POST", data: { title: "Fresh server contest", slug: "reauth-contest" } });
	await json(page, app, `/projects/${project.id}`, { method: "PUT", data: { title: "Fresh server project" } });
	await json(page, app, `/projects/${project.id}/cases`, { method: "POST", data: { input: "1 2\n", output: "3\n" } });
	await app.control("expire");
	await page.goto(`${app.url}/#records`);
	await expect(page.getByRole("heading", { name: "重新登录", exact: true })).toBeVisible();
	await page.getByLabel("密码", { exact: true }).fill(password);
	await page.getByRole("button", { name: "登录", exact: true }).click();
	await expect(page.getByRole("button", { name: "新建题目", exact: true })).toBeVisible();
	await page.goto(`${app.url}/#workspace`);
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Fresh server project");
	await expect(page.locator("#authoring-tab-data")).toContainText("1");
	await page.getByLabel("描述 · Markdown", { exact: true }).fill("Saved after reauthentication");
	await saved(page, app, project.id, { title: "Fresh server project", statementSections: { description: "Saved after reauthentication", input: "", output: "", interaction: "", notes: "" } });
	await page.goto(`${app.url}/#contests`);
	await expect(page.getByRole("button", { name: /Fresh server contest/ })).toBeVisible();
});

test("ignores earlier project opens and abandoned creation callbacks", async ({ page, app }) => {
	await setup(page, app);
	const first = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("First project");
	await saved(page, app, first.id, { title: "First project" });
	const second = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Current project");
	await saved(page, app, second.id, { title: "Current project" });
	let release, arrived;
	const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
	await page.route(`**/api/projects/${first.id}`, async route => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
	await page.locator(".sidebar-recents").getByRole("button", { name: "First project", exact: true }).click();
	await pending;
	await page.locator(".sidebar-recents").getByRole("button", { name: "Current project", exact: true }).click();
	release();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Current project");
	let finish, requested;
	const creation = new Promise(resolve => { finish = resolve; }), creating = new Promise(resolve => { requested = resolve; });
	await page.route("**/api/projects", async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); requested(); await creation; await route.fulfill({ response }).catch(() => {}); });
	await page.getByRole("button", { name: "新建题目", exact: true }).click();
	await page.getByRole("dialog").getByRole("button", { name: /ACM/ }).click();
	await creating;
	await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click();
	finish();
	await expect(page.getByRole("dialog")).not.toBeVisible();
	await page.getByLabel("题目标题", { exact: true }).fill("Still the current project");
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Still the current project");
	await saved(page, app, second.id, { title: "Still the current project" });
	expect((await json(page, app, `/projects/${first.id}`)).title).toBe("First project");
});

test("reopens chat after interrupted initialization and keeps background replies alive", async ({ page, app }) => {
	await setup(page, app);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key" } });
	let release, arrived;
	const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
	await page.route("**/api/chats", async route => { if (route.request().method() !== "GET") return route.continue(); const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
	await page.goto(`${app.url}/#chat`);
	await pending;
	await expect(page.getByLabel("消息内容", { exact: true })).toBeDisabled();
	await page.goto(`${app.url}/#workspace`);
	release();
	await page.unroute("**/api/chats");
	await page.goto(`${app.url}/#chat`);
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_SLOW background reply");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByLabel("生成中", { exact: true })).toBeVisible();
	await page.goto(`${app.url}/#contests`);
	await app.control("release-ai");
	const chats = (await json(page, app, "/chats")).chats;
	await expect.poll(async () => (await json(page, app, `/chats/${chats[0].id}/requests`)).requests[0].state).toBe("done");
	await page.goto(`${app.url}/#chat`);
	await expect(page.locator(".manual-chat-markdown pre").last()).toContainText("int answer = 42;");
});

test("keeps the latest chat selection when an earlier open or create response arrives late", async ({ page, app }) => {
	await setup(page, app);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key" } });
	const conversations = [];
	for (const message of ["Alpha late", "Beta current"]) {
		const chat = await json(page, app, "/chats", { method: "POST" });
		const requestId = randomUUID();
		await json(page, app, `/chats/${chat.id}/messages`, { method: "POST", data: { message, requestId, attemptId: requestId } });
		await expect.poll(async () => (await json(page, app, `/chats/${chat.id}/requests/${requestId}`)).state).toBe("done");
		conversations.push(chat);
	}
	await page.goto(`${app.url}/#chat`);
	await expect(page.locator(".manual-chat-message.user")).toContainText("Beta current");
	let release, arrived;
	const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { arrived = resolve; });
	await page.route(`**/api/chats/${conversations[0].id}`, async route => { const response = await route.fetch(); arrived(); await gate; await route.fulfill({ response }).catch(() => {}); });
	await page.getByRole("button", { name: "Alpha late", exact: true }).click();
	await pending;
	await page.getByRole("button", { name: "Beta current", exact: true }).click();
	release();
	await expect(page.locator(".manual-chat-message.user")).toContainText("Beta current");
	await page.unroute(`**/api/chats/${conversations[0].id}`);
	let finish, created;
	const creation = new Promise(resolve => { finish = resolve; }), requested = new Promise(resolve => { created = resolve; });
	await page.route("**/api/chats", async route => { if (route.request().method() !== "POST") return route.continue(); const response = await route.fetch(); created(); await creation; await route.fulfill({ response }).catch(() => {}); });
	await page.locator(".chat-toolbar").getByRole("button", { name: "新建对话", exact: true }).click();
	await requested;
	await page.getByRole("button", { name: "Alpha late", exact: true }).click();
	finish();
	await expect(page.locator(".manual-chat-message.user")).toContainText("Alpha late");
});

test("persists final text and distinguishes refusal and incomplete replies after refresh", async ({ page, app }) => {
	await setup(page, app);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key" } });
	await page.goto(`${app.url}/#chat`);
	for (const input of ["FAUX_FINAL", "FAUX_REFUSAL"]) {
		await page.getByLabel("消息内容", { exact: true }).fill(input);
		await page.getByRole("button", { name: "发送", exact: true }).click();
		await expect(page.locator(".manual-chat-message.assistant").last()).toContainText(input === "FAUX_FINAL" ? "完整最终正文" : "模型拒绝文本");
		await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible();
	}
	await expect(page.getByText("输出已达上限，内容不完整。", { exact: true })).toBeVisible();
	await expect(page.getByText("模型拒绝了本次请求。", { exact: true })).toBeVisible();
	await page.reload();
	await expect(page.getByText("输出已达上限，内容不完整。", { exact: true })).toBeVisible();
	await expect(page.getByText("模型拒绝了本次请求。", { exact: true })).toBeVisible();
	const chat = (await json(page, app, "/chats")).chats[0];
	expect((await json(page, app, `/chats/${chat.id}`)).messages.filter(item => item.role === "assistant").map(item => [item.content, item.finishReason, item.complete])).toEqual([["完整最终正文", "length", false], ["模型拒绝文本", "refusal", true]]);
});

test("quickly switches projects without overwriting either server draft", async ({ page, app }) => {
	await setup(page, app);
	const first = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Alpha draft");
	await saved(page, app, first.id, { title: "Alpha draft" });
	const second = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Beta draft");
	await saved(page, app, second.id, { title: "Beta draft" });
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let arrived;
	const pending = new Promise(resolve => { arrived = resolve; });
	await page.route(`**/api/projects/${first.id}`, async route => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		arrived();
		await gate;
		await route.fulfill({ response }).catch(() => {});
	});
	await page.locator(".sidebar-recents").getByRole("button", { name: "Alpha draft", exact: true }).click();
	await pending;
	await page.locator(".sidebar-recents").getByRole("button", { name: "Beta draft", exact: true }).click();
	release();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("Beta draft");
	await page.getByLabel("描述 · Markdown", { exact: true }).fill("Beta stays here");
	await saved(page, app, second.id, { title: "Beta draft" });
	expect((await json(page, app, `/projects/${first.id}`)).statementSections.description).toBe("");
	await expect.poll(async () => (await json(page, app, `/projects/${second.id}`)).statementSections.description).toBe("Beta stays here");
});

test("isolates accounts, projects, files, releases and chats through real API authorization", async ({ page, browser, app }) => {
	await setup(page, app);
	const project = await newProject(page);
	await page.getByLabel("题目标题", { exact: true }).fill("Private admin draft");
	await saved(page, app, project.id, { title: "Private admin draft" });
	await json(page, app, `/projects/${project.id}/files/1.in`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, data: "1 2\n" });
	const chat = await json(page, app, "/chats", { method: "POST" });
	const session = await json(page, app, "/auth/session");
	const release = await app.control("seed-release", { userId: session.user.id });
	const account = await json(page, app, "/admin/users", { method: "POST", data: { username: "e2e-other" } });
	const otherContext = await browser.newContext();
	try {
		const other = await otherContext.newPage();
		await other.goto(app.url);
		await other.getByLabel("用户名", { exact: true }).fill("e2e-other");
		await other.getByLabel("密码", { exact: true }).fill(account.temporaryPassword);
		await other.getByRole("button", { name: "登录", exact: true }).click();
		await other.getByLabel("临时密码", { exact: true }).fill(account.temporaryPassword);
		await other.getByLabel("新密码", { exact: true }).fill(password);
		await other.getByRole("button", { name: "保存密码", exact: true }).click();
		await expect(other.getByRole("button", { name: "新建题目", exact: true })).toBeVisible();
		expect((await json(other, app, "/projects")).projects).toEqual([]);
		for (const path of [`/projects/${project.id}`, `/projects/${project.id}/files/1.in`, `/chats/${chat.id}`, `/releases/${release.id}/hydro`])
			expect((await api(other, app, path)).status()).toBe(404);
		expect((await api(other, app, `/projects/${project.id}`, { method: "PUT", data: { title: "Intrusion" } })).status()).toBe(404);
		const own = await newProject(other);
		await other.getByLabel("题目标题", { exact: true }).fill("Other account draft");
		await saved(other, app, own.id, { title: "Other account draft" });
		expect((await api(page, app, `/projects/${own.id}`)).status()).toBe(404);
		expect((await json(page, app, `/projects/${project.id}`)).title).toBe("Private admin draft");
	} finally { await otherContext.close(); }
});

test("previews an attachment using document-wide definitions, decoded URLs and intact source", async ({ page, app }) => {
	await setup(page, app);
	const project = await newProject(page);
	await page.locator(".manual-side-card").filter({ has: page.getByRole("heading", { name: "题面附件", exact: true }) }).locator('input[type="file"]').setInputFiles("fixtures/hydro/a-plus-b/hydro/a-plus-b/additional_file/addition.svg");
	await expect(page.getByRole("button", { name: "复制引用 addition.svg" })).toBeVisible();
	await page.getByRole("dialog", { name: "文件处理完成" }).getByRole("button", { name: "关闭", exact: true }).click();
	await expect(page.getByRole("dialog", { name: "文件处理完成" })).not.toBeVisible();
	await expect.poll(async () => (await json(page, app, `/projects/${project.id}`)).attachments.map(item => item.name)).toEqual(["addition.svg"]);
	const source = "![共享附件][figure]\n\n```md\n![代码](file://missing.png)\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n$a+b$";
	// Clicking waits for the closing modal to stop intercepting focus.
	await page.getByLabel("描述 · Markdown", { exact: true }).click();
	await page.getByLabel("描述 · Markdown", { exact: true }).fill(source);
	await expect(page.getByLabel("描述 · Markdown", { exact: true })).toHaveValue(source);
	await page.getByRole("tab", { name: "提示", exact: true }).click();
	await page.getByLabel("提示 · Markdown", { exact: true }).fill("[figure]: FILE&#58;//addition.svg?version=1#figure");
	await expect(page.getByRole("img", { name: "共享附件", exact: true })).toHaveAttribute("src", /^data:image\/svg\+xml;base64,/);
	await expect(page.locator(".problem-preview table")).toBeVisible();
	await expect.poll(async () => (await json(page, app, `/projects/${project.id}`)).statementSections.description).toBe(source);
});

test("streams faux AI, renders code, persists replies and retries failures and cancellations", async ({ page, app }) => {
	await setup(page, app);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key", contextWindow: 8192, maxTokens: 1024 } });
	await page.goto(`${app.url}/#chat`);
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_SLOW show a stream");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByLabel("生成中", { exact: true })).toBeVisible();
	await expect(page.locator(".manual-chat-markdown").last()).toContainText("测试回复：");
	await expect(page.getByRole("button", { name: "停止生成", exact: true })).toBeVisible();
	await app.control("release-ai");
	await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible();
	await expect(page.locator(".manual-chat-markdown pre").last()).toContainText("int answer = 42;");
	const chats = (await json(page, app, "/chats")).chats;
	expect((await json(page, app, `/chats/${chats[0].id}`)).messages.at(-1).content).toContain("int answer = 42;");
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_FAIL_ONCE retry this");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.getByRole("button", { name: "重试并续接", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "重试并续接", exact: true }).click();
	await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible();
	await expect.poll(async () => (await json(page, app, `/chats/${chats[0].id}/requests`)).requests[0].state).toBe("done");
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_SLOW cancel this");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await page.getByRole("button", { name: "停止生成", exact: true }).click();
	await expect.poll(async () => (await json(page, app, `/chats/${chats[0].id}/requests`)).requests[0].state).toBe("failed");
	await page.reload();
	await expect(page.locator(".manual-chat-markdown pre").first()).toContainText("int answer = 42;");
});

test("keeps the reading position while long streamed prose, code and tables finish", async ({ page, app }) => {
	await setup(page, app);
	await json(page, app, "/ai/config", { method: "PUT", data: { provider: "openai-completions", modelId: "faux-model", apiKey: "faux-key" } });
	await page.goto(`${app.url}/#chat`);
	await page.getByLabel("消息内容", { exact: true }).fill("FAUX_LAYOUT FAUX_SLOW");
	await page.getByRole("button", { name: "发送", exact: true }).click();
	await expect(page.locator(".manual-chat-markdown pre").last()).toContainText("payload");
	const messages = page.locator(".manual-chat-messages");
	await expect.poll(() => messages.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
	await messages.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event("scroll", { bubbles: true })); });
	await expect.poll(() => messages.evaluate(element => element.scrollTop)).toBe(100);
	await app.control("release-ai");
	await expect(page.getByRole("button", { name: "停止生成", exact: true })).not.toBeVisible();
	await expect(page.locator(".manual-chat-markdown").last()).toContainText("LAYOUT_END");
	expect(await messages.evaluate(element => element.scrollTop)).toBe(100);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
	expect(await page.locator(".manual-chat-markdown pre").last().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	await page.setViewportSize({ width: 375, height: 800 });
	await expect.poll(() => page.locator(".manual-chat-markdown table").last().evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
	expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("searches guide chapters and follows the matching navigation", async ({ page, app }) => {
	await setup(page, app);
	await page.goto(`${app.url}/#authoring-guide`);
	await expect(page.getByRole("heading", { name: "出题文档", exact: true })).toBeVisible();
	await page.getByLabel("搜索文档", { exact: true }).fill("PDF");
	await expect(page.locator(".authoring-guide-count")).toContainText("找到");
	await page.getByRole("navigation", { name: "文档目录" }).getByRole("button").last().click();
	await expect(page.locator(".authoring-guide-content section:focus")).toBeVisible();
	await page.getByLabel("搜索文档", { exact: true }).fill("NoSuchChapter12345");
	await expect(page.getByText("未找到匹配章节。", { exact: true })).toBeVisible();
});

test("downloads a fixed Hydro package and compiles, previews and downloads a real PDF", async ({ page, app }, testInfo) => {
	await setup(page, app);
	const session = await json(page, app, "/auth/session");
	const release = await app.control("seed-release", { userId: session.user.id });
	await page.reload();
	await page.locator(".sidebar-recents").getByRole("button", { name: "A + B", exact: true }).click();
	await page.getByRole("tab", { name: "发布包", exact: true }).click();
	const downloading = page.waitForEvent("download");
	await page.getByRole("link", { name: "Hydro 包", exact: true }).click();
	const download = await downloading;
	const zipPath = testInfo.outputPath(download.suggestedFilename());
	await download.saveAs(zipPath);
	const zip = inspectZip(await readFile(zipPath));
	expect(zip.get("a-plus-b/testdata/1.in").toString()).toBe("1 2\n");
	expect(zip.get("a-plus-b/testdata/1.out").toString()).toBe("3\n");
	expect(zip.get("a-plus-b/problem_zh.md").toString()).toContain("file://addition.svg");
	expect([...zip.keys()].some(name => name.includes("reference"))).toBeFalsy();
	const draft = await json(page, app, "/contests", { method: "POST", data: { title: "Browser PDF Contest", slug: "browser-pdf", pdf: { ...defaultContestPdfOptions, enabled: true } } });
	await json(page, app, `/contests/${draft.id}`, { method: "PUT", data: { ...draft, expectedRevision: draft.revision, releaseIds: [release.id] } });
	await page.goto(`${app.url}/#contests`);
	await page.getByRole("button", { name: /Browser PDF Contest/ }).click();
	await page.getByRole("button", { name: "预览题册", exact: true }).click();
	await expect(page.getByRole("img", { name: "PDF 第 1 页" })).toBeVisible({ timeout: 30_000 });
	const pdfDownload = page.waitForEvent("download");
	await page.getByRole("link", { name: "下载 PDF", exact: true }).click();
	const pdf = await pdfDownload;
	const pdfPath = testInfo.outputPath(pdf.suggestedFilename());
	await pdf.saveAs(pdfPath);
	await inspectPdf(pdfPath, ["Browser PDF Contest", "A + B"], testInfo);
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	await expect(page.getByRole("img", { name: "PDF 第 2 页" })).toBeVisible();
	await page.getByRole("img", { name: "PDF 第 2 页" }).screenshot({ path: testInfo.outputPath("pdf-preview-page-2.png") });
});


test("retains image and text drafts when the first chat message is rejected before admission", async ({ page, app }) => {
 await setup(page, app);
 await json(page, app, "/ai/config", {method:"PUT",data:{provider:"openai-completions",modelId:"faux-model",apiKey:"faux-key",contextWindow:8192,maxTokens:1024}});
 await page.goto(`${app.url}/#chat`);
 await page.getByLabel("消息内容",{exact:true}).fill("image draft");
 await page.locator('input[type="file"].manual-chat-upload-input').setInputFiles({name:"draft.png",mimeType:"image/png",buffer:Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6YQAAAAASUVORK5CYII=","base64")});
 await expect(page.locator(".manual-chat-pending-image")).toHaveCount(1);
 await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
 await page.route("**/api/chats/*/messages",route=>route.fulfill({status:422,contentType:"application/json",body:JSON.stringify({message:"admission rejected"})}));
 await page.getByRole("button",{name:"发送",exact:true}).click();
 await page.getByRole("dialog").getByRole("button",{name:"关闭",exact:true}).click();
 await expect(page.getByLabel("消息内容",{exact:true})).toHaveValue("image draft");
 await expect(page.locator(".manual-chat-pending-image")).toHaveCount(1);
 await expect(page.getByRole("button",{name:"发送",exact:true})).toBeEnabled();
 await page.unroute("**/api/chats/*/messages");
 await page.getByRole("button",{name:"发送",exact:true}).click();
 await expect(page.locator(".manual-chat-message.assistant")).toContainText("测试回复");
 await expect(page.locator(".manual-chat-pending-image")).toHaveCount(0);
 const chat=(await json(page,app,"/chats")).chats[0];const conversation=await json(page,app,`/chats/${chat.id}`);
 expect(conversation.messages[0].images).toHaveLength(1);
});
