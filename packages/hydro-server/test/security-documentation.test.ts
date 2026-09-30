import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("documents the actual CLI and Compose exposure defaults", async () => {
	const [security, cli, compose] = await Promise.all([
		readFile(new URL("../../../SECURITY.md", import.meta.url), "utf8"),
		readFile(new URL("../src/cli.ts", import.meta.url), "utf8"),
		readFile(new URL("../../../compose.yaml", import.meta.url), "utf8"),
	]);
	expect(cli).toContain('process.env.SETDRAFT_HOST || "0.0.0.0"');
	expect(compose).toMatch(/SETDRAFT_BIND_ADDRESS:-0\.0\.0\.0.*SETDRAFT_PORT:-4321/u);
	expect(security).toContain("`0.0.0.0`");
	expect(security).toContain("`4321`");
	expect(security).not.toContain("默认只监听 `127.0.0.1`");
	for (const boundary of ["HTTPS", "CSRF", "Docker socket", "按账号隔离"]) expect(security).toContain(boundary);
});
