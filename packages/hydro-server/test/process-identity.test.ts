import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { processIdentity, sameProcess } from "../src/process-identity.ts";
import { acquireServerLock } from "../src/server-lock.ts";

it("matches creation time, command and group, and reclaims a reused PID lock without signalling it", async () => {
	const identity = processIdentity(process.pid);
	expect(identity).toBeDefined();
	if (!identity) throw new Error("identity unavailable");
	expect(sameProcess(identity)).toBe(true);
	for (const stale of [
		{ ...identity, createdAt: "old" },
		{ ...identity, command: "other" },
		{ ...identity, group: -1 },
	])
		expect(sameProcess(stale)).toBe(false);
	const root = await mkdtemp(join(tmpdir(), "setdraft-pid-"));
	try {
		await writeFile(
			join(root, "server.pid"),
			JSON.stringify({ pid: process.pid, identity: { ...identity, createdAt: "old" } }),
		);
		const release = acquireServerLock(root);
		expect(JSON.parse(await readFile(join(root, "server.pid"), "utf8")).identity).toEqual(identity);
		expect(() => acquireServerLock(root)).toThrow("已有 Setdraft");
		release();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
