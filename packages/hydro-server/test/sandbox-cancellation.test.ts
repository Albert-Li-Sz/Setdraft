import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { runManualSandbox } from "../src/manual-sandbox.ts";
import { sandboxUser } from "../src/sandbox-runtime.ts";

const exec = promisify(execFile);
let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}

it("requires a working sandbox image in the Linux release gate", () => {
	if (process.env.SETDRAFT_REQUIRE_SANDBOX === "1") {
		expect(dockerAvailable).toBe(true);
		expect(process.getuid?.()).toBeGreaterThan(0);
	}
	expect(sandboxUser(1001, 1001)).toBe("1001:1001");
	expect(sandboxUser(0, 0)).toBe("65534:65534");
	expect(sandboxUser(1001, 0)).toBe("1001:1001");
});

it.skipIf(!dockerAvailable)(
	"keeps sandbox output owned by the Linux service and removable",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-ownership-"));
		try {
			const input = join(root, "1.in");
			await writeFile(input, "1\n");
			const stage = join(root, "stage");
			const report = await runManualSandbox({
				mode: "finalize",
				stage,
				image: "setdraft/sandbox:local",
				reference: { language: "python3", code: "print(1)" },
				generatorStandard: "cpp17",
				checkerStandard: "cpp17",
				validatorStandard: "cpp17",
				cases: [{ id: "1", inputPath: input, outputName: "1.out" }],
				timeLimitMs: 1000,
				memoryLimitMb: 256,
				maxFileBytes: 1024 * 1024,
			});
			expect(report.success).toBe(true);
			if (process.platform === "linux")
				expect((await stat(join(stage, "build", "reference"))).uid).toBe(Number(sandboxUser().split(":")[0]));
			await rm(stage, { recursive: true });
			await expect(stat(stage)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);

it.skipIf(!dockerAvailable)(
	"waits for the cancelled Docker container to disappear before settling",
	async () => {
		const root = await mkdtemp(join(tmpdir(), "setdraft-cancel-"));
		const id = randomUUID();
		const name = `setdraft-task-${id}`;
		const controller = new AbortController();
		try {
			const input = join(root, "1.in");
			await writeFile(input, "1\n");
			const work = runManualSandbox({
				context: { id, signal: controller.signal, emit: () => {} },
				mode: "finalize",
				stage: join(root, "stage"),
				image: "setdraft/sandbox:local",
				reference: { language: "python3", code: "import time\ntime.sleep(60)\nprint(1)" },
				generatorStandard: "cpp17",
				checkerStandard: "cpp17",
				validatorStandard: "cpp17",
				cases: [{ id: "1", inputPath: input, outputName: "1.out" }],
				timeLimitMs: 60_000,
				memoryLimitMb: 256,
				maxFileBytes: 1024 * 1024,
			});
			const result = Promise.allSettled([work]);
			await vi.waitFor(
				async () => {
					const running = await exec("docker", ["inspect", "--format", "{{.State.Running}}", name], {
						timeout: 2000,
					});
					expect(running.stdout.trim()).toBe("true");
				},
				{ timeout: 10_000, interval: 100 },
			);
			expect((await exec("docker", ["inspect", "--format", "{{.Config.User}}", name])).stdout.trim()).toBe(
				sandboxUser(),
			);
			controller.abort();
			expect((await result)[0].status).toBe("rejected");
			await expect(exec("docker", ["inspect", name], { timeout: 2000 })).rejects.toMatchObject({ code: 1 });
		} finally {
			controller.abort();
			await exec("docker", ["rm", "-f", name], { timeout: 5000 }).catch(() => {});
			await rm(root, { recursive: true, force: true });
		}
	},
	20_000,
);
