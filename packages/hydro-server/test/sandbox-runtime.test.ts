import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { cleanupSandboxStage, sandboxRuntimeArgs, sandboxUser } from "../src/sandbox-runtime.ts";

it("configures CPU and memory without relaxing container isolation", () => {
	vi.stubEnv("SETDRAFT_SANDBOX_CPUS", "2");
	vi.stubEnv("SETDRAFT_SANDBOX_MEMORY_MB", "4096");
	try {
		const args = sandboxRuntimeArgs();
		expect(args).toContain("--read-only");
		for (const [flag, value] of [
			["--cpus", "2"],
			["--memory", "4096m"],
			["--memory-swap", "4096m"],
			["--network", "none"],
			["--cap-drop", "ALL"],
			["--security-opt", "no-new-privileges"],
			["--user", sandboxUser()],
		])
			expect(args[args.indexOf(flag) + 1]).toBe(value);
	} finally {
		vi.unstubAllEnvs();
	}
});

it("reports temporary cleanup failures without overriding a committed result", async () => {
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		await expect(cleanupSandboxStage(join(tmpdir(), "x".repeat(1024)))).resolves.toBeUndefined();
		expect(warning).toHaveBeenCalledWith(
			"Sandbox temporary directory cleanup failed:",
			expect.any(String),
			"ENAMETOOLONG",
		);
	} finally {
		warning.mockRestore();
	}
});

let dockerAvailable = false;
try {
	execFileSync("docker", ["image", "inspect", "setdraft/sandbox:local"], { stdio: "ignore", timeout: 5000 });
	dockerAvailable = true;
} catch {}

it.skipIf(!dockerAvailable)(
	"reproduces and fixes non-root cleanup on a real Linux filesystem",
	() => {
		// tmpfs lives inside Linux even when this test runs on Docker Desktop/macOS.
		const script = [
			"import os, pathlib, shutil, subprocess",
			"stage = pathlib.Path('/work/stage')",
			"stage.mkdir(); os.chown(stage, 1001, 1001); stage.chmod(0o777)",
			"def user(uid):",
			"    os.setgroups([]); os.setgid(uid); os.setuid(uid)",
			"create = \"import pathlib; p=pathlib.Path('/work/stage/build'); p.mkdir(); (p/'output').write_text('ok')\"",
			"remove = \"import shutil; shutil.rmtree('/work/stage')\"",
			"subprocess.run(['python3','-c',create], preexec_fn=lambda: user(65534), check=True)",
			"old = subprocess.run(['python3','-c',remove], preexec_fn=lambda: user(1001), capture_output=True)",
			"assert old.returncode != 0 and b'PermissionError' in old.stderr",
			"shutil.rmtree(stage); stage.mkdir(); os.chown(stage,1001,1001); stage.chmod(0o777)",
			`subprocess.run(['python3','-c',create], preexec_fn=lambda: user(${sandboxUser(1001, 1001).split(":")[0]}), check=True)`,
			"subprocess.run(['python3','-c',remove], preexec_fn=lambda: user(1001), check=True)",
			"assert not stage.exists()",
		].join("\n");
		execFileSync(
			"docker",
			[
				"run",
				"--rm",
				"--network",
				"none",
				"--read-only",
				"--tmpfs",
				"/work:mode=1777",
				"--entrypoint",
				"python3",
				"setdraft/sandbox:local",
				"-c",
				script,
			],
			{ timeout: 15_000, stdio: "pipe" },
		);
	},
	20_000,
);
