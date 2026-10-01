import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { Pool } from "pg";
import { afterEach, beforeEach } from "vitest";
import { migrateDatabase } from "../src/database-schema.ts";
import { closeDatabasePools, identifier, registerDatabase } from "../src/postgres.ts";

let prefix: string;
const adminUrl = process.env.SETDRAFT_TEST_DATABASE_URL;
if (!adminUrl) throw new Error("Set SETDRAFT_TEST_DATABASE_URL to a dedicated PostgreSQL test database (see README).");
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const appUrl = new URL(adminUrl);
appUrl.username = "setdraft_app";
appUrl.password = process.env.SETDRAFT_TEST_APP_PASSWORD ?? "setdraft-test-only";
beforeEach(async () => {
	prefix = `test_${randomUUID().replaceAll("-", "")}_`;
	await migrateDatabase(adminUrl, "setdraft_app", prefix);
	const pool = new Pool({ connectionString: appUrl.toString(), max: 12 });
	registerDatabase(tmpdir(), {
		pool,
		identitySchema: `${prefix}identity`,
		workspaceSchema: `${prefix}workspace`,
		ready: Promise.resolve(),
	});
});
afterEach(async () => {
	await closeDatabasePools();
	await admin.query(
		`DROP SCHEMA IF EXISTS ${identifier(`${prefix}workspace`)} CASCADE; DROP SCHEMA IF EXISTS ${identifier(`${prefix}identity`)} CASCADE`,
	);
});

import { afterAll } from "vitest";

afterAll(async () => {
	await admin.end();
});

/** A real PostgreSQL failure verifies rollback, rather than mocking the transaction under test. */
export async function rejectWrites(
	table: "documents" | "task_events" | "chat_request_events",
	event: "INSERT" | "UPDATE",
	column: "kind" | "type",
	value: string,
	message: string,
): Promise<() => Promise<void>> {
	const schema = identifier(`${prefix}workspace`);
	const literal = (input: string) => `'${input.replaceAll("'", "''")}'`;
	await admin.query(
		`CREATE FUNCTION ${schema}.reject_test_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.${column}=${literal(value)} THEN RAISE EXCEPTION ${literal(message)}; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_write BEFORE ${event} ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_test_write()`,
	);
	return async () => {
		await admin.query(
			`DROP TRIGGER reject_test_write ON ${schema}.${table};DROP FUNCTION ${schema}.reject_test_write()`,
		);
	};
}
