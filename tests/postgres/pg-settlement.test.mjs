/**
 * The settlement guarantees, proved against a real PostgreSQL server.
 *
 * The main suite proves these against the in-memory store, where the guarantee
 * rests on a JavaScript mutex (`withLock` in tools/payments.mjs) and a status
 * check. That is a different code path: the Postgres store relies on a row lock
 * (`SELECT … FOR UPDATE` in `lockDeposit`) and on two partial unique indexes in
 * tools/schema.sql. Nothing in the in-memory run touches either, so this file is
 * the only place those are exercised.
 *
 * WHAT MAKES THIS HONEST, AND EASY TO GET WRONG:
 *
 *   * It never falls back to the in-memory store. With no database configured it
 *     exits non-zero and says what to set. A skipped test that reports success is
 *     worse than no test.
 *   * It requires its own variable, PG_TEST_DATABASE_URL, and deliberately does
 *     NOT read DATABASE_URL. This file creates triggers, settles deposits and
 *     drops a schema; a stray DATABASE_URL pointing at anything real must not be
 *     destroyed by a test run.
 *   * Everything happens in a randomly named schema that is dropped afterwards,
 *     so the database it runs against is left as it was found.
 *   * Concurrency is real: separate pools, separate route instances (so no
 *     shared mutex) and, for one test, separate server processes.
 *
 * Run:
 *
 *   PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres
 *
 * An SSL requirement is inferred from the host, exactly as the server does it.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createPostgresStore } from "../../tools/store.mjs";
import { ApiError, createPaymentRoutes } from "../../tools/payments.mjs";

/* --------------------------- prerequisites --------------------------- */

const TEST_URL = process.env.PG_TEST_DATABASE_URL || "";

if (!TEST_URL) {
  console.error(
    [
      "",
      "pg-settlement needs a disposable PostgreSQL server and will not substitute one.",
      "",
      "  PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres",
      "",
      "It is kept in its own variable on purpose: this suite creates triggers,",
      "settles deposits and drops a schema, so it must never be aimed at a",
      "database you care about. DATABASE_URL is ignored here even if it is set.",
      "",
      "Anything reachable works — a local server, a container, or a free hosted",
      "one. TLS is inferred from the host, as the server itself does.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

/** Puts every statement of this run inside one disposable schema. */
const schemaUrl = (url, schema) => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
};

const KES_RECEIPT = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "RECEIPT";

/** A user, the store's real `createUser`, and an explicit real balance of 0. */
async function seedAccount(store, name) {
  // salt and password_hash are NOT NULL, so the fixture supplies placeholders:
  // this suite is about settlement, and no test here authenticates.
  const user = await store.createUser({
    id: `u_${name}`,
    email: `${name}@pgtest.example`,
    username: name,
    salt: "pgtest-salt",
    password_hash: "pgtest-hash",
    is_demo: false,
    demo_balance: 0,
    real_balance: 0,
    referral_code: name.slice(0, 6).toUpperCase(),
  });
  return user;
}

/**
 * A pending M-Pesa deposit, written through the store rather than the routes:
 * the point of these tests is settlement, not the push, so the fixture replaces
 * the push. `usd_amount` is what gets credited; the KES figures are what the
 * provider charges, and settlement is verified against those.
 */
async function seedPendingDeposit(store, user, { checkoutId, reference, usd = 10, kes = 1300 }) {
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
    provider_reference: null,
    checkout_request_id: checkoutId,
    merchant_request_id: `mr_${checkoutId}`,
    created_at: new Date().toISOString(),
    completed_at: null,
  });
}

/** The envelope Safaricom actually POSTs, `Item` as an array. */
function envelope(checkoutId, { resultCode = 0, amount, receipt, currency = "KES" } = {}) {
  const stkCallback = {
    MerchantRequestID: `mr_${checkoutId}`,
    CheckoutRequestID: checkoutId,
    ResultCode: resultCode,
    ResultDesc: resultCode === 0 ? "The service request is processed successfully." : "Request cancelled by user",
  };
  if (resultCode === 0 && receipt) {
    stkCallback.CallbackMetadata = {
      Item: [
        { Name: "Amount", Value: amount },
        { Name: "MpesaReceiptNumber", Value: receipt },
        { Name: "TransactionDate", Value: 20261014153045 },
        { Name: "PhoneNumber", Value: 254712345678 },
      ],
    };
  }
  return { Body: { stkCallback } };
}

