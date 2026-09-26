import type { DatabaseSync } from "node:sqlite";

/** Schema changes belong here, and run once before any module starts accepting work. */
export function migrateWorkspaceSchema(db: DatabaseSync): void {
	db.exec("BEGIN IMMEDIATE");
	try {
		const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (version > 1) throw new Error("工作区来自更新版本，请升级应用后打开。");
		if (version < 1) {
			db.exec(`
			CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS documents (
				kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (kind, id)
			);
			CREATE TABLE IF NOT EXISTS files (
				owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
				hash TEXT NOT NULL, size INTEGER NOT NULL,
				PRIMARY KEY (owner_kind, owner_id, name)
			);
			CREATE INDEX IF NOT EXISTS files_hash ON files(hash);
			CREATE TABLE IF NOT EXISTS tasks (
				id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource TEXT NOT NULL, format TEXT,
				state TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
				result TEXT, error TEXT, owner_pid INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX IF NOT EXISTS task_resource_active ON tasks(resource) WHERE state IN ('queued','running');
			CREATE TABLE IF NOT EXISTS task_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL,
				message TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT
			);
			CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id,sequence);
		
			CREATE TABLE IF NOT EXISTS chat_requests (
				id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
				state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT,
				owner_pid INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0
			);
			CREATE UNIQUE INDEX IF NOT EXISTS chat_one_active_request ON chat_requests(chat_id) WHERE state IN ('queued','running');
			CREATE TABLE IF NOT EXISTS chat_request_events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS chat_request_event_lookup ON chat_request_events(request_id,sequence);
		`);
			for (const [table, column, definition] of [
				["tasks", "cancel_requested", "INTEGER NOT NULL DEFAULT 0"],
				["chat_requests", "owner_pid", "INTEGER"],
				["chat_requests", "cancel_requested", "INTEGER NOT NULL DEFAULT 0"],
			]) {
				const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
				if (!columns.some((item) => item.name === column))
					db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
			}
			db.exec("PRAGMA user_version=1");
		}
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
