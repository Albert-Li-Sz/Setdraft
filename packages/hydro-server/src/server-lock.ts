import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProcessIdentity, processIdentity, sameProcess } from "./process-identity.ts";

/** Process-wide schedulers require a single API process for each installation. */
export function acquireServerLock(root: string): () => void {
	mkdirSync(root, { recursive: true });
	const path = join(root, "server.pid");
	for (let attempt = 0; attempt < 2; attempt++) {
		let descriptor: number;
		try {
			descriptor = openSync(path, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const contents = readFileSync(path, "utf8");
			let identity: ProcessIdentity | undefined;
			let pid = Number(contents);
			if (contents.startsWith("{")) {
				const record = JSON.parse(contents) as { pid: number; identity?: ProcessIdentity };
				pid = record.pid;
				identity = record.identity;
			}
			if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("服务锁无效，请检查 server.pid 后重试。");
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false;
			}
			const current = identity ? processIdentity(pid) : undefined;
			if (alive && (!identity || !current || sameProcess(identity, current)))
				throw new Error("该数据目录已有 Setdraft 服务在运行。");
			unlinkSync(path);
			continue;
		}
		const record = JSON.stringify({ pid: process.pid, identity: processIdentity(process.pid) });
		try {
			writeFileSync(descriptor, record);
		} finally {
			closeSync(descriptor);
		}
		return () => {
			try {
				if (readFileSync(path, "utf8") === record) unlinkSync(path);
			} catch {}
		};
	}
	throw new Error("无法获取服务锁。");
}
