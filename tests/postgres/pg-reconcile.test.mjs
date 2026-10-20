/**
 * Reconciliation against a real PostgreSQL server.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The main reconciliation suite runs on the
 * in-memory store, where the claim on a deposit is a JavaScript check and two
 * workers would both see `pending`. In a deployment, two things this feature
 * depends on come from the database and nothing else:
 *
 *   * the claim (`UPDATE … WHERE status = 'pending' AND next_reconcile_at <= …`)
 *     is one statement, so exactly one worker can take a deposit;
 *   * the unique index on `deposits.provider_reference` is the backstop that
 *     makes a reused M-Pesa receipt impossible rather than merely unlikely.
 *
 * No in-memory test touches either. With no database configured this file exits
 * non-zero and says what to set — a skipped test that reports success would be
 * worse than no test at all.
 *
 * Run:
 *
 *   PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres
 *
 * It uses its own variable and ignores DATABASE_URL on purpose: this file drops
 * a schema, and a stray DATABASE_URL pointing at anything real must not be
 * destroyed by a test run. Everything happens inside a randomly named schema.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresStore } from "../../tools/store.mjs";
import { ApiError, createPaymentRoutes } from "../../tools/payments.mjs";
import { reconcileConfig } from "../../tools/reconcile.mjs";

/* --------------------------- prerequisites --------------------------- */

const TEST_URL = process.env.PG_TEST_DATABASE_URL || "";

