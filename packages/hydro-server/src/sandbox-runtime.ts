import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import { sandboxPolicy } from "./sandbox-policy.ts";

const pendingCleanup = new Map<string, SandboxCleanupError>();

export class SandboxCleanupError extends Error {
	readonly containers: string[];
	readonly directories: string[];
	constructor(containers: string[], directories: string[]) {
		super("沙箱停止未确认：容器清理失败，执行名额和工作目录已保留，正在重试清理。");
		this.containers = [...new Set(containers)];
		this.directories = [...new Set(directories.map((path) => resolve(path)))];
		for (const name of this.containers) pendingCleanup.set(name, this);
	}
}

export async function confirmSandboxCleanup(record: { containers: string[]; directories: string[] }): Promise<void> {
	const results = await Promise.allSettled(record.containers.map(removeDockerContainer));
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	for (const name of record.containers) pendingCleanup.delete(name);
	for (const directory of record.directories) await cleanupSandboxStage(directory);
}

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
	const target = resolve(path);
	for (const error of new Set(pendingCleanup.values())) {
		if (
			error.directories.some(
				(directory) =>
					directory === target ||
					directory.startsWith(`${target}${sep}`) ||
					target.startsWith(`${directory}${sep}`),
			)
		) {
			if (!error.directories.includes(target)) error.directories.push(target);
			console.warn("Sandbox directory retained until container cleanup is confirmed:", target);
			return;
		}
	}
	try {
		await rm(path, { recursive: true, force: true });
	} catch (error) {
		console.warn("Sandbox temporary directory cleanup failed:", path, (error as NodeJS.ErrnoException).code);
	}
}
