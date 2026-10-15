/**
 * Applies tools/schema.sql to DATABASE_URL and lists what it created.
 *
 * The server applies the schema at boot too, so this exists for the cases where
 * you want the database ready without starting the API — checking that a
 * connection string works before deploying, or creating the tables ahead of a
 * first request.
 *
 * Every statement is idempotent (CREATE TABLE IF NOT EXISTS), so running it
 * against a live database is safe and changes nothing.
 *
 * Usage: DATABASE_URL=postgres://... node tools/migrate.mjs
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SCHEMA_PATH, needsSsl } from "./store.mjs";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. See .env.local.example, or pass it inline:");
  console.error("  DATABASE_URL=postgres://... node tools/migrate.mjs");
  process.exit(2);
}

const client = new Client({
  connectionString,
  ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
});

try {
  await client.connect();
} catch (err) {
  console.error(`could not connect: ${err.message}`);
  process.exit(1);
}

try {
  await client.query(await readFile(SCHEMA_PATH, "utf8"));
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  const { rows: indexes } = await client.query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%unique' ORDER BY indexname"
  );
  console.log(`schema applied to ${connectionString.replace(/:[^:@/]+@/, ":***@")}`);
  console.log(`  tables  : ${rows.map((r) => r.tablename).join(", ")}`);
  console.log(`  unique  : ${indexes.map((r) => r.indexname).join(", ") || "none"}`);
} catch (err) {
  console.error(`migration failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
