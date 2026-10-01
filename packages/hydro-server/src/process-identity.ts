import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface ProcessIdentity {
	pid: number;
	createdAt: string;
	command: string;
	group: number;
}

/** Creation time plus command and process group distinguish a reused PID from our process. */
export function processIdentity(pid: number): ProcessIdentity | undefined {
	if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat
				.slice(stat.lastIndexOf(")") + 2)
				.trim()
				.split(/\s+/u);
			const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
			const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			if (!command || !/^\d+$/u.test(fields[19])) return undefined;
			return { pid, createdAt: `${boot}:${fields[19]}`, group: Number(fields[2]), command };
		} catch {
			return undefined;
		}
	}
	if (process.platform === "win32") {
		const result = spawnSync(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($p){[pscustomobject]@{createdAt=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine;group=${pid}}|ConvertTo-Json -Compress}`,
			],
			{ encoding: "utf8", timeout: 3000, windowsHide: true },
		);
		if (result.status !== 0 || !result.stdout.trim()) return undefined;
		try {
			const value: unknown = JSON.parse(result.stdout);
			if (
				value &&
				typeof value === "object" &&
				"createdAt" in value &&
				typeof value.createdAt === "string" &&
				"command" in value &&
				typeof value.command === "string"
			)
				return { pid, createdAt: value.createdAt, command: value.command, group: pid };
		} catch {
			/* Unidentifiable processes cannot be signalled. */
		}
		return undefined;
	}
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "pgid=", "-o", "command="], {
		encoding: "utf8",
		timeout: 3000,
		env: { ...process.env, LC_ALL: "C" },
	});
	const match = /^(\S.{23})\s+(\d+)\s+(.+)$/u.exec(result.stdout.trim());
	if (result.status !== 0 || !match) return undefined;
	return { pid, createdAt: match[1], group: Number(match[2]), command: match[3] };
}

export function sameProcess(expected: ProcessIdentity, current = processIdentity(expected.pid)): boolean {
	return Boolean(
		current &&
			expected.createdAt === current.createdAt &&
			expected.command === current.command &&
			expected.group === current.group &&
			expected.pid === current.pid,
	);
}
