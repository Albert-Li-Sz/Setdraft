import { AsyncLocalStorage } from "node:async_hooks";
import { resolve, sep } from "node:path";
import { Pool, type PoolClient } from "pg";

interface Connection {
	pool: Pool;
	identitySchema: string;
	workspaceSchema: string;
	ready: Promise<void>;
}
const connections = new Map<string, Connection>();
let application: Connection | undefined;
export function identifier(value: string): string {
	if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error("Invalid database identifier");
	return `"${value}"`;
}

export function registerDatabase(root: string, connection: Connection): void {
	connections.set(resolve(root), connection);
}
function connectionFor(root: string): Connection {
	const path = resolve(root);
	const registered = [...connections]
		.filter(([key]) => path === key || path.startsWith(`${key}${sep}`))
		.sort((a, b) => b[0].length - a[0].length)[0];
	if (registered) return registered[1];
	if (application) return application;
	if (!process.env.SETDRAFT_DATABASE_URL)
		throw new Error("SETDRAFT_DATABASE_URL is required; SQLite is no longer supported.");
	const pool = new Pool({
		connectionString: process.env.SETDRAFT_DATABASE_URL,
		max: 16,
		connectionTimeoutMillis: 10_000,
		idleTimeoutMillis: 30_000,
	});
	pool.on("error", () => console.error("PostgreSQL connection interrupted."));
	const ready = (async () => {
		const { rows } = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
			"SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
		);
		if (rows[0]?.rolsuper || rows[0]?.rolbypassrls)
			throw new Error("Application database role must not be a superuser or bypass RLS.");
		await pool.query("SELECT version FROM identity.schema_version");
	})();
	application = { pool, identitySchema: "identity", workspaceSchema: "workspace", ready };
	return application;
}
export async function closeDatabasePools(): Promise<void> {
	const pools = new Set([...connections.values()].map((value) => value.pool));
	if (application) pools.add(application.pool);
	await Promise.all([...pools].map((pool) => pool.end()));
	connections.clear();
	application = undefined;
}

/** A scope pins user identity and search_path for every transaction, never on a pooled session. */
export class PostgresScope {
	private readonly connection: Connection;
	private readonly context = new AsyncLocalStorage<PoolClient>();
	private sequence = 0;
	private readonly schema: string;
	readonly accountId?: string;
	constructor(root: string, kind: "identity" | "workspace", accountId?: string) {
		this.connection = connectionFor(root);
		this.schema = kind === "identity" ? this.connection.identitySchema : this.connection.workspaceSchema;
		this.accountId = accountId;
	}
	async transaction<T>(work: () => Promise<T> | T, lock = true): Promise<T> {
		const active = this.context.getStore();
		if (active) {
			const savepoint = `nested_${++this.sequence}`;
			await active.query(`SAVEPOINT ${savepoint}`);
			try {
				const value = await work();
				await active.query(`RELEASE SAVEPOINT ${savepoint}`);
				return value;
			} catch (error) {
				await active.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
				await active.query(`RELEASE SAVEPOINT ${savepoint}`);
				throw error;
			}
		}
		await this.connection.ready;
		const client = await this.connection.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(`SET LOCAL search_path TO ${identifier(this.schema)}, pg_catalog`);
			await client.query("SELECT set_config('setdraft.account_id',$1,true)", [this.accountId ?? ""]);
			// Serialize short workspace commits; filesystem staging and model/sandbox work stay outside transactions.
			if (lock)
				await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
					`${this.schema}:${this.accountId ?? "identity"}`,
				]);
			const value = await this.context.run(client, work);
			await client.query("COMMIT");
			return value;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
	async all<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<T[]> {
		const client = this.context.getStore();
		if (!client) return this.transaction(() => this.all<T>(text, values), false);
		const result = await client.query(text, [...values]);
		return result.rows as T[];
	}
	async one<T = Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<T | undefined> {
		return (await this.all<T>(text, values))[0];
	}
	async execute(text: string, values: readonly unknown[] = []): Promise<{ rowCount: number }> {
		const client = this.context.getStore();
		if (!client) return this.transaction(() => this.execute(text, values), false);
		const result = await client.query(text, [...values]);
		return { rowCount: result.rowCount ?? 0 };
	}
	async close(): Promise<void> {
		/* Pool ownership belongs to application lifecycle. */
	}
}

/** The in-process execution scheduler has exactly one owner across all deployments of this database. */
export async function acquireApplicationLease(root: string): Promise<() => Promise<void>> {
	const connection = connectionFor(root);
	await connection.ready;
	const client = await connection.pool.connect();
	const result = await client.query<{ locked: boolean }>(
		"SELECT pg_try_advisory_lock(hashtextextended('setdraft-server',0)) AS locked",
	);
	if (!result.rows[0]?.locked) {
		client.release();
		throw new Error("Another Setdraft server or maintenance job is using this database.");
	}
	client.on("error", () => {
		console.error("Database lease lost; stopping Setdraft.");
		process.kill(process.pid, "SIGTERM");
	});
	return async () => {
		await client.query("SELECT pg_advisory_unlock(hashtextextended('setdraft-server',0))").catch(() => {});
		client.release();
	};
}
