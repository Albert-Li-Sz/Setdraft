import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";
import { sandboxPolicy } from "./sandbox-policy.ts";

/** A missing container is already clean; every other Docker error must be reported. */
export async function removeDockerContainer(name: string): Promise<void> {
	try {
		await promisify(execFile)("docker", ["rm", "-f", name], {
			timeout: 10_000,
			killSignal: "SIGKILL",
			maxBuffer: 64 * 1024,
		});
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? "";
		if (!stderr.includes("No such container")) throw new Error(`沙箱容器清理失败：${name}`);
	}
}

/** Match a non-root service UID so Linux bind-mount output remains removable by the service. */
export function sandboxUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
	return uid && uid > 0 ? `${uid}:${gid && gid > 0 ? gid : uid}` : "65534:65534";
}

export function sandboxRuntimeArgs(budget = sandboxPolicy()): string[] {
	return [
		"--network",
		"none",
		"--cpus",
		String(budget.cpus),
		"--memory",
		`${budget.memoryMb}m`,
		"--memory-swap",
		`${budget.memoryMb}m`,
		"--pids-limit",
		"128",
		"--read-only",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--user",
		sandboxUser(),
		"--tmpfs",
		"/tmp:rw,exec,size=128m,mode=1777",
	];
}

/** Temporary cleanup must not turn an already committed result into a reported failure. */
export async function cleanupSandboxStage(path: string): Promise<void> {
	try {
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		console.warn("Sandbox temporary directory cleanup failed:", path, (error as NodeJS.ErrnoException).code);
	}
}
