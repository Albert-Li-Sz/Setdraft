import { readFile, writeFile } from "node:fs/promises";
import { defaultContestPdfOptions } from "@setdraft/contracts";
import { test, expect, setup, newProject, json, api } from "./fixtures.mjs";
import { inspectZip, inspectPdf } from "./files.mjs";

const reference = await readFile("fixtures/hydro/a-plus-b/authoring/reference.cc", "utf8");
const generator = '#include "testlib.h"\n#include <cstdio>\nint main(int argc,char**argv){registerGen(argc,argv,1);printf("%s %s\\n",argv[1],argv[2]);}';
const validator = '#include "testlib.h"\nint main(int argc,char**argv){registerValidation(argc,argv);inf.readInt(-1000000,1000000);inf.readSpace();inf.readInt(-1000000,1000000);inf.readEoln();inf.readEof();}';

async function prepare(page, app, overrides = {}) {
	const project = await newProject(page);
	await json(page, app, `/projects/${project.id}`, { method: "PUT", data: {
		title: "A + B E2E", slug: "a-plus-b-e2e", checkerMode: "text",
		statementSections: { description: "给定两个整数，求 $a+b$。\n\n![加法][figure]\n\n| a | b |\n| - | - |\n| 1 | 2 |", input: "一行两个整数。", output: "输出和。", interaction: "", notes: "[figure]: FILE&#58;//addition.svg?version=1#figure\n\n保留 **Markdown**。" },
		attachments: [{ name: "addition.svg", contentBase64: (await readFile("fixtures/hydro/a-plus-b/hydro/a-plus-b/additional_file/addition.svg")).toString("base64") }],
		samples: [{ input: "1 2\n", output: "3\n" }],
		reference: { language: "cpp17", code: reference }, oracle: { language: "python3", code: "a,b=map(int,input().split());print(a+b)" },
		generatorSource: generator, generatorScript: "gen 5 6\ngen 7 8", validatorSource: validator, ...overrides,
	} });
	await json(page, app, `/projects/${project.id}/cases`, { method: "POST", data: { input: "1 2\n" } });
	await page.reload();
	await page.locator(".sidebar-recents").getByRole("button", { name: "A + B E2E", exact: true }).click();
	await expect(page.getByLabel("题目标题", { exact: true })).toHaveValue("A + B E2E");
	return project;
}
async function waitTask(page, app, id) {
	let result;
	await expect.poll(async () => { result = await json(page, app, `/tasks/${id}`); return ["queued", "running"].includes(result.state) ? "pending" : "finished"; }, { timeout: 180_000 }).toBe("finished");
	return result;
}
async function download(page, locator, testInfo) {
	const waiting = page.waitForEvent("download");
	await locator.click();
	const file = await waiting;
	const path = testInfo.outputPath(file.suggestedFilename());
	await file.saveAs(path);
	return path;
}

