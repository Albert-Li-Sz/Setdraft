import { type ChildProcess, execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { runManualSandbox } from "../src/manual-sandbox.ts";

const cli = vi.hoisted(() => ({ child: undefined as ChildProcess | undefined }));
vi.mock("node:child_process", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:child_process")>();
	return {
		...original,
		spawn: (...args: Parameters<typeof original.spawn>) => {
			const child = original.spawn(...args);
			if (args[0] === "docker") cli.child = child;
			return child;
		},
	};
});
const exec = promisify(execFile);
const available = (() => {
	try {
		execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

it.skipIf(!available)(
	"removes the real daemon container after the Docker CLI is killed unexpectedly",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-cli-exit-")),
			id = randomUUID(),
			name = `setdraft-task-${id}`;
		const controller = new AbortController();
		try {
			await writeFile(join(root, "1.in"), "1\n");
			const work = Promise.allSettled([
				runManualSandbox({
					context: { id, signal: controller.signal, emit: () => {} },
					mode: "finalize",
					stage: join(root, "stage"),
					image: "setdraft/sandbox:local",
					reference: { language: "python3", code: "import time\ntime.sleep(60)\nprint(1)" },
					generatorStandard: "cpp17",
					checkerStandard: "cpp17",
					validatorStandard: "cpp17",
					cases: [{ id: "1", inputPath: join(root, "1.in"), outputName: "1.out" }],
					timeLimitMs: 60000,
					memoryLimitMb: 256,
					maxFileBytes: 1024,
				}),
			]);
			await vi.waitFor(
				async () =>
					expect(
						(
							await exec("docker", ["inspect", "--format", "{{.State.Running}}", name], { timeout: 2000 })
						).stdout.trim(),
					).toBe("true"),
				{ timeout: 10000, interval: 100 },
			);
			expect(cli.child).toBeDefined();
			cli.child?.kill("SIGKILL");
			expect((await work)[0].status).toBe("rejected");
			await expect(exec("docker", ["inspect", name], { timeout: 2000 })).rejects.toMatchObject({ code: 1 });
		} finally {
			controller.abort();
			await exec("docker", ["rm", "-f", name], { timeout: 5000 }).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	},
	20000,
);
