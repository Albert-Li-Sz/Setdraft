import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { copySandboxFile, readSandboxFile } from "../src/sandbox-files.ts";
import { readSandboxReport } from "../src/sandbox-report.ts";

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-import-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

it("imports normal and empty files with shared byte accounting", async () => {
	await mkdir(join(root, "verified"));
	await writeFile(join(root, "verified", "1.out"), "answer");
	await writeFile(join(root, "verified", "empty.out"), "");
	const budget = { remainingBytes: 6 };
	expect(await copySandboxFile(root, "verified/1.out", join(root, "copied"), 6, budget)).toBe(6);
	expect(await readFile(join(root, "copied"), "utf8")).toBe("answer");
	expect(await readSandboxFile(root, "verified/empty.out", 0)).toHaveLength(0);
	await expect(copySandboxFile(root, "verified/1.out", join(root, "too-many"), 6, budget)).rejects.toThrow("容量");
});

it("rejects leaf links, ancestor links, hard links and traversal", async () => {
	await mkdir(join(root, "outside"));
	await writeFile(join(root, "outside", "secret"), "private");
	await symlink(join(root, "outside"), join(root, "verified"));
	await symlink(join(root, "outside", "secret"), join(root, "result.json"));
	await link(join(root, "outside", "secret"), join(root, "hard"));
	for (const name of ["verified/secret", "result.json", "hard", "../outside/secret", "/etc/passwd"])
		await expect(readSandboxFile(root, name, 1024)).rejects.toThrow();
});

it("rejects FIFOs without blocking, directories, oversized reports and cancelled reads", async () => {
	await promisify(execFile)("mkfifo", [join(root, "result.json")]);
	await expect(readSandboxFile(root, "result.json", 1024)).rejects.toThrow("普通文件");
	await mkdir(join(root, "directory"));
	await expect(readSandboxFile(root, "directory", 1024)).rejects.toThrow("普通文件");
	await writeFile(join(root, "large"), "12345");
	await expect(readSandboxFile(root, "large", 4)).rejects.toThrow("容量");
	await expect(readSandboxFile(root, "large", 8, AbortSignal.abort())).rejects.toMatchObject({ name: "AbortError" });
});

it("validates the report at runtime, including success consistency and collection limits", () => {
	const report = {
		mode: "finalize",
		success: true,
		checks: [{ stage: "reference", passed: true, message: "ok", caseId: null }],
		caseCount: 1,
		generatedCount: 0,
		oracleCount: 0,
		validatorUsed: false,
		checkerUsed: false,
	};
	expect(readSandboxReport(report).checks[0].caseId).toBeUndefined();
	for (const invalid of [
		{ ...report, checks: [{ stage: "reference", passed: false, message: "bad" }] },
		{ ...report, checks: Array(50_001).fill(report.checks[0]) },
		{ ...report, caseCount: "1" },
	])
		expect(() => readSandboxReport(invalid)).toThrow();
});
