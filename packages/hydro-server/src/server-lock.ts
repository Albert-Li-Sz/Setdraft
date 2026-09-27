import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
			const pid = Number(readFileSync(path, "utf8"));
			if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("服务锁无效，请检查 server.pid 后重试。");
			let alive = true;
			try {
				process.kill(pid, 0);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code === "ESRCH") alive = false;
			}
			if (alive) throw new Error("该数据目录已有 Setdraft 服务在运行。");
			unlinkSync(path);
			continue;
		}
		try {
			writeFileSync(descriptor, String(process.pid));
		} finally {
			closeSync(descriptor);
		}
		return () => {
			try {
				if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
			} catch {}
		};
	}
	throw new Error("无法获取服务锁。");
}
