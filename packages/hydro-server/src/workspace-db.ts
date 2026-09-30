import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { PostgresScope } from "./postgres.ts";

export type DocumentKind =
	| "project"
	| "release"
	| "contest"
	| "contest-release"
	| "chat"
	| "chat-cancellation"
	| "sandbox-cleanup"
	| "ai-config"
	| "task-options"
	| "search-cache";

interface FileRow {
	name: string;
	hash: string;
	size: number;
}

export interface WorkspaceFile {
	ownerKind: string;
	ownerId: string;
	name: string;
	source: { path: string } | { bytes: Buffer };
}

export class WorkspaceDatabase {
	readonly root: string;
	readonly sql: PostgresScope;
	constructor(root: string, accountId?: string) {
		this.root = resolve(root);
		mkdirSync(this.root, { recursive: true });
		// Standalone tooling uses a stable isolated workspace; HTTP workspaces always supply the verified user ID.
		const digest = createHash("sha256").update(this.root).digest("hex");
		const personalId =
			basename(dirname(this.root)) === "users" && /^[a-f0-9-]{36}$/u.test(basename(this.root))
				? basename(this.root)
				: undefined;
		const id =
			accountId ??
			personalId ??
			`${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
		this.sql = new PostgresScope(this.root, "workspace", id);
	}
	transaction<T>(commit: () => Promise<T> | T): Promise<T> {
		return this.sql.transaction(commit);
	}
	async get<T>(kind: DocumentKind, id: string): Promise<T | undefined> {
		return (await this.getVersioned<T>(kind, id))?.value;
	}
	async getVersioned<T>(kind: DocumentKind, id: string): Promise<{ value: T; version: number } | undefined> {
		const row = await this.sql.one<{ body: T; version: number }>(
			"SELECT body,version FROM documents WHERE kind=$1 AND id=$2",
			[kind, id],
		);
		return row ? { value: row.body, version: row.version } : undefined;
	}
	async version(kind: DocumentKind, id: string): Promise<number | undefined> {
		return (
			await this.sql.one<{ version: number }>("SELECT version FROM documents WHERE kind=$1 AND id=$2", [kind, id])
		)?.version;
	}
	async list<T>(kind: DocumentKind): Promise<T[]> {
		return (await this.sql.all<{ body: T }>("SELECT body FROM documents WHERE kind=$1", [kind])).map(
			(row) => row.body,
		);
	}
	async put(kind: DocumentKind, id: string, value: unknown, expectedVersion?: number): Promise<void> {
		const body = JSON.stringify(value);
		if (expectedVersion !== undefined) {
			const result =
				expectedVersion === -1
					? await this.sql.execute(
							"INSERT INTO documents(kind,id,body,version) VALUES($1,$2,$3,0) ON CONFLICT(account_id,kind,id) DO NOTHING",
							[kind, id, body],
						)
					: await this.sql.execute(
							"UPDATE documents SET body=$1,version=version+1 WHERE kind=$2 AND id=$3 AND version=$4",
							[body, kind, id, expectedVersion],
						);
			if (result.rowCount !== 1) throw new Error("VERSION_CONFLICT");
		} else
			await this.sql.execute(
				"INSERT INTO documents(kind,id,body,version) VALUES($1,$2,$3,0) ON CONFLICT(account_id,kind,id) DO UPDATE SET body=excluded.body,version=documents.version+1",
				[kind, id, body],
			);
	}
	async delete(kind: DocumentKind, id: string): Promise<void> {
		await this.sql.execute("DELETE FROM documents WHERE kind=$1 AND id=$2", [kind, id]);
	}
	async fileEntries(ownerKind: string, ownerId: string): Promise<FileRow[]> {
		return this.sql.all<FileRow>(
			"SELECT name,hash,size FROM files WHERE owner_kind=$1 AND owner_id=$2 ORDER BY name",
			[ownerKind, ownerId],
		);
	}
	async filePath(ownerKind: string, ownerId: string, name: string): Promise<string | undefined> {
		const row = await this.sql.one<{ hash: string }>(
			"SELECT hash FROM files WHERE owner_kind=$1 AND owner_id=$2 AND name=$3",
			[ownerKind, ownerId, name],
		);
		return row ? join(this.root, "blobs", row.hash.slice(0, 2), row.hash) : undefined;
	}
	async removeFile(ownerKind: string, ownerId: string, name: string): Promise<void> {
		await this.sql.execute("DELETE FROM files WHERE owner_kind=$1 AND owner_id=$2 AND name=$3", [
			ownerKind,
			ownerId,
			name,
		]);
	}
	async removeOwnerFiles(ownerKind: string, ownerId: string): Promise<void> {
		await this.sql.execute("DELETE FROM files WHERE owner_kind=$1 AND owner_id=$2", [ownerKind, ownerId]);
	}
	async readBuffer(ownerKind: string, ownerId: string, name: string): Promise<Buffer> {
		const path = await this.filePath(ownerKind, ownerId, name);
		if (!path) throw new Error("文件索引不存在。");
		return readFile(path);
	}
	async restoreFile(ownerKind: string, ownerId: string, name: string, target: string): Promise<boolean> {
		const path = await this.filePath(ownerKind, ownerId, name);
		if (!path) return false;
		await mkdir(join(target, ".."), { recursive: true });
		const temporary = `${target}.${randomUUID()}.restore`;
		await copyFile(path, temporary);
		await rename(temporary, target);
		return true;
	}
	async pruneBlobs(): Promise<{ removed: number; bytes: number }> {
		await this.pruneOrphanReleaseFiles();
		let removed = 0,
			bytes = 0;
		const root = join(this.root, "blobs");
		for (const shard of await readdir(root, { withFileTypes: true }).catch(() => [])) {
			if (!shard.isDirectory()) continue;
			for (const item of await readdir(join(root, shard.name), { withFileTypes: true })) {
				if (!item.isFile() || !/^[a-f0-9]{64}$/u.test(item.name)) continue;
				await this.transaction(async () => {
					if (await this.sql.one("SELECT 1 FROM files WHERE hash=$1 LIMIT 1", [item.name])) return;
					const path = join(root, shard.name, item.name);
					try {
						const size = statSync(path).size;
						unlinkSync(path);
						bytes += size;
						removed++;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
					}
				});
			}
		}
		return { removed, bytes };
	}

	/** Repair historical ownerless exports before blob GC; shares the short commit lock with deletion. */
	async pruneOrphanReleaseFiles(): Promise<number> {
		return this.transaction(
			async () =>
				(
					await this.sql.execute(
						"DELETE FROM files WHERE owner_kind='release-file' AND NOT EXISTS (SELECT 1 FROM documents AS r JOIN documents AS p ON p.kind='project' AND p.id=r.body->>'projectId' WHERE r.kind='release' AND r.id=files.owner_id)",
					)
				).rowCount,
		);
	}
	async indexFile(ownerKind: string, ownerId: string, name: string, path: string): Promise<void> {
		await this.commitFiles([{ ownerKind, ownerId, name, source: { path } }]);
	}

	async storeBuffer(ownerKind: string, ownerId: string, name: string, bytes: Buffer): Promise<void> {
		await this.commitFiles([{ ownerKind, ownerId, name, source: { bytes } }]);
	}

	/** Publish complete immutable files and their document changes as one logical commit. */
	async commitFiles<T = void>(
		files: WorkspaceFile[],
		commit?: () => Promise<T> | T,
		replaceOwners: Array<{ ownerKind: string; ownerId: string }> = [],
	): Promise<void> {
		const staged: Array<{ file: WorkspaceFile; temporary: string; digest: string; size: number; blob: string }> = [];
		const temporaryPaths: string[] = [];
		const staging = join(this.root, ".blob-staging");
		await mkdir(staging, { recursive: true });
		try {
			for (const file of files) {
				const temporary = join(staging, randomUUID());
				temporaryPaths.push(temporary);
				if ("path" in file.source) await copyFile(file.source.path, temporary, 1);
				else await writeFile(temporary, file.source.bytes, { flag: "wx" });
				const hash = createHash("sha256");
				let size = 0;
				for await (const chunk of createReadStream(temporary)) {
					hash.update(chunk);
					size += Buffer.byteLength(chunk);
				}
				const digest = hash.digest("hex");
				const blob = join(this.root, "blobs", digest.slice(0, 2), digest);
				await mkdir(join(blob, ".."), { recursive: true });
				staged.push({ file, temporary, digest, size, blob });
			}
			await this.transaction(async () => {
				// Validate/update documents first, so a conflict snapshot never includes provisional file references.
				await commit?.();
				for (const file of files) {
					if (file.ownerKind !== "release-file") continue;
					const release = await this.get<{ projectId: string }>("release", file.ownerId);
					if (!release || !(await this.get("project", release.projectId)))
						throw new Error("发布记录或所属项目已删除，导出文件未提交。");
				}
				for (const owner of replaceOwners) await this.removeOwnerFiles(owner.ownerKind, owner.ownerId);
				for (const { file, temporary, digest, size, blob } of staged) {
					// A crash before COMMIT leaves only an unreferenced complete blob, safe for later GC.
					if (!existsSync(blob)) renameSync(temporary, blob);
					await this.sql.execute(
						"INSERT INTO files(owner_kind,owner_id,name,hash,size) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,owner_kind,owner_id,name) DO UPDATE SET hash=excluded.hash,size=excluded.size",
						[file.ownerKind, file.ownerId, file.name, digest, size],
					);
				}
			});
		} finally {
			// Cleanup must not turn a successful commit into a reported failure.
			const cleanup = await Promise.allSettled(temporaryPaths.map((path) => rm(path, { force: true })));
			for (const result of cleanup)
				if (result.status === "rejected") console.warn("Blob staging cleanup failed:", result.reason);
		}
	}

	async renameFiles(ownerKind: string, ownerId: string, changes: Array<{ from: string; to: string }>): Promise<void> {
		await this.transaction(async () => {
			const entries = new Map((await this.fileEntries(ownerKind, ownerId)).map((item) => [item.name, item]));
			const moved = new Set(changes.map((item) => item.from));
			if (new Set(changes.map((item) => item.to)).size !== changes.length) throw new Error("文件重命名目标重复。");
			for (const change of changes) {
				if (!entries.has(change.from) || (entries.has(change.to) && !moved.has(change.to)))
					throw new Error("文件重命名冲突。");
				await this.removeFile(ownerKind, ownerId, change.from);
			}
			for (const change of changes) {
				const entry = entries.get(change.from)!;
				await this.sql.execute("INSERT INTO files(owner_kind,owner_id,name,hash,size) VALUES($1,$2,$3,$4,$5)", [
					ownerKind,
					ownerId,
					change.to,
					entry.hash,
					entry.size,
				]);
			}
		});
	}
}
