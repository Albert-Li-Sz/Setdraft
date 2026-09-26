import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateWorkspaceSchema } from "./workspace-schema.ts";

export type DocumentKind = "project" | "release" | "contest" | "contest-release" | "chat" | "ai-config";

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

const legacyDirectories: Array<{ kind: DocumentKind; directory: string; file: string; flat?: boolean }> = [
	{ kind: "project", directory: "projects", file: "project.json" },
	{ kind: "release", directory: "releases", file: "release.json" },
	{ kind: "contest", directory: "contests", file: "contest.json" },
	{ kind: "contest-release", directory: "contest-releases", file: "release.json" },
	{ kind: "chat", directory: "chats", file: ".json", flat: true },
];

export class WorkspaceDatabase {
	readonly root: string;
	readonly db: DatabaseSync;
	readonly migrationError?: string;
	private transactionDepth = 0;

	constructor(root: string) {
		this.root = resolve(root);
		mkdirSync(this.root, { recursive: true });
		this.db = new DatabaseSync(join(this.root, "workspace.sqlite"));
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000");
		migrateWorkspaceSchema(this.db);
		if (!this.db.prepare("SELECT value FROM metadata WHERE key='legacy-migrated'").get()) {
			try {
				this.migrateLegacy();
			} catch (error) {
				this.migrationError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	private migrateLegacy(): void {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			if (this.db.prepare("SELECT value FROM metadata WHERE key='legacy-migrated'").get()) {
				this.db.exec("COMMIT");
				return;
			}
			for (const source of legacyDirectories) {
				const directory = join(this.root, source.directory);
				if (!existsSync(directory)) continue;
				for (const entry of readdirSync(directory, { withFileTypes: true })) {
					const id = source.flat ? entry.name.slice(0, -5) : entry.name;
					if (
						!/^[a-f0-9-]{36}$/u.test(id) ||
						(source.flat ? !entry.isFile() || !entry.name.endsWith(".json") : !entry.isDirectory())
					)
						continue;
					const path = source.flat ? join(directory, entry.name) : join(directory, id, source.file);
					if (!existsSync(path)) continue;
					const body = readFileSync(path, "utf8");
					const parsed = JSON.parse(body) as { id?: string; revision?: number };
					if (parsed.id !== id) throw new Error(`旧数据 ID 与目录不一致：${path}`);
					const files: Array<{ ownerKind: string; ownerId: string; name: string; path: string }> = [];
					if (source.kind === "project") {
						for (const origin of ["manual", "generated"]) {
							const dataDir = join(directory, id, origin);
							if (!existsSync(dataDir)) continue;
							for (const item of readdirSync(dataDir, { withFileTypes: true })) {
								if (item.isFile() && /\.(in|out|ans)$/u.test(item.name))
									files.push({
										ownerKind: origin,
										ownerId: id,
										name: item.name,
										path: join(dataDir, item.name),
									});
							}
						}
						const pdf = join(directory, id, "domjudge", "problem.pdf");
						if (existsSync(pdf)) files.push({ ownerKind: "pdf", ownerId: id, name: "problem.pdf", path: pdf });
					}
					if (source.kind === "release")
						for (const name of [
							"hydro.zip",
							"source.zip",
							"domjudge.zip",
							"fps.xml",
							"qduoj.zip",
							"problem.pdf",
						]) {
							const filePath = join(directory, id, name);
							if (existsSync(filePath))
								files.push({ ownerKind: "release-file", ownerId: id, name, path: filePath });
						}
					if (source.kind === "contest-release") {
						const filePath = join(directory, id, "bundle.zip");
						if (existsSync(filePath))
							files.push({ ownerKind: "contest-bundle", ownerId: id, name: "bundle.zip", path: filePath });
					}
					if (source.kind === "chat") {
						const imageDir = join(directory, id);
						if (existsSync(imageDir))
							for (const image of readdirSync(imageDir, { withFileTypes: true })) {
								if (image.isFile())
									files.push({
										ownerKind: "chat-image",
										ownerId: id,
										name: image.name,
										path: join(imageDir, image.name),
									});
							}
					}
					const digests = files.map((item) => ({
						...item,
						hash: hashFileSync(item.path),
						size: statSync(item.path).size,
					}));
					for (const item of digests) {
						const directory = join(this.root, "blobs", item.hash.slice(0, 2));
						mkdirSync(directory, { recursive: true });
						const blob = join(directory, item.hash);
						if (!existsSync(blob) || hashFileSync(blob) !== item.hash) copyFileSync(item.path, blob);
						if (hashFileSync(blob) !== item.hash) throw new Error(`迁移文件哈希不匹配：${item.path}`);
					}
					this.db
						.prepare("INSERT OR IGNORE INTO documents (kind,id,body,version) VALUES (?,?,?,?)")
						.run(source.kind, id, body, parsed.revision ?? 0);
					for (const item of digests)
						this.db
							.prepare("INSERT OR IGNORE INTO files (owner_kind,owner_id,name,hash,size) VALUES (?,?,?,?,?)")
							.run(item.ownerKind, item.ownerId, item.name, item.hash, item.size);
				}
			}
			this.db.prepare("INSERT OR IGNORE INTO metadata (key,value) VALUES ('legacy-migrated','1')").run();
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** Callbacks must be synchronous: filesystem preparation happens before acquiring the write lock. */
	transaction<T>(commit: () => T extends PromiseLike<unknown> ? never : T): T {
		this.ensureWritable();
		const nested = this.transactionDepth > 0;
		const savepoint = `workspace_${this.transactionDepth++}`;
		try {
			this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
			try {
				const result = commit();
				this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
				return result;
			} catch (error) {
				this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
				throw error;
			}
		} finally {
			this.transactionDepth--;
		}
	}

	async pruneBlobs(): Promise<{ removed: number; bytes: number }> {
		this.ensureWritable();
		let removed = 0;
		let bytes = 0;
		const root = join(this.root, "blobs");
		for (const shard of await readdir(root, { withFileTypes: true }).catch(() => [])) {
			if (!shard.isDirectory()) continue;
			for (const item of await readdir(join(root, shard.name), { withFileTypes: true })) {
				if (!item.isFile() || !/^[a-f0-9]{64}$/u.test(item.name)) continue;
				const path = join(root, shard.name, item.name);
				// Recheck under the same cross-process write lock used to publish blobs and references.
				this.transaction(() => {
					if (this.db.prepare("SELECT 1 FROM files WHERE hash=? LIMIT 1").get(item.name)) return;
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

	get<T>(kind: DocumentKind, id: string): T | undefined {
		return this.getVersioned<T>(kind, id)?.value;
	}

	getVersioned<T>(kind: DocumentKind, id: string): { value: T; version?: number } | undefined {
		const row = this.db.prepare("SELECT body,version FROM documents WHERE kind=? AND id=?").get(kind, id) as
			| { body: string; version: number }
			| undefined;
		if (row) return { value: JSON.parse(row.body) as T, version: row.version };
		if (this.migrationError) {
			const source = legacyDirectories.find((item) => item.kind === kind);
			if (source) {
				const path = source.flat
					? join(this.root, source.directory, `${id}.json`)
					: join(this.root, source.directory, id, source.file);
				if (existsSync(path)) return { value: JSON.parse(readFileSync(path, "utf8")) as T };
			}
		}
		return undefined;
	}

	version(kind: DocumentKind, id: string): number | undefined {
		const row = this.db.prepare("SELECT version FROM documents WHERE kind=? AND id=?").get(kind, id) as
			| { version: number }
			| undefined;
		return row?.version;
	}

	list<T>(kind: DocumentKind): T[] {
		const stored = (
			this.db.prepare("SELECT body FROM documents WHERE kind=?").all(kind) as Array<{ body: string }>
		).map((row) => JSON.parse(row.body) as T);
		if (!this.migrationError) return stored;
		const source = legacyDirectories.find((item) => item.kind === kind);
		if (!source) return stored;
		const directory = join(this.root, source.directory);
		if (!existsSync(directory)) return stored;
		const ids = new Set(stored.map((item) => (item as { id: string }).id));
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const id = source.flat ? entry.name.slice(0, -5) : entry.name;
			if (!/^[a-f0-9-]{36}$/u.test(id) || ids.has(id)) continue;
			try {
				const value = this.get<T>(kind, id);
				if (value) stored.push(value);
			} catch {}
		}
		return stored;
	}

	put(kind: DocumentKind, id: string, value: unknown, expectedVersion?: number): void {
		this.ensureWritable();
		if (expectedVersion !== undefined) {
			const body = JSON.stringify(value);
			const result =
				expectedVersion === -1
					? this.db
							.prepare("INSERT OR IGNORE INTO documents (kind,id,body,version) VALUES (?,?,?,0)")
							.run(kind, id, body)
					: this.db
							.prepare("UPDATE documents SET body=?,version=version+1 WHERE kind=? AND id=? AND version=?")
							.run(body, kind, id, expectedVersion);
			if (result.changes !== 1) throw new Error("VERSION_CONFLICT");
			return;
		}
		this.db
			.prepare(
				"INSERT INTO documents (kind,id,body,version) VALUES (?,?,?,0) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body, version=documents.version+1",
			)
			.run(kind, id, JSON.stringify(value));
	}

	delete(kind: DocumentKind, id: string): void {
		this.ensureWritable();
		this.db.prepare("DELETE FROM documents WHERE kind=? AND id=?").run(kind, id);
	}

	private ensureWritable(): void {
		if (this.migrationError) throw new Error(`旧数据迁移失败，当前只读：${this.migrationError}`);
	}

	fileEntries(ownerKind: string, ownerId: string): FileRow[] {
		const stored = this.db
			.prepare("SELECT name,hash,size FROM files WHERE owner_kind=? AND owner_id=?")
			.all(ownerKind, ownerId) as unknown as FileRow[];
		if (!this.migrationError) return stored;
		const known = new Set(stored.map((item) => item.name));
		const directory = this.legacyFileDirectory(ownerKind, ownerId);
		if (!directory || !existsSync(directory)) return stored;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isFile() || known.has(entry.name)) continue;
			if ((ownerKind === "manual" || ownerKind === "generated") && !/\.(in|out|ans)$/u.test(entry.name)) continue;
			const path = join(directory, entry.name);
			stored.push({ name: entry.name, hash: hashFileSync(path), size: statSync(path).size });
		}
		return stored;
	}

	filePath(ownerKind: string, ownerId: string, name: string): string | undefined {
		const row = this.db
			.prepare("SELECT hash FROM files WHERE owner_kind=? AND owner_id=? AND name=?")
			.get(ownerKind, ownerId, name) as { hash: string } | undefined;
		if (row) {
			const blob = join(this.root, "blobs", row.hash.slice(0, 2), row.hash);
			if (existsSync(blob) || !this.migrationError) return blob;
		}
		return this.migrationError ? this.legacyFilePath(ownerKind, ownerId, name) : undefined;
	}

	private legacyFileDirectory(ownerKind: string, ownerId: string): string | undefined {
		if (!/^[a-f0-9-]{36}$/u.test(ownerId)) return undefined;
		if (ownerKind === "manual" || ownerKind === "generated") return join(this.root, "projects", ownerId, ownerKind);
		if (ownerKind === "pdf") return join(this.root, "projects", ownerId, "domjudge");
		if (ownerKind === "release-file") return join(this.root, "releases", ownerId);
		if (ownerKind === "contest-bundle") return join(this.root, "contest-releases", ownerId);
		if (ownerKind === "chat-image") return join(this.root, "chats", ownerId);
		return undefined;
	}

	private legacyFilePath(ownerKind: string, ownerId: string, name: string): string | undefined {
		const directory = this.legacyFileDirectory(ownerKind, ownerId);
		if (!directory) return undefined;
		const path = join(directory, name);
		return existsSync(path) ? path : undefined;
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
		commit?: () => T extends PromiseLike<unknown> ? never : T,
		replaceOwners: Array<{ ownerKind: string; ownerId: string }> = [],
	): Promise<void> {
		this.ensureWritable();
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
			this.transaction(() => {
				// Validate/update documents first, so a conflict snapshot never includes provisional file references.
				commit?.();
				for (const owner of replaceOwners) this.removeOwnerFiles(owner.ownerKind, owner.ownerId);
				for (const { file, temporary, digest, size, blob } of staged) {
					// A crash before COMMIT leaves only an unreferenced complete blob, safe for later GC.
					if (!existsSync(blob)) renameSync(temporary, blob);
					this.db
						.prepare(
							"INSERT INTO files (owner_kind,owner_id,name,hash,size) VALUES (?,?,?,?,?) ON CONFLICT(owner_kind,owner_id,name) DO UPDATE SET hash=excluded.hash,size=excluded.size",
						)
						.run(file.ownerKind, file.ownerId, file.name, digest, size);
				}
			});
		} finally {
			// Cleanup must not turn a successful commit into a reported failure.
			const cleanup = await Promise.allSettled(temporaryPaths.map((path) => rm(path, { force: true })));
			for (const result of cleanup)
				if (result.status === "rejected") console.warn("Blob staging cleanup failed:", result.reason);
		}
	}

	renameFiles(ownerKind: string, ownerId: string, changes: Array<{ from: string; to: string }>): void {
		this.transaction(() => {
			const entries = new Map(this.fileEntries(ownerKind, ownerId).map((item) => [item.name, item]));
			const moved = new Set(changes.map((item) => item.from));
			if (new Set(changes.map((item) => item.to)).size !== changes.length) throw new Error("文件重命名目标重复。");
			for (const change of changes) {
				if (!entries.has(change.from) || (entries.has(change.to) && !moved.has(change.to)))
					throw new Error("文件重命名冲突。");
				this.removeFile(ownerKind, ownerId, change.from);
			}
			for (const change of changes) {
				const entry = entries.get(change.from)!;
				this.db
					.prepare("INSERT INTO files (owner_kind,owner_id,name,hash,size) VALUES (?,?,?,?,?)")
					.run(ownerKind, ownerId, change.to, entry.hash, entry.size);
			}
		});
	}

	async readBuffer(ownerKind: string, ownerId: string, name: string): Promise<Buffer> {
		const row = this.db
			.prepare("SELECT hash FROM files WHERE owner_kind=? AND owner_id=? AND name=?")
			.get(ownerKind, ownerId, name) as { hash: string } | undefined;
		if (row) {
			const blob = join(this.root, "blobs", row.hash.slice(0, 2), row.hash);
			try {
				return await readFile(blob);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (!this.migrationError || (code !== "ENOENT" && code !== "ENOTDIR")) throw error;
			}
		}
		if (this.migrationError) {
			const legacy = this.legacyFilePath(ownerKind, ownerId, name);
			if (legacy) return readFile(legacy);
		}
		throw new Error("文件索引不存在。");
	}

	removeFile(ownerKind: string, ownerId: string, name: string): void {
		this.ensureWritable();
		this.db.prepare("DELETE FROM files WHERE owner_kind=? AND owner_id=? AND name=?").run(ownerKind, ownerId, name);
	}

	removeOwnerFiles(ownerKind: string, ownerId: string): void {
		this.ensureWritable();
		this.db.prepare("DELETE FROM files WHERE owner_kind=? AND owner_id=?").run(ownerKind, ownerId);
	}

	async restoreFile(ownerKind: string, ownerId: string, name: string, target: string): Promise<boolean> {
		const row = this.db
			.prepare("SELECT hash FROM files WHERE owner_kind=? AND owner_id=? AND name=?")
			.get(ownerKind, ownerId, name) as { hash: string } | undefined;
		if (!row) return false;
		await mkdir(join(target, ".."), { recursive: true });
		const temporary = `${target}.restore`;
		await copyFile(join(this.root, "blobs", row.hash.slice(0, 2), row.hash), temporary);
		await rename(temporary, target);
		return true;
	}
}

function hashFileSync(path: string): string {
	const digest = createHash("sha256");
	const descriptor = openSync(path, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const count = readSync(descriptor, buffer, 0, buffer.length, null);
			if (count === 0) break;
			digest.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(descriptor);
	}
	return digest.digest("hex");
}
