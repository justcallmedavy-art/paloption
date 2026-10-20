/**
 * Whether an account outlives the process that created it.
 *
 * WHY THIS FILE EXISTS. The sign-in failures reported on 2026-10-18 were first
 * blamed on sign-out, and the honest answer needed a fact no in-memory test can
 * supply: an account must still be there after the API process restarts.
 * `DATABASE_URL` decides that. With one, the ledger is Postgres and a restart is
 * invisible; without one, the store is a `Map` in the process — sign-up succeeds,
 * sign-in works until the next restart, and then "Invalid email or password" is
 * the only thing the visitor can see. Nothing in the in-memory suite can tell
 * those two apart, because the in-memory store has no second instance to be
 * asked.
 *
 * So this suite starts a store, writes an account and a session, CLOSES it, opens
 * a fresh store against the same database, and signs in again with the same
 * password — the smallest honest model of a restart.
 *
 * With no database configured it exits non-zero and says what to set, like the
 * other PostgreSQL suites: a skipped test that reports success would be worse
 * than no test at all.
 *
 * Run:
 *
 *   PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres
 *
 * It uses its own variable and ignores DATABASE_URL on purpose — this file drops
 * a schema, and a stray DATABASE_URL pointing at anything real must not be
 * destroyed by a test run. Everything happens inside a randomly named schema.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { createPostgresStore } from "../../tools/store.mjs";

/* --------------------------- prerequisites --------------------------- */

const TEST_URL = process.env.PG_TEST_DATABASE_URL || "";

if (!TEST_URL) {
  console.error(
    [
      "",
      "pg-auth needs a disposable PostgreSQL server and will not substitute one.",
      "",
      "  PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres",
      "",
      "It is kept in its own variable on purpose: this suite creates a schema and",
      "drops it again, so it must never be aimed at a database you care about.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const schemaUrl = (url, schema) => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
};

const SCHEMA = `strategyoption_auth_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** The server's own password scheme, so the round trip is the real one. */
const hash = (password, salt) => scryptSync(password, salt, 32).toString("hex");

const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });

describe("an account survives an API restart", () => {
  let admin;

  before(async () => {
    // `search_path` selects a schema, it does not create one: connecting with a
    // schema that does not exist yet makes the store's boot step fail on its
    // first unqualified CREATE TABLE (3F000). So the schema is created first.
    const { default: pg } = await import("pg");
    admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  });

  after(async () => {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  /** One "process": its own pool, its own store, opened and closed again. */
  const withStore = async (fn) => {
    const store = await createPostgresStore({
      connectionString: schemaUrl(TEST_URL, SCHEMA),
      logger: quiet(),
    });
    try {
      return await fn(store);
    } finally {
      await store.close();
    }
  };

  const email = `restart.${randomUUID().slice(0, 8)}@example.invalid`;
  const password = "CorrectHorse9";
  let salt;
  let user;

  test("a registration is on disk before the process that made it goes away", async () => {
    ({ salt, user } = await withStore(async (store) => {
      const salt = randomBytes(16).toString("hex");
      const created = await store.createUser({
        id: `u_${randomUUID().slice(0, 8)}`,
        email,
        username: "restart.probe",
        salt,
        password_hash: hash(password, salt),
        is_demo: false,
        demo_balance: 10000,
        real_balance: 250,
        referral_code: "RESTRT",
      });
      const token = `tok_${randomUUID().replace(/-/g, "")}`;
      await store.createSession(token, created.id);
      return { salt, user: { ...created, token } };
    }));

    assert.ok(user.id, "the account was created");
    assert.equal(user.real_balance, 250);
  });

  test("a fresh process finds it, and the same password still verifies", async () => {
    const found = await withStore((store) => store.findUserByEmail(email));
    assert.ok(found, "the account is still there after the restart");
    assert.equal(found.username, "restart.probe");
    assert.equal(found.salt, salt, "the salt that hashed the password is unchanged");
    assert.equal(
      found.password_hash,
      hash(password, salt),
      "the stored hash still matches the password the account was made with"
    );
    assert.equal(found.real_balance, 250, "the balance survived too");
  });

  test("a wrong password is still a wrong password across the restart", async () => {
    const found = await withStore((store) => store.findUserByEmail(email));
    const attempt = hash("not-the-password", found.salt);
    assert.notEqual(attempt, found.password_hash);
    // timingSafeEqual is what a real comparison does; here it also proves the two
    // hashes are the same length, which the store relies on being.
    const a = Buffer.from(attempt, "hex");
    const b = Buffer.from(found.password_hash, "hex");
    assert.equal(a.length, b.length);
    assert.equal(timingSafeEqual(a, b), false);
  });

  test("a token issued before the restart still identifies the account after it", async () => {
    const userId = await withStore((store) => store.userIdForToken(user.token));
    assert.equal(userId, user.id, "the session is in the database, not in the process");
  });

  test("signing in again after the restart works, and issues its own session", async () => {
    const next = await withStore(async (store) => {
      const found = await store.findUserByEmail(email);
      assert.ok(found.password_hash === hash(password, found.salt), "the sign-in would succeed");
      const token = `tok_${randomUUID().replace(/-/g, "")}`;
      await store.createSession(token, found.id);
      return { token, id: found.id };
    });
    assert.equal(next.id, user.id);
    const resolved = await withStore((store) => store.userIdForToken(next.token));
    assert.equal(resolved, user.id);
    // Both sessions remain valid: signing in elsewhere must not sign you out.
    assert.equal(await withStore((store) => store.userIdForToken(user.token)), user.id);
  });

  test("there is no account-deletion call in the store's surface", () => {
    // Signing out cannot delete an account, and neither can anything else the
    // API is able to call: the store exposes no such method at all.
    return withStore((store) => {
      for (const name of ["deleteUser", "removeUser", "deleteAccount", "purgeUser"]) {
        assert.equal(typeof store[name], "undefined", `store.${name} must not exist`);
      }
    });
  });
});
