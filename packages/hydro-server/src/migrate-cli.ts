import { migrateDatabase } from "./database-schema.ts";

const url = process.env.SETDRAFT_DATABASE_ADMIN_URL;
if (!url) throw new Error("SETDRAFT_DATABASE_ADMIN_URL is required for database maintenance.");
await migrateDatabase(url, "setdraft_app", "", process.env.SETDRAFT_DB_APP_PASSWORD);
console.log("Setdraft PostgreSQL schema is ready.");