if (!TEST_URL) {
  console.error(
    [
      "",
      "pg-reconcile needs a disposable PostgreSQL server and will not substitute one.",
      "",
      "  PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres",
      "",
      "It is kept in its own variable on purpose: this suite creates a schema and",
      "drops it again, so it must never be aimed at a database you care about.",
      "A local server, a container, or a free hosted instance all work.",
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

const SCHEMA = `strategyoption_recon_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const FAST = { MPESA_RECONCILE_AFTER_MS: "1000" };

const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });

/** A query answer for a completed payment, with metadata the settlement can verify. */
const paid = (checkoutId, receipt, amount = 130) => ({
  ResponseCode: "0",
  CheckoutRequestID: checkoutId,
  ResultCode: "0",
  ResultDesc: "The service request is processed successfully.",
  CallbackMetadata: {
    Item: [
      { Name: "Amount", Value: amount },
      { Name: "MpesaReceiptNumber", Value: receipt },
      { Name: "TransactionDate", Value: 20261014153045 },
      { Name: "PhoneNumber", Value: 254712345678 },
    ],
  },
});

/** Answers by the id it was asked about, so a batch stays deterministic. */
function scriptFor(map) {
  const calls = [];
  const provider = async (request) => {
    calls.push(request);
    const next = map[request.checkoutRequestId];
    if (next === undefined) throw Object.assign(new Error("no scripted answer"), { code: "TEST_NO_SCRIPT" });
    if (next instanceof Error) throw next;
    return next;
  };
  provider.calls = calls;
  return provider;
}

describe("PostgreSQL reconciliation", () => {
  let store;
  let sql;

  before(async () => {
    // `search_path` selects a schema, it does not create one: connecting with a
    // schema that does not exist yet makes the store's boot step fail on its
    // first unqualified CREATE TABLE (3F000). So the schema is created first.
    const { default: pg } = await import("pg");
    const bootstrap = new pg.Client({ connectionString: TEST_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();

    store = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    sql = new pg.Client({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    await sql.connect();
  });

  after(async () => {
    try {
      await store.close();
    } catch {
      /* a test may have closed it already */
    }
    await sql.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
  });

  async function seedAccount(name) {
    return store.createUser({
      id: `u_${name}`,
      email: `${name}@pgrecon.example`,
      username: name,
      salt: "pgtest-salt",
      password_hash: "pgtest-hash",
      is_demo: false,
      demo_balance: 0,
      real_balance: 0,
      referral_code: name.slice(0, 6).toUpperCase(),
    });
  }

  async function seedPending(user, { reference, checkoutId, kes = 130, usd = 1, ageMs = 60_000 }) {
    return store.insertDeposit({
      id: `dep_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
      reference,
      method: "mpesa",
      amount: kes,
      currency: "KES",
      usd_amount: usd,
      settlement_currency: "KES",
      settlement_amount: kes,
      settlement_rate: kes / usd,
      status: "pending",
      is_demo: false,
      provider_reference: checkoutId,
      checkout_request_id: checkoutId,
      merchant_request_id: `mr_${checkoutId}`,
      created_at: new Date(Date.now() - ageMs).toISOString(),
      completed_at: null,
    });
  }

  const routesFor = (target, provider, reconcile = FAST) =>
    createPaymentRoutes({
      store: target,
      requireUser: async () => {
        throw new ApiError(401, "UNAUTHENTICATED", "Not authorised");
      },
      providers: {
        darajaStkPush: async () => ({ CheckoutRequestID: "ws_CO_FIXTURE" }),
        darajaStkQuery: provider,
        cardCharge: async () => ({ id: "pi_fixture" }),
        tronDepositAddress: async () => ({ address: "TFixture", network: "TRC20" }),
      },
      exchange: { get: async () => ({ base: "USD", quote: "KES", pair: "USD/KES", rate: 130, fetchedAt: Date.now(), cached: false }) },
      reconcile: reconcileConfig(reconcile),
      logger: quiet(),
    });

  test("the migration added the reconciliation columns and the due index", async () => {
    const columns = await sql.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'deposits'`,
      [SCHEMA]
    );
    const names = columns.rows.map((r) => r.column_name);
    for (const required of ["recon_attempts", "last_reconciled_at", "next_reconcile_at", "recon_outcome"]) {
      assert.ok(names.includes(required), `deposits.${required} exists (got ${names.join(", ")})`);
    }

    const indexes = await sql.query("SELECT indexname FROM pg_indexes WHERE schemaname = $1", [SCHEMA]);
    const indexNames = indexes.rows.map((r) => r.indexname);
    assert.ok(
      indexNames.includes("deposits_reconciliation_due_idx"),
      `the partial scan index exists (got ${indexNames.join(", ")})`
    );
    assert.ok(indexNames.includes("deposits_provider_reference_unique"), "and the receipt-uniqueness backstop");
  });

  test("two workers on separate connections cannot both claim one deposit", async () => {
    const user = await seedAccount("claimracer");
    const deposit = await seedPending(user, { reference: "PAL_PG_CLAIM_RACE", checkoutId: "ws_CO_PG_CLAIM" });

    // Two stores, two pools, two processes' worth of state — only the database is
    // shared between them.
    const a = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    const b = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    try {
      const now = Date.now();
      const results = await Promise.all([
        a.claimDepositForReconciliation(deposit.id, { now, nextAt: now + 30_000 }),
        b.claimDepositForReconciliation(deposit.id, { now, nextAt: now + 30_000 }),
      ]);
      const claimed = results.filter(Boolean);
      assert.equal(claimed.length, 1, "exactly one worker claimed it");

      const after = await store.findDeposit("PAL_PG_CLAIM_RACE");
      assert.equal(after.recon_attempts, 1, "the attempt was counted once, not twice");
    } finally {
      await a.close();
      await b.close();
    }
  });

  test("two route instances reconciling the same deposit credit exactly once", async () => {
    const user = await seedAccount("routepayer");
    const deposit = await seedPending(user, { reference: "PAL_PG_ROUTE_RACE", checkoutId: "ws_CO_PG_ROUTE" });

    // Separate pools again, so the in-process mutex inside `settleDeposit` is not
    // shared: the row lock and the unique ledger index are what must hold.
    const a = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    const b = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    try {
      const routesA = routesFor(a, scriptFor({ ws_CO_PG_ROUTE: paid("ws_CO_PG_ROUTE", "PGROUTE00001") }));
      const routesB = routesFor(b, scriptFor({ ws_CO_PG_ROUTE: paid("ws_CO_PG_ROUTE", "PGROUTE00001") }));
      await Promise.all([
        routesA._reconcile.reconcileOne(await a.findDeposit("PAL_PG_ROUTE_RACE")),
        routesB._reconcile.reconcileOne(await b.findDeposit("PAL_PG_ROUTE_RACE")),
      ]);
    } finally {
      await a.close();
      await b.close();
    }

    const account = await store.findUserById(user.id);
    assert.equal(Number(account.real_balance), 1, "credited exactly once, whichever worker won");

    const tx = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [
      "PAL_PG_ROUTE_RACE",
    ]);
    assert.equal(tx.rows[0].n, 1, "exactly one ledger entry");

    const after = await store.findDeposit("PAL_PG_ROUTE_RACE");
    assert.equal(after.status, "completed", "the deposit is completed");
    assert.equal(after.provider_reference, "PGROUTE00001", "with the provider's receipt attached");
    assert.equal(after.recon_attempts, 1, "the losing worker never got a claim, so never counted an attempt");
  });

  test("one M-Pesa receipt cannot settle two deposits", async () => {
    const user = await seedAccount("reuse");
    await seedPending(user, { reference: "PAL_PG_REUSE_A", checkoutId: "ws_CO_REUSE_A" });
    await seedPending(user, { reference: "PAL_PG_REUSE_B", checkoutId: "ws_CO_REUSE_B" });

    const provider = scriptFor({
      ws_CO_REUSE_A: paid("ws_CO_REUSE_A", "PGREUSE00001"),
      ws_CO_REUSE_B: paid("ws_CO_REUSE_B", "PGREUSE00001"), // the same receipt, on purpose
    });
    await routesFor(store, provider)._reconcile.runOnce({ reason: "test" });

    const account = await store.findUserById(user.id);
    assert.equal(Number(account.real_balance), 1, "one payment credits one wallet");

    // Scoped to this account: other tests in this file have already credited
    // their own users, so an unscoped count would be counting their entries.
    const tx = await sql.query(
      "SELECT count(*)::int AS n FROM transactions WHERE type = 'deposit' AND user_id = $1",
      [user.id]
    );
    assert.equal(tx.rows[0].n, 1, "one ledger entry for this account");

    // Scoped to this account: an unscoped count would pick up every deposit the
    // earlier tests in this file completed.
    const completed = await sql.query(
      "SELECT count(*)::int AS n FROM deposits WHERE user_id = $1 AND status = 'completed'",
      [user.id]
    );
    assert.equal(completed.rows[0].n, 1, "only one of the two deposits completed");

    // The other one is not silently credited and not silently dropped: it is left
    // unsettled and flagged for a human, which is the only safe answer when the
    // provider claims a payment that a second deposit has already claimed.
    const loser = await store.findDeposit("PAL_PG_REUSE_B");
    assert.equal(loser.status, "pending", "the second deposit stays unsettled");
    assert.equal(loser.recon_outcome, "needs_review", "and is flagged for review");
    assert.equal(loser.next_reconcile_at, null, "with no further automatic attempts");
  });

  test("the claim survives a restart: a fresh pool does not redo an attempt", async () => {
    const user = await seedAccount("restart");
    await seedPending(user, { reference: "PAL_PG_RESTART", checkoutId: "ws_CO_PG_RESTART", ageMs: 60_000 });

    // A long backoff, deliberately. This asserts that the next attempt is a
    // fact in the database that a new process reads back — not that a wall clock
    // outran a 30-second default while the rest of the suite was using the
    // machine. With a short window, a loaded runner can expire the backoff
    // between the two runs and fail the test for a reason it is not about.
    const patient = { ...FAST, MPESA_RECONCILE_BACKOFF_MS: "600000", MPESA_RECONCILE_MAX_BACKOFF_MS: "600000" };

    // First attempt: the provider errors, so the deposit is scheduled for later.
    await routesFor(store, scriptFor({ ws_CO_PG_RESTART: Object.assign(new Error("boom"), { code: "DARAJA_QUERY_FAILED" }) }), patient)
      ._reconcile.runOnce({ reason: "before restart" });

    const first = await store.findDeposit("PAL_PG_RESTART");
    assert.equal(first.recon_attempts, 1, "attempt recorded in the database");
    assert.ok(first.next_reconcile_at, "and so is the next attempt");

    // A new process, a new pool, and no memory of the first one.
    const fresh = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    try {
      const provider = scriptFor({ ws_CO_PG_RESTART: paid("ws_CO_PG_RESTART", "PGAFTER00001") });
      const summary = await routesFor(fresh, provider, patient)._reconcile.runOnce({ reason: "after restart" });

      assert.equal(summary.considered, 0, "the backoff set before the restart is still respected");
      assert.equal(provider.calls.length, 0, "so the provider was not asked again");

      const second = await fresh.findDeposit("PAL_PG_RESTART");
      assert.equal(second.recon_attempts, 1, "the attempt count did not reset");
      assert.equal(second.status, "pending", "and the deposit is still pending, awaiting its next attempt");
    } finally {
      await fresh.close();
    }
  });

  test("a provider-confirmed failure fails the deposit once and credits nothing", async () => {
    const user = await seedAccount("pgfailed");
    await seedPending(user, { reference: "PAL_PG_FAILED", checkoutId: "ws_CO_PG_FAILED" });

    const provider = scriptFor({
      ws_CO_PG_FAILED: { ResponseCode: "0", CheckoutRequestID: "ws_CO_PG_FAILED", ResultCode: "1032", ResultDesc: "Request cancelled by user" },
    });
    const routes = routesFor(store, provider);

    // Two runs in a row: the second must not find anything to do.
    await routes._reconcile.runOnce({ reason: "first" });
    const second = await routes._reconcile.runOnce({ reason: "second" });

    assert.equal(second.considered, 0, "a resolved deposit is not queried again");
    assert.equal(provider.calls.length, 1, "one query, not two");

    const failed = await store.findDeposit("PAL_PG_FAILED");
    assert.equal(failed.status, "failed", "the deposit is failed");
    assert.equal(failed.mpesa_result_code, 1032, "with the provider's code");
    assert.equal(Number((await store.findUserById(user.id)).real_balance), 0, "nothing was credited");
  });
});