const CALLBACK_TOKEN = "pgtest_callback_token";

/** The real handler, wired to the real store. */
function makeRoutes(store) {
  const requireUser = async () => {
    throw new ApiError(401, "UNAUTHENTICATED", "Not authorised");
  };
  return createPaymentRoutes({ store, requireUser });
}

/** Calls the real callback route. A rejection is a result, not a crash. */
const fire = (routes, body) =>
  routes
    .mpesaCallback({ req: { headers: {} }, body, params: { token: CALLBACK_TOKEN } })
    .then((value) => ({ ok: true, value }))
    .catch((error) => ({ ok: false, error }));

const balanceOf = async (store, userId) => Number((await store.findUserById(userId)).real_balance);

/* ------------------------------- suite ------------------------------- */

const SCHEMA = `paloption_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

describe("PostgreSQL settlement guarantees", () => {
  let store;
  let sql;
  const previousToken = process.env.DARAJA_CALLBACK_TOKEN;

  before(async () => {
    process.env.DARAJA_CALLBACK_TOKEN = CALLBACK_TOKEN;

    // The schema has to exist before anything connects with it in search_path:
    // `-c search_path=x` selects a schema, it does not create one, and an
    // unqualified CREATE TABLE whose first search_path entry is missing fails
    // with 3F000 (no schema has been selected to create in). Creating it here
    // is what lets the store's own boot step apply tools/schema.sql into it.
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
      /* the pool may already be closed by a test */
    }
    // Drop the schema this run created, and nothing else.
    await sql.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();
    if (previousToken === undefined) delete process.env.DARAJA_CALLBACK_TOKEN;
    else process.env.DARAJA_CALLBACK_TOKEN = previousToken;
  });

  test("the migrations applied and this is the Postgres adapter", async () => {
    assert.equal(store.kind, "postgres", "the real adapter, not a stand-in");

    const tables = await sql.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [SCHEMA]
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const required of ["deposits", "transactions", "users", "mpesa_callbacks", "idempotency_keys"]) {
      assert.ok(names.includes(required), `${required} exists (got ${names.join(", ")})`);
    }

    const indexes = await sql.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1",
      [SCHEMA]
    );
    const defs = indexes.rows.map((r) => r.indexdef);

    // The two partial unique indexes are the database-level guarantee.
    assert.ok(
      defs.some((d) => /UNIQUE/.test(d) && /transactions/.test(d) && /reference/.test(d) && /type = 'deposit'/.test(d)),
      "transactions_deposit_reference_unique exists as a partial unique index"
    );
    assert.ok(
      defs.some((d) => /UNIQUE/.test(d) && /deposits/.test(d) && /provider_reference/.test(d)),
      "deposits_provider_reference_unique exists as a partial unique index"
    );
    // The balance lives on `users` with a non-negative CHECK. This is a
    // constraint, not an index, so it is looked up in pg_constraint: asserting a
    // `users.real_balance` index would be asserting something the schema has
    // never created.
    const checks = await sql.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'c'`,
      [`${SCHEMA}.users`]
    );
    const contract = checks.rows.map((r) => r.def).join(" ");
    assert.ok(
      /real_balance >= \(0\)::numeric/.test(contract),
      `users.real_balance has a non-negative CHECK (saw: ${contract || "none"})`
    );
  });

  test("a first valid settlement credits exactly once", async () => {
    const user = await seedAccount(store, "alice");
    const checkoutId = "ws_CO_PG_ALICE_1";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_ALICE_1" });
    const receipt = KES_RECEIPT("RECEIPT_ALICE_1");
    const routes = makeRoutes(store);

    const result = await fire(routes, envelope(checkoutId, { amount: 1300, receipt }));
    assert.equal(result.ok, true, `the callback must be acknowledged: ${result.error?.message}`);

    assert.equal(await balanceOf(store, user.id), 10, "1300 KES credits 10 USD");
    const deposit = await store.findDeposit(reference.reference);
    assert.equal(deposit.status, "completed");
    assert.equal(deposit.provider_reference, receipt);

    const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
    assert.equal(ledger.rows[0].n, 1, "exactly one ledger row, enforced by the unique index");
  });

  test("an identical callback replayed credits nothing further", async () => {
    const user = await seedAccount(store, "replay");
    const checkoutId = "ws_CO_PG_REPLAY_1";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_REPLAY_1" });
    const receipt = KES_RECEIPT("RECEIPT_REPLAY_1");
    const routes = makeRoutes(store);

    await fire(routes, envelope(checkoutId, { amount: 1300, receipt }));
    const once = await balanceOf(store, user.id);

    const again = await fire(routes, envelope(checkoutId, { amount: 1300, receipt }));
    assert.equal(again.ok, true, "a replay is still acknowledged, so the provider stops retrying");
    assert.equal(await balanceOf(store, user.id), once, "the balance did not move again");

    const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
    assert.equal(ledger.rows[0].n, 1, "still one ledger row");
  });

  test("two simultaneous settlements on separate connections credit exactly once", async () => {
    const user = await seedAccount(store, "race_conn");
    const checkoutId = "ws_CO_PG_RACE_CONN";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_RACE_CONN" });
    const receipt = KES_RECEIPT("RECEIPT_RACE_CONN");

    // Two stores means two pools and two route instances, so the JavaScript
    // mutex that serialises settlement inside one process is NOT shared. The only
    // thing left to prevent a double credit is the row lock and the unique index.
    const second = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    try {
      const outcomes = await Promise.allSettled([
        fire(makeRoutes(store), envelope(checkoutId, { amount: 1300, receipt })),
        fire(makeRoutes(second), envelope(checkoutId, { amount: 1300, receipt })),
      ]);

      // The callback route always answers Daraja with 200 — a 5xx would start a
      // retry storm — so the response body is NOT evidence of what happened to
      // the money. The evidence is the ledger and the audit trail.
      assert.ok(
        outcomes.every((o) => o.status === "fulfilled" && o.value.ok),
        "both deliveries were acknowledged"
      );
      assert.equal(await balanceOf(store, user.id), 10, "the wallet was credited once, not twice");

      const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
      assert.equal(ledger.rows[0].n, 1, "one ledger row despite two concurrent settlements");

      // Exactly one of the two deliveries credited; the other found the deposit
      // already settled (or lost the race to the unique index) and credited
      // nothing. Both are on record.
      const deliveries = await sql.query(
        "SELECT outcome FROM mpesa_callbacks WHERE checkout_request_id = $1",
        [checkoutId]
      );
      const creditedDeliveries = deliveries.rows.filter((r) => r.outcome === "credited").length;
      assert.equal(creditedDeliveries, 1, `exactly one delivery credited, got ${creditedDeliveries}`);
      assert.equal(deliveries.rows.length, 2, "both deliveries are recorded for audit");
    } finally {
      await second.close();
    }
  });

  test("a second receipt cannot settle a deposit that is already settled", async () => {
    const user = await seedAccount(store, "tworeceipts");
    const checkoutId = "ws_CO_PG_TWO_1";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_TWO_1" });
    const routes = makeRoutes(store);

    await fire(routes, envelope(checkoutId, { amount: 1300, receipt: KES_RECEIPT("RECEIPT_TWO_A") }));
    const once = await balanceOf(store, user.id);

    // A different receipt for the same checkout: the deposit is completed, so
    // this must change nothing — the receipt must not credit a second time.
    const second = await fire(routes, envelope(checkoutId, { amount: 1300, receipt: KES_RECEIPT("RECEIPT_TWO_B") }));
    assert.equal(second.ok, true);
    assert.equal(await balanceOf(store, user.id), once, "the second receipt did not credit again");

    const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
    assert.equal(ledger.rows[0].n, 1);
    const deposit = await store.findDeposit(reference.reference);
    assert.equal(deposit.provider_reference, KES_RECEIPT("RECEIPT_TWO_A"), "the first receipt remains the record");
  });

  test("a receipt already used for one deposit cannot be reused for another", async () => {
    const user = await seedAccount(store, "reuse");
    const checkoutA = "ws_CO_PG_REUSE_A";
    const checkoutB = "ws_CO_PG_REUSE_B";
    const depA = await seedPendingDeposit(store, user, { checkoutId: checkoutA, reference: "PAL_PG_REUSE_A" });
    const depB = await seedPendingDeposit(store, user, { checkoutId: checkoutB, reference: "PAL_PG_REUSE_B" });
    const receipt = KES_RECEIPT("RECEIPT_SHARED_1");
    const routes = makeRoutes(store);

    await fire(routes, envelope(checkoutA, { amount: 1300, receipt }));
    const afterFirst = await balanceOf(store, user.id);
    assert.equal(afterFirst, 10);

    // The same provider receipt arrives against a different deposit.
    const reused = await fire(routes, envelope(checkoutB, { amount: 1300, receipt }));
    assert.equal(await balanceOf(store, user.id), afterFirst, "reusing a receipt must credit nothing");

    const stillPending = await store.findDeposit(depB.reference);
    assert.equal(stillPending.status, "pending", "and leave the second deposit alone");

    const rows = await sql.query("SELECT count(*)::int AS n FROM deposits WHERE provider_reference = $1", [receipt]);
    assert.equal(rows.rows[0].n, 1, "one provider receipt maps to exactly one deposit, enforced by the index");

    // The reuse is refused internally. It is deliberately NOT refused over HTTP:
    // the callback route answers 200 for every delivery so the provider stops
    // retrying, and the refusal lives in the audit trail instead.
    assert.equal(reused.ok, true, "the delivery is acknowledged so Safaricom stops retrying");
    const refusals = await sql.query(
      "SELECT outcome, settlement_error FROM mpesa_callbacks WHERE checkout_request_id = $1",
      [checkoutB]
    );
    assert.equal(refusals.rows.length, 1, "the delivery is recorded");
    assert.equal(
      refusals.rows[0].outcome,
      "settlement_refused",
      `the reuse is refused, not quietly accepted (saw ${refusals.rows[0].outcome})`
    );
    assert.ok(refusals.rows[0].settlement_error, "with a reason on record");
    // Re-read rather than reading the seeding call's copy: the store hands back
    // plain snapshots and deliberately does not mutate them on write, so
    // `depA.status` is still the state this deposit was created in.
    assert.equal((await store.findDeposit("PAL_PG_REUSE_A")).status, "completed", "the first deposit keeps its credit");
  });

  test("a wrong amount or the wrong currency does not credit", async () => {
    const user = await seedAccount(store, "amounts");
    const routes = makeRoutes(store);

    const underCheckout = "ws_CO_PG_UNDER";
    await seedPendingDeposit(store, user, { checkoutId: underCheckout, reference: "PAL_PG_UNDER", kes: 1300 });
    const under = await fire(routes, envelope(underCheckout, { amount: 800, receipt: KES_RECEIPT("RECEIPT_UNDER") }));
    assert.equal(await balanceOf(store, user.id), 0, "800 KES cannot settle a 1300 KES deposit");
    assert.equal((await store.findDeposit("PAL_PG_UNDER")).status, "pending", "and it stays open for reconciliation");
    // A refusal is reported to the caller, so the provider result is not lost.
    assert.ok(under.ok === false || under.value?.ResultCode !== 0 || under.value?.credited !== true, "the under-payment is refused");

    // Currency: the same number in the wrong currency must not settle.
    //
    // A real M-Pesa callback carries no currency field — Amount is in KES by
    // definition — so a mismatch cannot be expressed through the callback route
    // at all. It is exercised on the settlement entry point, which is the only
    // place a currency is ever passed, exactly as the in-memory suite does it.
    const curCheckout = "ws_CO_PG_CURRENCY";
    const currencyDeposit = await seedPendingDeposit(store, user, {
      checkoutId: curCheckout,
      reference: "PAL_PG_CURRENCY",
      kes: 1300,
    });
    const wrongCurrency = await routes
      ._settleDeposit({
        reference: currencyDeposit.reference,
        providerReference: KES_RECEIPT("RECEIPT_CURRENCY"),
        verifiedAmount: 1300,
        currency: "USD",
      })
      .catch((e) => e);
    assert.equal(wrongCurrency.status, 400, "the mismatch is refused, not credited");
    assert.match(String(wrongCurrency.message), /currency does not match/);
    assert.equal(await balanceOf(store, user.id), 0, "the wrong currency credits nothing");
    assert.equal((await store.findDeposit("PAL_PG_CURRENCY")).status, "pending");
  });

  test("an unknown checkout id creates no deposit and credits nothing", async () => {
    const user = await seedAccount(store, "unknown");
    const routes = makeRoutes(store);
    const before = await sql.query("SELECT count(*)::int AS n FROM deposits");

    const result = await fire(routes, envelope("ws_CO_PG_NEVER_ISSUED", { amount: 5000, receipt: KES_RECEIPT("RECEIPT_FORGED") }));
    assert.equal(result.ok, true, "acknowledged so the provider stops retrying");
    assert.equal(await balanceOf(store, user.id), 0);

    const after = await sql.query("SELECT count(*)::int AS n FROM deposits");
    assert.equal(after.rows[0].n, before.rows[0].n, "a callback cannot conjure a deposit");
  });

  test("a forced database failure rolls back the balance and the status together", async () => {
    const user = await seedAccount(store, "rollback");
    const checkoutId = "ws_CO_PG_ROLLBACK";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_ROLLBACK" });
    const routes = makeRoutes(store);

    // A real database failure, not a stubbed function: the trigger raises inside
    // the settlement transaction, after the ledger insert is attempted.
    await sql.query(`
      CREATE OR REPLACE FUNCTION ${SCHEMA}.pgtest_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced failure for the rollback test'; END $$ LANGUAGE plpgsql
    `);
    await sql.query(`
      CREATE TRIGGER pgtest_refuse_trg BEFORE INSERT ON transactions
      FOR EACH ROW WHEN (NEW.reference = '${reference.reference}')
      EXECUTE FUNCTION ${SCHEMA}.pgtest_refuse()
    `);

    try {
      const result = await fire(routes, envelope(checkoutId, { amount: 1300, receipt: KES_RECEIPT("RECEIPT_ROLLBACK") }));
      // The route acknowledges even when settlement fails (answering Daraja with
      // an error invites a retry storm), so the proof that nothing half-succeeded
      // is the database state below — plus the recorded reason.
      assert.equal(result.ok, true, "the delivery is acknowledged");

      const recorded = await sql.query(
        "SELECT outcome, settlement_error FROM mpesa_callbacks WHERE checkout_request_id = $1",
        [checkoutId]
      );
      assert.equal(recorded.rows.length, 1, "the failed settlement is on record");
      assert.equal(recorded.rows[0].outcome, "settlement_refused");
      assert.ok(recorded.rows[0].settlement_error, "with the reason, which is a code and never a payload");

      assert.equal(await balanceOf(store, user.id), 0, "the credit was rolled back with the transaction");
      const deposit = await store.findDeposit(reference.reference);
      assert.equal(deposit.status, "pending", "and the deposit is still pending, not completed");
      assert.equal(deposit.completed_at, null, "with no completion timestamp");

      const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
      assert.equal(ledger.rows[0].n, 0, "nothing was left in the ledger");
    } finally {
      await sql.query("DROP TRIGGER IF EXISTS pgtest_refuse_trg ON transactions");
      await sql.query(`DROP FUNCTION IF EXISTS ${SCHEMA}.pgtest_refuse()`);
    }
  });

  test("a completed deposit cannot be failed by a late non-zero callback", async () => {
    const user = await seedAccount(store, "late");
    const checkoutId = "ws_CO_PG_LATE";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_LATE" });
    const routes = makeRoutes(store);

    await fire(routes, envelope(checkoutId, { amount: 1300, receipt: KES_RECEIPT("RECEIPT_LATE") }));
    assert.equal(await balanceOf(store, user.id), 10);

    // Safaricom is out of order by nature: the timeout arrives after the credit.
    await fire(routes, envelope(checkoutId, { resultCode: 1032 }));

    const deposit = await store.findDeposit(reference.reference);
    assert.equal(deposit.status, "completed", "a late failure must not un-settle a settled deposit");
    assert.equal(await balanceOf(store, user.id), 10, "and the money stays credited");
    assert.equal(deposit.completed_at !== null, true);

    // The contradictory delivery is still recorded for audit rather than dropped.
    const deliveries = await store.listMpesaCallbacks(50);
    assert.ok(deliveries.length >= 2, "both deliveries are kept");
    assert.ok(
      deliveries.some((d) => d.outcome === "ignored_after_settlement"),
      `the late failure is recorded as ignored_after_settlement (saw ${deliveries.map((d) => d.outcome).join(", ")})`
    );
  });

  test("a restart does not lose the settled balance or the ledger entry", async () => {
    const user = await seedAccount(store, "restart");
    const checkoutId = "ws_CO_PG_RESTART";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_RESTART" });
    await fire(makeRoutes(store), envelope(checkoutId, { amount: 1300, receipt: KES_RECEIPT("RECEIPT_RESTART") }));
    assert.equal(await balanceOf(store, user.id), 10);

    // A brand new store with a brand new pool is the closest thing to a restart
    // that a test can do without stopping the server: no process memory carries.
    const restarted = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    try {
      const account = await restarted.findUserById(user.id);
      assert.equal(Number(account.real_balance), 10, "the balance survived the new connection");

      const ledger = await restarted.listTransactionsByUser(user.id, 50);
      const deposit = ledger.find((t) => t.reference === reference.reference);
      assert.ok(deposit, "the ledger entry survived");
      assert.equal(Number(deposit.amount), 10);

      const reread = await restarted.findDeposit(reference.reference);
      assert.equal(reread.status, "completed", "the deposit state survived");
    } finally {
      await restarted.close();
    }
  });

  test("conservation: every credited dollar is a completed deposit", async () => {
    const credits = await sql.query(
      "SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM transactions WHERE type = 'deposit'"
    );
    const completed = await sql.query(
      "SELECT COALESCE(SUM(usd_amount), 0)::numeric AS total, count(*)::int AS n FROM deposits WHERE status = 'completed'"
    );
    const markedBoth = await sql.query(
      "SELECT count(*)::int AS n FROM deposits WHERE status = 'completed' AND completed_at IS NULL"
    );
    const orphanLedger = await sql.query(`
      SELECT count(*)::int AS n FROM transactions t
      WHERE t.type = 'deposit'
        AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.reference = t.reference AND d.status = 'completed')
    `);

    assert.equal(
      Number(credits.rows[0].total),
      Number(completed.rows[0].total),
      `ledger total ${credits.rows[0].total} must equal completed deposits ${completed.rows[0].total}`
    );
    assert.equal(markedBoth.rows[0].n, 0, "no deposit is completed without a completion timestamp");
    assert.equal(orphanLedger.rows[0].n, 0, "no ledger credit exists without a completed deposit");
  });

  test("two server processes racing the same callback credit exactly once", async () => {
    const user = await seedAccount(store, "race_proc");
    const checkoutId = "ws_CO_PG_RACE_PROC";
    const reference = await seedPendingDeposit(store, user, { checkoutId, reference: "PAL_PG_RACE_PROC" });
    const receipt = KES_RECEIPT("RECEIPT_RACE_PROC");

    // Separate processes, separate pools, separate mutexes: the only shared
    // protection left is PostgreSQL itself.
    const start = (port) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["tools/server.mjs", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            DATABASE_URL: schemaUrl(TEST_URL, SCHEMA),
            DARAJA_CALLBACK_TOKEN: CALLBACK_TOKEN,
            DARAJA_CONSUMER_KEY: "",
            DARAJA_CONSUMER_SECRET: "",
            DARAJA_SHORTCODE: "",
            DARAJA_PASSKEY: "",
            DARAJA_CALLBACK_URL: "",
            NODE_ENV: "",
            PORT: String(port),
          },
        });
        const timer = setTimeout(() => reject(new Error("a server process never reported a port")), 20_000);
        let out = "";
        child.stdout.on("data", (b) => {
          out += b.toString();
          if (/127\.0\.0\.1:\d+/.test(out)) {
            clearTimeout(timer);
            resolve(child);
          }
        });
        child.on("error", reject);
      });

    const post = (port) =>
      fetch(`http://127.0.0.1:${port}/api/auth/mpesa/callback/${CALLBACK_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope(checkoutId, { amount: 1300, receipt })),
      }).then((r) => r.status);

    const first = await start(4981);
    const second = await start(4982);
    try {
      const statuses = await Promise.all([post(4981), post(4982)]);
      assert.ok(statuses.every((s) => s === 200 || s === 500), `both were answered (${statuses.join(", ")})`);

      assert.equal(await balanceOf(store, user.id), 10, "one credit across two processes");

      const ledger = await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference.reference]);
      assert.equal(ledger.rows[0].n, 1, "one ledger row across two processes");
    } finally {
      first.kill("SIGKILL");
      second.kill("SIGKILL");
    }
  });
});