test("@sandbox generates, validates and publishes A+B, downloads Hydro/DOMjudge and exports contest PDFs", async ({ page, app }, testInfo) => {
	test.setTimeout(300_000);
	await setup(page, app);
	const project = await prepare(page, app);
	await page.getByRole("tab", { name: "Gen 生成", exact: true }).click();
	const generation = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/generate`) && response.request().method() === "POST");
	await page.getByRole("button", { name: "生成并验证", exact: true }).click();
	const generated = await waitTask(page, app, (await (await generation).json()).task.id);
	expect(generated.state, generated.error).toBe("succeeded");
	expect(generated.result.report).toMatchObject({ success: true, generatedCount: 2, oracleCount: 2, validatorUsed: true, checkerUsed: true });
	await expect(page.getByRole("button", { name: "生成并验证", exact: true })).toBeEnabled();
	const savedSource = (await json(page, app, `/projects/${project.id}`)).statementSections;
	await page.getByRole("button", { name: "验证并打包", exact: true }).click();
	await page.getByLabel("发布包名称", { exact: true }).fill("Browser verified A+B");
	const finalizing = page.waitForResponse(response => response.url().endsWith(`/projects/${project.id}/finalize`) && response.request().method() === "POST");
	await page.getByRole("button", { name: "开始验证", exact: true }).click();
	const finalized = await waitTask(page, app, (await (await finalizing).json()).task.id);
	expect(finalized.state, finalized.error).toBe("succeeded");
	expect(finalized.result.report).toMatchObject({ success: true, caseCount: 3, validatorUsed: true, checkerUsed: true });
	expect(finalized.result.report.checks.some(check => check.stage === "sample" && check.passed)).toBeTruthy();
	const release = finalized.result.release;
	expect(release.id).toBeTruthy();
	const hydroPath = await download(page, page.getByRole("link", { name: "下载 Hydro 包", exact: true }).first(), testInfo);
	const hydro = inspectZip(await readFile(hydroPath));
	for (const [number, input, output] of [[1, "1 2\n", "3\n"], [2, "5 6\n", "11\n"], [3, "7 8\n", "15\n"]]) {
		expect(hydro.get(`a-plus-b-e2e/testdata/${number}.in`).toString()).toBe(input);
		expect(hydro.get(`a-plus-b-e2e/testdata/${number}.out`).toString()).toBe(output);
	}
	expect(hydro.get("a-plus-b-e2e/testdata/config.yaml").toString()).toContain("testlib");
	expect(hydro.has("a-plus-b-e2e/additional_file/addition.svg")).toBeTruthy();
	expect(hydro.get("a-plus-b-e2e/problem_zh.md").toString()).toContain("FILE&#58;//addition.svg?version=1#figure");
	expect([...hydro.keys()].some(name => name.includes("reference"))).toBeFalsy();
	await page.getByRole("tab", { name: "发布包", exact: true }).click();
	const domjudgePath = await download(page, page.getByRole("button", { name: "DOMjudge", exact: true }), testInfo);
	const domjudge = inspectZip(await readFile(domjudgePath));
	expect(domjudge.has("domjudge-problem.ini")).toBeTruthy();
	for (const [name, text] of [["data/secret/002.in", "5 6\n"], ["data/secret/002.ans", "11\n"]])
		expect(domjudge.get(name)?.toString()).toBe(text);
	const contest = await json(page, app, "/contests", { method: "POST", data: { title: "E2E Sandbox Contest", slug: "sandbox-contest", pdf: { ...defaultContestPdfOptions, enabled: true } } });
	await json(page, app, `/contests/${contest.id}`, { method: "PUT", data: { ...contest, expectedRevision: contest.revision, releaseIds: [release.id] } });
	await page.goto(`${app.url}/#contests`);
	await page.getByRole("button", { name: /E2E Sandbox Contest/ }).click();
	const exporting = page.waitForResponse(response => response.url().endsWith(`/contests/${contest.id}/export`) && response.request().method() === "POST");
	await page.getByRole("button", { name: "导出 DOMjudge 竞赛包", exact: true }).click();
	await page.getByLabel("竞赛包日志名称", { exact: true }).fill("E2E contest bundle");
	await page.getByRole("button", { name: "生成竞赛包", exact: true }).click();
	const exported = await waitTask(page, app, (await (await exporting).json()).task.id);
	expect(exported.state, exported.error).toBe("succeeded");
	const response = await api(page, app, `/contest-releases/${exported.result.id}/download`);
	expect(response.status()).toBe(200);
	const bundle = inspectZip(await response.body());
	const booklet = [...bundle].find(([name]) => name.endsWith("/booklet.pdf"));
	expect(booklet?.[1].subarray(0, 5).toString()).toBe("%PDF-");
	const pdfPath = testInfo.outputPath("contest-booklet.pdf");
	await writeFile(pdfPath, booklet[1]);
	await inspectPdf(pdfPath, ["E2E Sandbox Contest", "A + B E2E", "输出和"], testInfo);
	await page.getByRole("dialog", { name: "历史竞赛包", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
	await page.getByRole("button", { name: "预览题册", exact: true }).click();
	await expect(page.getByRole("img", { name: "PDF 第 1 页" })).toBeVisible({ timeout: 30_000 });
	await page.getByRole("button", { name: "下一页", exact: true }).click();
	await expect(page.getByRole("img", { name: "PDF 第 2 页" })).toBeVisible();
	await page.getByRole("img", { name: "PDF 第 2 页" }).screenshot({ path: testInfo.outputPath("sandbox-pdf-page-2.png") });
	expect((await json(page, app, `/projects/${project.id}`)).statementSections).toEqual(savedSource);
});

test("@sandbox reports compilation failures, cancels real running work and retries with corrected source", async ({ page, app }) => {
	test.setTimeout(180_000);
	await setup(page, app);
	const project = await prepare(page, app, { reference: { language: "cpp17", code: "int main( { invalid }" } });
	const failed = await json(page, app, `/projects/${project.id}/generate`, { method: "POST" });
	const result = await waitTask(page, app, failed.task.id);
	expect(result.result.report.success).toBeFalsy();
	expect(result.result.report.checks).toContainEqual(expect.objectContaining({ stage: "compile:reference", passed: false, verdict: "CE" }));
	expect((await json(page, app, "/releases")).releases).toEqual([]);
	await json(page, app, `/projects/${project.id}`, { method: "PUT", data: { reference: { language: "cpp17", code: reference }, generatorSource: generator.replace('printf("%s %s\\n",argv[1],argv[2]);', 'for(;;){}') } });
	const slow = await json(page, app, `/projects/${project.id}/generate`, { method: "POST" });
	await page.evaluate(async id => {
		const response = await fetch(`/api/tasks/${id}/events`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) throw new Error("Task finished before generator compilation");
				buffer += decoder.decode(value, { stream: true });
				if (buffer.includes('"stage":"compile:gen"')) break;
			}
		} finally { await reader.cancel(); }
	}, slow.task.id);
	await json(page, app, `/tasks/${slow.task.id}/cancel`, { method: "POST" });
	expect((await waitTask(page, app, slow.task.id)).state).toBe("cancelled");
	await json(page, app, `/projects/${project.id}`, { method: "PUT", data: { generatorSource: generator } });
	const retry = await json(page, app, `/tasks/${slow.task.id}/retry`, { method: "POST" });
	expect(retry.task.id).not.toBe(slow.task.id);
	const retried = await waitTask(page, app, retry.task.id);
	expect(retried.state, retried.error).toBe("succeeded");
	expect(retried.result.report.success).toBeTruthy();
});
