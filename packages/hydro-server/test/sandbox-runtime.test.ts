import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sandboxProgramRuntime } from "../src/manual-sandbox.ts";
import { sandboxPolicy } from "../src/sandbox-policy.ts";
import { cleanupSandboxStage, sandboxRuntimeArgs, sandboxUser } from "../src/sandbox-runtime.ts";
import { sandboxIt } from "./sandbox-test.ts";

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

it("adds only the capabilities needed to isolate and terminate untrusted programs", () => {
	const args = sandboxRuntimeArgs(sandboxPolicy(), true);
	expect(args[args.indexOf("--user") + 1]).toBe(`0:${process.getgid?.() ?? 0}`);
	expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
	const capabilities = args.flatMap((value, index) => (args[index - 1] === "--cap-add" ? [value] : []));
	expect(capabilities).toEqual(["SETUID", "SETGID", "DAC_OVERRIDE", "KILL"]);
	expect(args).toContain("--read-only");
	expect(args).toContain("no-new-privileges");
	expect(args.some((value) => value.startsWith("/build:rw,exec,size="))).toBe(true);
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

sandboxIt.each([1001, 65534])(
	"reads service-owned mode-0600 cases without exposing them to contestants with uid/gid %i",
	(serviceId) => {
		const args = sandboxRuntimeArgs(sandboxPolicy(), true);
		args[args.indexOf("--user") + 1] = `0:${serviceId}`;
		const script = [
			"import os, pathlib, subprocess",
			"stage = pathlib.Path('/private/work')",
			`def service(): os.setgroups([]); os.setgid(${serviceId}); os.setuid(${serviceId})`,
			"create = \"import pathlib; cases=pathlib.Path('cases'); cases.mkdir(mode=0o700); p=cases/'0.in'; p.write_text('21\\\\n'); p.chmod(0o600)\"",
			"subprocess.run(['python3', '-c', create], cwd=stage, preexec_fn=service, check=True)",
			"input_path = stage / 'cases' / '0.in'",
			'(stage / \'payload.json\').write_text(\'{"maxFileBytes":1048576,"timeLimitMs":1000,"memoryLimitMb":256}\')',
			sandboxProgramRuntime,
			"assert source('candidate', 'python3', 'print(int(input()) * 2)', untrusted=True)",
			"assert program('candidate', input_path, root/'outputs'/'0.out', '0', untrusted=True)",
			"assert (root/'outputs'/'0.out').read_text() == '42\\n'",
			"def nobody(): os.setgroups([]); os.setgid(untrusted_gid); os.setuid(untrusted_uid)",
			"probe = subprocess.run(['python3', '-c', \"open('/private/work/cases/0.in').read()\"], preexec_fn=nobody, capture_output=True)",
			"assert probe.returncode != 0 and b'PermissionError' in probe.stderr",
		].join("\n");
		execFileSync(
			"docker",
			[
				"run",
				"--rm",
				...args,
				"--tmpfs",
				`/private/work:mode=750,uid=${serviceId},gid=${serviceId}`,
				"--entrypoint",
				"python3",
				"setdraft/sandbox:local",
				"-c",
				script,
			],
			{ timeout: 15000, stdio: "pipe" },
		);
	},
	20000,
);

sandboxIt.each([1001, 65534])(
	"keeps incomplete Linux work removable with service uid/gid %i",
	(serviceId) => {
		const args = sandboxRuntimeArgs(sandboxPolicy(), true);
		args[args.indexOf("--user") + 1] = `0:${serviceId}`;
		const script = [
			"import json, pathlib",
			"pathlib.Path('/private/work/payload.json').write_text(json.dumps({'maxFileBytes': 1048576, 'timeLimitMs': 1000, 'memoryLimitMb': 256}))",
			sandboxProgramRuntime,
			"assert untrusted_uid != root.stat().st_uid and untrusted_gid not in (os.getgid(), root.stat().st_gid)",
			"assert source('candidate', 'python3', \"import os,pathlib; p=pathlib.Path('private'); p.mkdir(mode=0o700); (p/'file').write_text('scratch'); print(1)\", untrusted=True)",
			"assert program('candidate', None, root/'outputs'/'1.out', '1', untrusted=True)",
			"assert (root/'outputs'/'1.out').read_text() == '1\\n'",
			"assert not (root/'build').exists() and not (root/'run').exists()",
			"attack = \"import pathlib; pathlib.Path('/build/candidate/main.py').write_text('forged')\"",
			"def nobody(): os.setgroups([]); os.setgid(untrusted_gid); os.setuid(untrusted_uid)",
			"attempt = subprocess.run(['python3','-c',attack], preexec_fn=nobody, capture_output=True)",
			"assert attempt.returncode != 0 and b'PermissionError' in attempt.stderr",
			`def service(): os.setgroups([]); os.setgid(${serviceId}); os.setuid(${serviceId})`,
			// No final permission cleanup: this also models cancellation before the result is written.
			"cleanup = \"import pathlib,shutil; root=pathlib.Path('/private/work'); [(shutil.rmtree(p) if p.is_dir() else p.unlink()) for p in root.iterdir()]; assert not list(root.iterdir())\"",
			"pathlib.Path('/private').chmod(0o755)",
			"subprocess.run(['python3','-c',cleanup], preexec_fn=service, check=True)",
		].join("\n");
		execFileSync(
			"docker",
			[
				"run",
				"--rm",
				...args,
				"--tmpfs",
				`/private/work:mode=750,uid=${serviceId},gid=65534`,
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
