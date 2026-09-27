import { Pool } from "pg";
import { identifier } from "./postgres.ts";

/** Runs with the maintenance role, never the restricted HTTP application's role. */
export async function migrateDatabase(
	url: string,
	appRole = "setdraft_app",
	prefix = "",
	appPassword?: string,
): Promise<void> {
	const pool = new Pool({ connectionString: url, max: 1 });
	const client = await pool.connect();
	const identity = identifier(`${prefix}identity`),
		workspace = identifier(`${prefix}workspace`),
		role = identifier(appRole);
	try {
		await client.query("BEGIN");
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${prefix}setdraft-schema`]);
		const existingRole = await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [appRole]);
		if (!existingRole.rowCount) {
			if (!appPassword || !/^[A-Za-z0-9_-]{24,128}$/u.test(appPassword))
				throw new Error("Missing application database role; configure SETDRAFT_DB_APP_PASSWORD.");
			await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${appPassword}'`);
		}

		await client.query(`CREATE SCHEMA IF NOT EXISTS ${identity};CREATE SCHEMA IF NOT EXISTS ${workspace};
   CREATE TABLE IF NOT EXISTS ${identity}.schema_version(version integer PRIMARY KEY);
   CREATE TABLE IF NOT EXISTS ${identity}.metadata(key text PRIMARY KEY,value text NOT NULL);
   CREATE TABLE IF NOT EXISTS ${identity}.users(id text PRIMARY KEY,username text UNIQUE NOT NULL,password_hash text NOT NULL,
    role text NOT NULL CHECK(role IN ('admin','user')),enabled integer NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    must_change_password integer NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),created_at double precision NOT NULL);
   CREATE TABLE IF NOT EXISTS ${identity}.sessions(token_hash text PRIMARY KEY,user_id text NOT NULL REFERENCES ${identity}.users(id),csrf_token text NOT NULL,
    created_at double precision NOT NULL,last_seen double precision NOT NULL,expires_at double precision NOT NULL);
   CREATE INDEX IF NOT EXISTS sessions_user ON ${identity}.sessions(user_id);
   CREATE TABLE IF NOT EXISTS ${identity}.login_limits(key text PRIMARY KEY,count integer NOT NULL,expires_at double precision NOT NULL);
   CREATE TABLE IF NOT EXISTS ${identity}.audit(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id text,action text NOT NULL,subject_id text,created_at double precision NOT NULL);
   CREATE TABLE IF NOT EXISTS ${identity}.settings(key text PRIMARY KEY,value text NOT NULL);
   CREATE TABLE IF NOT EXISTS ${identity}.search_usage(user_id text NOT NULL,day text NOT NULL,count integer NOT NULL,PRIMARY KEY(user_id,day));
  `);
		const version = await client.query<{ version: number }>(
			`SELECT version FROM ${identity}.schema_version ORDER BY version DESC LIMIT 1`,
		);
		if ((version.rows[0]?.version ?? 0) > 1) throw new Error("Database schema is newer than this application.");
		const account = "account_id uuid NOT NULL DEFAULT nullif(current_setting('setdraft.account_id',true),'')::uuid";
		await client.query(`
   CREATE TABLE IF NOT EXISTS ${workspace}.documents(${account},kind text NOT NULL,id text NOT NULL,body jsonb NOT NULL,version integer NOT NULL DEFAULT 0,PRIMARY KEY(account_id,kind,id));
   CREATE INDEX IF NOT EXISTS documents_format ON ${workspace}.documents(account_id,kind,(body->>'scoringMode'));
   CREATE TABLE IF NOT EXISTS ${workspace}.files(${account},owner_kind text NOT NULL,owner_id text NOT NULL,name text NOT NULL,hash text NOT NULL,size double precision NOT NULL,PRIMARY KEY(account_id,owner_kind,owner_id,name));
   CREATE INDEX IF NOT EXISTS files_hash ON ${workspace}.files(account_id,hash);
   CREATE TABLE IF NOT EXISTS ${workspace}.tasks(${account},id text NOT NULL,kind text NOT NULL,resource text NOT NULL,format text,state text NOT NULL,fingerprint text NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,result text,error text,owner_pid integer,cancel_requested integer NOT NULL DEFAULT 0,PRIMARY KEY(account_id,id));
   CREATE UNIQUE INDEX IF NOT EXISTS task_resource_active ON ${workspace}.tasks(account_id,resource) WHERE state IN ('queued','running');
   CREATE TABLE IF NOT EXISTS ${workspace}.task_events(${account},sequence integer GENERATED ALWAYS AS IDENTITY,task_id text NOT NULL,type text NOT NULL,message text NOT NULL,created_at text NOT NULL,data text,PRIMARY KEY(account_id,sequence),FOREIGN KEY(account_id,task_id) REFERENCES ${workspace}.tasks(account_id,id) ON DELETE CASCADE);
   CREATE INDEX IF NOT EXISTS task_events_task ON ${workspace}.task_events(account_id,task_id,sequence);
   CREATE TABLE IF NOT EXISTS ${workspace}.chat_requests(${account},id text NOT NULL,chat_id text NOT NULL,payload text NOT NULL,fingerprint text NOT NULL,state text NOT NULL,created_at text NOT NULL,updated_at text NOT NULL,error text,owner_pid integer,cancel_requested integer NOT NULL DEFAULT 0,PRIMARY KEY(account_id,id));
   CREATE UNIQUE INDEX IF NOT EXISTS chat_one_active_request ON ${workspace}.chat_requests(account_id,chat_id) WHERE state IN ('queued','running');
   CREATE TABLE IF NOT EXISTS ${workspace}.chat_request_events(${account},sequence integer GENERATED ALWAYS AS IDENTITY,request_id text NOT NULL,type text NOT NULL,data text NOT NULL,PRIMARY KEY(account_id,sequence),FOREIGN KEY(account_id,request_id) REFERENCES ${workspace}.chat_requests(account_id,id) ON DELETE CASCADE);
   CREATE INDEX IF NOT EXISTS chat_request_event_lookup ON ${workspace}.chat_request_events(account_id,request_id,sequence);
  `);
		for (const table of ["documents", "files", "tasks", "task_events", "chat_requests", "chat_request_events"]) {
			await client.query(`ALTER TABLE ${workspace}.${table} ENABLE ROW LEVEL SECURITY;ALTER TABLE ${workspace}.${table} FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS user_isolation ON ${workspace}.${table};
    CREATE POLICY user_isolation ON ${workspace}.${table} USING(account_id=nullif(current_setting('setdraft.account_id',true),'')::uuid) WITH CHECK(account_id=nullif(current_setting('setdraft.account_id',true),'')::uuid);`);
		}
		await client.query(`GRANT USAGE ON SCHEMA ${identity},${workspace} TO ${role};
   GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${identity},${workspace} TO ${role};
   GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${identity},${workspace} TO ${role};
   INSERT INTO ${identity}.schema_version VALUES(1) ON CONFLICT DO NOTHING;`);
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		client.release();
		await pool.end();
	}
}
