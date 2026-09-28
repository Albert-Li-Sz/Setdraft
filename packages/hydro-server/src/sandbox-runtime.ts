import { rm } from "node:fs/promises";
import { sandboxPolicy } from "./sandbox-policy.ts";

/** Match a non-root service UID so Linux bind-mount output remains removable by the service. */
export function sandboxUser(uid = process.getuid?.(), gid = process.getgid?.()): string {
	return uid && uid > 0 ? `${uid}:${gid && gid > 0 ? gid : uid}` : "65534:65534";
}

export function sandboxRuntimeArgs(): string[] {
	const policy = sandboxPolicy();
	return [
		"--network",
		"none",
		"--cpus",
		String(policy.cpus),
		"--memory",
		`${policy.memoryMb}m`,
		"--memory-swap",
		`${policy.memoryMb}m`,
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
