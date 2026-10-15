/**
 * Contention stress tests: many connections, many workers, one ledger.
 *
 * WHAT THIS FILE IS FOR. `pg-settlement` and `pg-reconcile` prove the
 * guarantees with a handful of concurrent actors — two pools, two processes.
 * That is enough to catch a wrong idea, and not enough to catch a wrong idea
 * that only shows up under load: a lost row lock, a claim that two workers both
 * think they own, a partial credit left behind by a transaction that failed
 * halfway, a balance that leaks from one account into another.
 *
 * So this file does the same things at scale — 100 simultaneous deliveries of
 * one callback, several workers scanning the same due list, settlements for many
 * accounts at once, an injected database failure in the middle of a batch — and
 * after every scenario it re-checks the ledger-wide invariants rather than only
 * the balance it just moved.
 *
 * HONESTY RULES, same as the other PostgreSQL files:
 *
 *   * No in-memory fallback, ever. This file is only meaningful against a real
 *     server, so it refuses to run without one instead of passing vacuously.
 *   * It refuses to run against the database the application is configured to
 *     use, and it requires the target database to look disposable.
 *   * Everything happens in one randomly named schema which is dropped at the
 *     end, so nothing outside this file's own objects is ever touched.
 *   * Provider responses are fixtures. No payment is initiated anywhere.
 *
 * HOW TO GET A SERVER (no install, no administrator rights):
 *
 *   node tools/pg-local.mjs fetch           # once, ~23 MB of official binaries
 *   node tools/pg-local.mjs url             # prints PG_TEST_DATABASE_URL
 *   PG_TEST_DATABASE_URL='…' npm run test:postgres:stress
 *
 * CONFIGURATION (all optional):
 *
 *   PG_STRESS_SEED           prng seed, printed on failure   (default 20261015)
 *   PG_STRESS_DUPLICATES     duplicate-delivery counts       (default 2,10,50,100)
 *   PG_STRESS_CONCURRENCY    pools, i.e. parallel settlements (default 12)
 *   PG_STRESS_WORKERS        reconciliation workers           (default 4)
 *   PG_STRESS_DEPOSITS       deposits per batch scenario      (default 24)
 *   PG_STRESS_ACCOUNTS       accounts in the multi-account run (default 16)
 *
 * Start at the defaults, then raise one number at a time. A failure prints the
 * seed and the aggregate counts, so it can be reproduced exactly.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPostgresStore } from "../../../tools/store.mjs";
import { ApiError, createPaymentRoutes } from "../../../tools/payments.mjs";
import { reconcileConfig } from "../../../tools/reconcile.mjs";

/* --------------------------- prerequisites --------------------------- */

const TEST_URL = process.env.PG_TEST_DATABASE_URL || "";
const APP_URL = process.env.DATABASE_URL || "";

/** What this suite is pointed at, with any credentials removed. */
function safeTarget(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || 5432}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

if (!TEST_URL) {
  console.error(
    [
      "",
      "pg-stress needs a disposable PostgreSQL server and will not substitute one.",
      "",
      "  node tools/pg-local.mjs fetch && node tools/pg-local.mjs url",
      "  PG_TEST_DATABASE_URL='postgresql://…' npm run test:postgres:stress",
      "",
      "It is kept in its own variable on purpose: this suite settles deposits,",
      "installs triggers and drops a schema, so it must never be aimed at a",
      "database anyone cares about.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

// Two concrete ways this could do real damage, both refused here rather than
// trusted to whoever typed the command.
if (APP_URL && safeTarget(APP_URL) === safeTarget(TEST_URL)) {
  console.error("PG_TEST_DATABASE_URL points at the same database as DATABASE_URL, which is the");
  console.error("application's own ledger. Refusing to run destructive concurrency tests against it.");
  process.exit(2);
}
{
  const name = new URL(TEST_URL).pathname.replace(/^\//, "");
  if (!/test|ci|tmp|stress|sandbox|scratch/i.test(name) && process.env.PG_STRESS_ALLOW_ANY_DB !== "1") {
    console.error(`PG_TEST_DATABASE_URL names the database "${name}", which does not look disposable.`);
    console.error("Use a dedicated test database (the name should contain 'test'), or set");
    console.error("PG_STRESS_ALLOW_ANY_DB=1 if you are certain this one may be written to and dropped.");
    process.exit(2);
  }
}
if (process.env.NODE_ENV === "production") {
  console.error("NODE_ENV=production: this suite is not a production activity. Refusing to run.");
  process.exit(2);
}

/* ------------------------------ the knobs ------------------------------ */

const int = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), min), max) : fallback;
};

const SEED = int(process.env.PG_STRESS_SEED, 20261015, 1, 2 ** 31 - 1);
/** The counts from the brief: a retry storm, a busy batch, a very busy batch. */
const DUPLICATES = String(process.env.PG_STRESS_DUPLICATES || "2,10,50,100")
  .split(",")
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
  .map((n) => int(n, 2, 1, 500));
/** Each pool holds its own route instance, so this is the real parallelism: the
 *  settlement mutex inside `settleDeposit` is per route instance. */
const POOLS = int(process.env.PG_STRESS_CONCURRENCY, 12, 2, 40);
const WORKERS = int(process.env.PG_STRESS_WORKERS, 4, 2, 10);
const BATCH = int(process.env.PG_STRESS_DEPOSITS, 24, 2, 200);
const ACCOUNTS = int(process.env.PG_STRESS_ACCOUNTS, 16, 2, 200);

/** 130 KES to the dollar, and whole shillings, exactly as the app prices it. */
const KES_PER_USD = 130;
const KES = 1300;
const USD = 10;

const schemaUrl = (url, schema) => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
};

/* ------------------------------- fixtures ------------------------------- */

/** Deterministic, so a failure reproduces from the seed alone. */
function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });

/** The envelope Safaricom actually POSTs, `Item` as an array. */
function envelope(checkoutId, { resultCode = 0, amount = KES, receipt } = {}) {
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

/** A query answer for a completed payment, with metadata settlement can verify. */
const paid = (checkoutId, receipt, amount = KES) => ({
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

/* --------------------------------- suite --------------------------------- */

const SCHEMA = `paloption_stress_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const TOKEN = "stress_callback_token";
/** The brief's list of scenarios, collected for the closing table. */
const EVIDENCE = [];

describe("PostgreSQL contention and concurrency", () => {
  let store;
  let sql;
  const stores = [];
  const rand = mulberry32(SEED);

  before(async () => {
    process.env.DARAJA_CALLBACK_TOKEN = TOKEN;
    // `search_path` selects a schema, it does not create one. Without this the
    // store's boot step fails on its first unqualified CREATE TABLE (3F000).
    const { default: pg } = await import("pg");
    const bootstrap = new pg.Client({ connectionString: TEST_URL });
    await bootstrap.connect();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.end();

    store = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA), poolSize: 4 });
    sql = new pg.Client({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    await sql.connect();

    console.log(`\n  stress target : ${safeTarget(TEST_URL)}`);
    console.log(`  schema        : ${SCHEMA} (dropped afterwards)`);
    console.log(`  seed          : ${SEED}`);
    console.log(
      `  shape         : ${POOLS} pools, ${WORKERS} workers, ${BATCH} deposits/batch, ${ACCOUNTS} accounts, duplicates ${DUPLICATES.join("/")}\n`
    );
  });

  after(async () => {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    try {
      await store.close();
    } catch {
      /* a scenario may have closed it */
    }
    // Only this run's schema. The database is left otherwise as it was found.
    await sql.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.end();

    if (EVIDENCE.length) {
      console.log("\n  scenario evidence");
      for (const row of EVIDENCE) console.log(`    ${row}`);
      console.log("");
    }
  });

  /** An extra pool with its own route instance, and therefore its own mutex. */
  async function extraStore() {
    const s = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA), poolSize: 2 });
    stores.push(s);
    return s;
  }

  /**
   * Closes the pools the scenario opened.
   *
   * This is called at the end of every invariant check rather than only at the
   * end of the file, because a suite that holds a dozen pools open per scenario
   * eventually hits the server's connection limit — and the failure would then
   * be an artifact of the harness rather than anything about the ledger.
   */
  async function releaseExtra() {
    await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  }

  /** Scenarios that drive the callback path never reach the provider, but it is
   *  still given one so a partial `providers` object is not what is under test. */
  const NO_PROVIDER = async () => {
    throw Object.assign(new Error("this scenario makes no provider call"), { code: "TEST_NO_PROVIDER" });
  };

  const routesFor = (target, provider = NO_PROVIDER, reconcile = false) =>
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
      exchange: {
        get: async () => ({ base: "USD", quote: "KES", pair: "USD/KES", rate: KES_PER_USD, fetchedAt: Date.now(), cached: false }),
      },
      // A short eligibility threshold so a freshly seeded deposit is due at once.
      reconcile: reconcileConfig({ MPESA_RECONCILE_AFTER_MS: "1000", MPESA_RECONCILE_CONCURRENCY: "10" }),
      logger: quiet(),
    });

  /** A delivery. A rejection is a result to assert on, not a crash. */
  const fire = (routes, body) =>
    routes
      .mpesaCallback({ req: { headers: {} }, body, params: { token: TOKEN } })
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error }));

  async function seedAccount(tag, index = 0) {
    const name = `${tag}${index}`;
    const user = await store.createUser({
      id: `u_${name}`,
      email: `${name}@pgstress.example`,
      username: name,
      salt: "stress-salt",
      password_hash: "stress-hash",
      is_demo: false,
      demo_balance: 0,
      real_balance: 0,
      referral_code: `R${String(rand()).slice(2, 7)}`.slice(0, 8),
    });
    return user;
  }

  async function seedPending(user, { reference, checkoutId, ageMs = 60_000, kes = KES, usd = USD }) {
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
      created_at: new Date(Date.now() - ageMs).toISOString(),
      completed_at: null,
    });
  }

  const balanceOf = async (target, userId) => Number((await target.findUserById(userId)).real_balance);
  const ledgerRows = async (reference) =>
    Number((await sql.query("SELECT count(*)::int AS n FROM transactions WHERE reference = $1", [reference])).rows[0].n);
  const deliveriesFor = async (checkoutId) =>
    (
      await sql.query("SELECT outcome FROM mpesa_callbacks WHERE checkout_request_id = $1", [checkoutId])
    ).rows.map((r) => r.outcome);

  /**
   * The whole-schema invariants, re-checked after every scenario.
   *
   * These are the statements that would still have to hold if the application
   * were wrong, because they are comparisons between tables rather than
   * assertions about what a function returned.
   */
  async function checkInvariants(label) {
    const one = async (text, params) => (await sql.query(text, params)).rows[0];
    const scalar = async (text, params) => Number(Object.values(await one(text, params))[0]);

    const credited = await one("SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM transactions WHERE type = 'deposit'");
    const completed = await one(
      "SELECT COALESCE(SUM(usd_amount), 0)::numeric AS total, count(*)::int AS n FROM deposits WHERE status = 'completed'"
    );

    assert.equal(
      Number(credited.total),
      Number(completed.total),
      `[${label}] credited $${credited.total} must equal the ${completed.n} completed deposit(s) worth $${completed.total}`
    );
    assert.equal(
      await scalar("SELECT count(*)::int AS n FROM deposits WHERE status = 'completed' AND completed_at IS NULL"),
      0,
      `[${label}] no deposit is completed without a completion timestamp`
    );
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM transactions t
                    WHERE t.type = 'deposit'
                      AND NOT EXISTS (SELECT 1 FROM deposits d WHERE d.reference = t.reference AND d.status = 'completed')`),
      0,
      `[${label}] no ledger credit exists without its completed deposit`
    );
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM transactions t
                    JOIN deposits d ON d.reference = t.reference
                    WHERE t.type = 'deposit' AND t.user_id <> d.user_id`),
      0,
      `[${label}] every credit is booked against the account that owns the deposit`
    );
    // Belt and braces: the schema's unique index should make this impossible, and
    // an index that is quietly missing is exactly what this checks for.
    assert.equal(
      await scalar(`SELECT count(*)::int AS n FROM (
                      SELECT reference FROM transactions WHERE type = 'deposit'
                      GROUP BY reference HAVING count(*) > 1) dup`),
      0,
      `[${label}] no deposit reference has two ledger entries`
    );
    assert.equal(
      await scalar("SELECT count(*)::int AS n FROM users WHERE real_balance < 0 OR demo_balance < 0"),
      0,
      `[${label}] no account is overdrawn`
    );
    assert.equal(
      await scalar("SELECT count(*)::int AS n FROM deposits WHERE status = 'failed' AND completed_at IS NOT NULL"),
      0,
      `[${label}] no failed deposit carries a completion timestamp`
    );

    await releaseExtra();
  }

  /* ---------------------------- scenario 1 ---------------------------- */
  /* A retry storm: N simultaneous copies of one callback.                 */

  for (const n of DUPLICATES) {
    test(`1. ${n} simultaneous copies of the same callback credit exactly once`, async () => {
      const user = await seedAccount("dup", n);
      const checkoutId = `ws_STRESS_DUP_${n}`;
      const reference = `PAL_STRESS_DUP_${n}`;
      await seedPending(user, { reference, checkoutId });
      const receipt = `STRESSDUP${n}`;

      // Several pools, so the in-process mutex is not what protects the ledger:
      // the row lock and the unique index are. The deliveries are spread across
      // them, and each pool settles one at a time — POOLS is the real parallelism.
      const pools = [];
      for (let i = 0; i < Math.min(n, POOLS); i += 1) pools.push(await extraStore());

      const outcomes = await Promise.all(
        Array.from({ length: n }, (_, i) =>
          fire(routesFor(pools[i % pools.length]), envelope(checkoutId, { receipt }))
        )
      );

      assert.ok(
        outcomes.every((o) => o.ok && o.value.ResultCode === 0),
        `${n} deliveries must all be acknowledged`
      );
      assert.equal(await balanceOf(store, user.id), USD, `one payment credits $${USD}, not $${USD * n}`);
      assert.equal(await ledgerRows(reference), 1, "one ledger entry");

      const recorded = await deliveriesFor(checkoutId);
      assert.equal(recorded.length, n, "every delivery is kept for audit");
      assert.equal(
        recorded.filter((o) => o === "credited").length,
        1,
        `exactly one delivery credited (outcomes: ${JSON.stringify(recorded.reduce((a, o) => ({ ...a, [o]: (a[o] || 0) + 1 }), {}))})`
      );

      await checkInvariants(`scenario 1 n=${n}`);
      EVIDENCE.push(
        `1. duplicate delivery   ${String(n).padStart(3)} callbacks → 1 credit, ${recorded.filter((o) => o === "credited").length} credited delivery, ledger ${await ledgerRows(reference)} row`
      );
    });
  }

  /* ---------------------------- scenario 2 ---------------------------- */
  /* The callback and a reconciliation worker racing the same deposit.      */

  test("2. a callback and a reconciliation worker racing one deposit credit exactly once", async () => {
    const user = await seedAccount("cbvsrecon");
    const checkoutId = "ws_STRESS_CB_RECON";
    const reference = "PAL_STRESS_CB_RECON";
    await seedPending(user, { reference, checkoutId });
    const receipt = "STRESSCBRECON1";

    const workerStore = await extraStore();
    // Both paths are told the same payment happened, so whichever wins must be
    // the only one to credit.
    const worker = routesFor(workerStore, scriptFor({ [checkoutId]: paid(checkoutId, receipt) }), true);
    const deposit = await workerStore.findDeposit(reference);

    const [delivery, sweep] = await Promise.all([
      fire(routesFor(store), envelope(checkoutId, { receipt })),
      worker._reconcile.reconcileOne(deposit).catch((error) => ({ outcome: "error", error })),
    ]);

    assert.equal(delivery.ok, true, "the delivery is acknowledged either way");
    assert.equal(await balanceOf(store, user.id), USD, "the payment credited once");
    assert.equal(await ledgerRows(reference), 1, "one ledger entry");

    const after = await store.findDeposit(reference);
    assert.equal(after.status, "completed");
    assert.equal(after.provider_reference, receipt);

    // Three honest outcomes for the worker: it settled the payment, it claimed
    // the deposit and found it already settled, or the callback got there first
    // so there was nothing left to claim. An error is the one thing that means
    // something went wrong rather than merely losing a race.
    assert.ok(
      ["paid", "already_settled", "not_claimed"].includes(sweep.outcome),
      `the worker settled it, found it settled, or was beaten to the claim (got ${sweep.outcome})`
    );

    await checkInvariants("scenario 2");
    EVIDENCE.push(
      `2. callback vs worker   race resolved once → balance $${await balanceOf(store, user.id)}, ledger 1 row, worker saw "${sweep.outcome}"`
    );
  });

  /* ---------------------------- scenario 3 ---------------------------- */
  /* Many workers scanning the same due list.                              */

  test(`3. ${WORKERS} workers over ${BATCH} due deposits claim each one exactly once`, async () => {
    const user = await seedAccount("claims");
    const references = [];
    const providerAnswers = {};
    for (let i = 0; i < BATCH; i += 1) {
      const reference = `PAL_STRESS_CLAIM_${i}`;
      const checkoutId = `ws_STRESS_CLAIM_${i}`;
      references.push(reference);
      providerAnswers[checkoutId] = paid(checkoutId, `STRESSCLAIM${i}`);
      // Seeded one at a time; the insert order is irrelevant to the scenario.
      await seedPending(user, { reference, checkoutId });
    }

    const workers = [];
    for (let w = 0; w < WORKERS; w += 1) {
      const s = await extraStore();
      const provider = scriptFor(providerAnswers);
      workers.push({ store: s, provider, routes: routesFor(s, provider, true) });
    }

    // Every worker is told to run at the same moment, so they all see the same
    // due list and race for the same claims.
    const summaries = await Promise.all(workers.map((w) => w.routes._reconcile.runOnce({ reason: "stress", limit: 200 })));

    const credited = summaries.reduce((n, s) => n + (s.credited || 0), 0);
    const considered = summaries.reduce((n, s) => n + (s.considered || 0), 0);
    const skipped = summaries.reduce((n, s) => n + (s.skipped || 0), 0);

    assert.equal(credited, BATCH, `every deposit settled once (got ${credited})`);
    assert.equal(await balanceOf(store, user.id), USD * BATCH, "the balance is the sum of the payments");

    const attempts = await sql.query(
      `SELECT recon_attempts, count(*)::int AS n FROM deposits
        WHERE reference LIKE 'PAL_STRESS_CLAIM_%' GROUP BY recon_attempts ORDER BY recon_attempts`
    );
    assert.equal(attempts.rows.length, 1, `every deposit was attempted exactly once (saw ${JSON.stringify(attempts.rows)})`);
    assert.equal(Number(attempts.rows[0].recon_attempts), 1, "and the attempt count is 1, not 2 — no deposit was doubly claimed");
    assert.equal(Number(attempts.rows[0].n), BATCH);

    const ledger = await sql.query(
      "SELECT count(*)::int AS n FROM transactions WHERE reference LIKE 'PAL_STRESS_CLAIM_%'"
    );
    assert.equal(Number(ledger.rows[0].n), BATCH, "one ledger row per deposit");

    await checkInvariants("scenario 3");
    EVIDENCE.push(
      `3. worker claims        ${WORKERS} workers saw ${considered} deposit(s), ${skipped} lost the claim, ${credited} claims won → ${BATCH} credits`
    );
  });

  /* ---------------------------- scenario 4 ---------------------------- */
  /* One deposit, two different receipts, at the same time.                */

  test("4. two different receipts racing for one deposit credit exactly once", async () => {
    const user = await seedAccount("tworeceipts");
    const checkoutId = "ws_STRESS_TWO_RECEIPTS";
    const reference = "PAL_STRESS_TWO_RECEIPTS";
    await seedPending(user, { reference, checkoutId });

    const pools = [await extraStore(), await extraStore()];
    const receipts = ["STRESSTWOAAAA1", "STRESSTWOBBBB1"];
    const outcomes = await Promise.all(
      pools.map((p, i) => fire(routesFor(p), envelope(checkoutId, { receipt: receipts[i] })))
    );
    assert.ok(outcomes.every((o) => o.ok), "both deliveries are acknowledged");

    assert.equal(await balanceOf(store, user.id), USD, "one payment credits once");
    assert.equal(await ledgerRows(reference), 1, "one ledger entry");

    const after = await store.findDeposit(reference);
    assert.equal(after.status, "completed");
    assert.ok(receipts.includes(after.provider_reference), `the receipt on record is one of the two (${after.provider_reference})`);

    const recorded = await deliveriesFor(checkoutId);
    assert.equal(recorded.length, 2);
    assert.equal(recorded.filter((o) => o === "credited").length, 1, "only one delivery credited");

    await checkInvariants("scenario 4");
    EVIDENCE.push(
      `4. two receipts         both delivered, 1 credit, receipt on record ${after.provider_reference}, second delivery "${recorded.find((o) => o !== "credited")}"`
    );
  });

  /* ---------------------------- scenario 5 ---------------------------- */
  /* One receipt, many deposits — claimed concurrently by reconciliation.   */

  test("5. one receipt reused across many deposits credits at most one", async () => {
    const user = await seedAccount("reuse");
    const shared = `STRESSREUSE${SEED % 1000}`;
    const providerAnswers = {};
    for (let i = 0; i < BATCH; i += 1) {
      const checkoutId = `ws_STRESS_REUSE_${i}`;
      const reference = `PAL_STRESS_REUSE_${i}`;
      providerAnswers[checkoutId] = paid(checkoutId, shared);
      // Seeded one at a time; the insert order is irrelevant to the scenario.
      await seedPending(user, { reference, checkoutId });
    }

    const pools = [await extraStore(), await extraStore()];
    const runners = pools.map((p) => routesFor(p, scriptFor(providerAnswers), true));
    await Promise.all(runners.map((r) => r._reconcile.runOnce({ reason: "stress reuse", limit: 200 })));

    assert.equal(await balanceOf(store, user.id), USD, "a reused receipt pays once, however many deposits claim it");

    const rows = await sql.query(
      "SELECT count(*)::int AS n FROM deposits WHERE provider_reference = $1",
      [shared]
    );
    assert.equal(Number(rows.rows[0].n), 1, "the receipt is attached to exactly one deposit");

    const ledger = await sql.query(
      "SELECT count(*)::int AS n FROM transactions WHERE reference LIKE 'PAL_STRESS_REUSE_%'"
    );
    assert.equal(Number(ledger.rows[0].n), 1, "and produced exactly one ledger entry");

    // The rest must not be quietly discarded: they are left unsettled and flagged.
    const unresolved = await sql.query(
      "SELECT count(*)::int AS n FROM deposits WHERE reference LIKE 'PAL_STRESS_REUSE_%' AND status <> 'completed'"
    );
    assert.equal(Number(unresolved.rows[0].n), BATCH - 1, "the other deposits are left unsettled");

    const flagged = await sql.query(
      `SELECT count(*)::int AS n FROM deposits
        WHERE reference LIKE 'PAL_STRESS_REUSE_%' AND recon_outcome = 'needs_review'`
    );
    assert.equal(Number(flagged.rows[0].n), BATCH - 1, "and flagged for a human rather than retried forever");

    await checkInvariants("scenario 5");
    EVIDENCE.push(
      `5. receipt reuse        ${BATCH} deposits claimed one receipt → 1 credit, ${BATCH - 1} flagged needs_review`
    );
  });

  /* ---------------------------- scenario 6 ---------------------------- */
  /* A success and a failure for the same deposit, delivered together.      */

  test("6. a success and a failure callback racing leave one consistent outcome", async () => {
    const user = await seedAccount("sconflict");
    const checkoutId = "ws_STRESS_CONFLICT";
    const reference = "PAL_STRESS_CONFLICT";
    await seedPending(user, { reference, checkoutId });
    const receipt = "STRESSCONFLICT1";

    const pools = [await extraStore(), await extraStore()];
    await Promise.all([
      fire(routesFor(pools[0]), envelope(checkoutId, { receipt })),
      fire(routesFor(pools[1]), envelope(checkoutId, { resultCode: 1032 })),
    ]);

    const after = await store.findDeposit(reference);
    const balance = await balanceOf(store, user.id);
    const ledger = await ledgerRows(reference);

    // Which one wins is a genuine race; what must never happen is a state that
    // disagrees with the ledger.
    assert.ok(["completed", "failed"].includes(after.status), `the deposit is terminal, got ${after.status}`);
    if (after.status === "completed") {
      assert.equal(balance, USD, "a completed deposit is credited");
      assert.equal(ledger, 1, "with exactly one ledger entry");
      assert.equal(after.completed_at !== null, true);
    } else {
      assert.equal(balance, 0, "a failed deposit is never credited");
      assert.equal(ledger, 0, "and has no ledger entry");
      assert.ok(after.failure_reason, "with the provider's reason on record");
    }

    // Now the losing result arrives again, late. A completed deposit must not be
    // downgraded; a confirmed success against a failed deposit must not be
    // silently credited — it is recorded so a human can resolve the contradiction.
    const late = await fire(routesFor(store), envelope(checkoutId, { receipt }));
    assert.equal(late.ok, true, "the late delivery is acknowledged so the provider stops retrying");

    const settled = await store.findDeposit(reference);
    assert.equal(settled.status, after.status, "the late delivery did not move the deposit's state");
    assert.equal(await balanceOf(store, user.id), balance, "and did not move the balance");

    const recorded = await deliveriesFor(checkoutId);
    assert.equal(recorded.length, 3, "all three deliveries are kept for audit");
    if (after.status === "failed") {
      assert.ok(
        recorded.includes("settlement_refused"),
        `a success arriving after a failure is refused and recorded (saw ${JSON.stringify(recorded)})`
      );
    }
    assert.equal(await ledgerRows(reference), ledger, "the ledger is unchanged");

    await checkInvariants("scenario 6");
    EVIDENCE.push(
      `6. success vs failure   first result won (${after.status}) → balance $${balance}, ledger ${ledger} row(s), late delivery did not change either`
    );
  });

  /* ---------------------------- scenario 7 ---------------------------- */
  /* A timeout, then the real payment arrives late, then another sweep.     */

  test("7. a late success after a provider timeout credits once and is never credited again", async () => {
    const user = await seedAccount("late");
    const checkoutId = "ws_STRESS_LATE";
    const reference = "PAL_STRESS_LATE";
    await seedPending(user, { reference, checkoutId });

    // Attempt one: the provider times out. Inconclusive, so nothing is credited,
    // nothing is failed, and the deposit is scheduled for another attempt.
    const firstStore = await extraStore();
    const firstProvider = scriptFor({
      [checkoutId]: Object.assign(new Error("timed out"), { code: "DARAJA_QUERY_TIMEOUT" }),
    });
    const first = await routesFor(firstStore, firstProvider, true)._reconcile.runOnce({ reason: "stress late 1", limit: 50 });

    assert.equal(first.credited, 0, "a timeout credits nothing");
    assert.equal(await balanceOf(store, user.id), 0, "and leaves the balance alone");
    const afterTimeout = await store.findDeposit(reference);
    assert.equal(afterTimeout.status, "pending", "the deposit stays pending");
    assert.equal(afterTimeout.recon_attempts, 1);
    assert.ok(afterTimeout.next_reconcile_at, "with a backoff scheduled");

    // The callback arrives late — the documented recovery policy is that it still
    // settles, because it is a verified payment.
    const receipt = "STRESSLATE0001";
    const delivery = await fire(routesFor(store), envelope(checkoutId, { receipt }));
    assert.equal(delivery.ok, true);
    assert.equal(await balanceOf(store, user.id), USD, "the late payment is credited once");
    assert.equal(await ledgerRows(reference), 1, "one ledger entry");

    // A later sweep must not touch a completed deposit, and must not even ask the
    // provider about it.
    const secondStore = await extraStore();
    const secondProvider = scriptFor({ [checkoutId]: paid(checkoutId, receipt) });
    const second = await routesFor(secondStore, secondProvider, true)._reconcile.runOnce({ reason: "stress late 2", limit: 50 });

    assert.equal(second.considered, 0, "a completed deposit is not due again");
    assert.equal(secondProvider.calls.length, 0, "so the provider was not asked about it");
    assert.equal(await balanceOf(store, user.id), USD, "and the balance did not move twice");
    assert.equal(await ledgerRows(reference), 1, "still one ledger entry");

    await checkInvariants("scenario 7");
    EVIDENCE.push(
      `7. timeout then late    attempt 1 inconclusive → pending; late callback credited once; later sweep considered ${second.considered}, provider calls ${secondProvider.calls.length}`
    );
  });

  /* ---------------------------- scenario 8 ---------------------------- */
  /* Many accounts settling at once, to look for cross-account effects.     */

  test(`8. ${ACCOUNTS} accounts settling simultaneously stay isolated`, async () => {
    const accounts = [];
    for (let i = 0; i < ACCOUNTS; i += 1) {
      const user = await seedAccount("iso", i);
      const reference = `PAL_STRESS_ISO_${i}`;
      const checkoutId = `ws_STRESS_ISO_${i}`;
      // Deliberately different amounts, so a credit landing on the wrong account
      // is visible in the numbers rather than only in a row count.
      const usd = 1 + (i % 5);
      // Seeded one at a time; the insert order is irrelevant to the scenario.
      await seedPending(user, { reference, checkoutId, kes: usd * KES_PER_USD, usd });
      accounts.push({ user, reference, checkoutId, usd });
    }

    const pools = [];
    for (let i = 0; i < Math.min(ACCOUNTS, POOLS); i += 1) pools.push(await extraStore());

    const outcomes = await Promise.all(
      accounts.map((a, i) =>
        fire(routesFor(pools[i % pools.length]), envelope(a.checkoutId, { receipt: `STRESSISO${i}`, amount: a.usd * KES_PER_USD }))
      )
    );
    assert.ok(outcomes.every((o) => o.ok), "every delivery is acknowledged");

    let expectedTotal = 0;
    for (const a of accounts) {
      expectedTotal += a.usd;
      assert.equal(
        await balanceOf(store, a.user.id),
        a.usd,
        `${a.user.id} must hold exactly its own $${a.usd}`
      );
      assert.equal(await ledgerRows(a.reference), 1, `${a.user.id} has one ledger entry`);
    }

    // Scoped to this scenario's deposits: the schema-wide totals are checked by
    // checkInvariants, and earlier scenarios have credited deposits of their own.
    const total = (
      await sql.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric AS total FROM transactions
          WHERE type = 'deposit' AND reference LIKE 'PAL_STRESS_ISO\\_%'`
      )
    ).rows[0].total;
    assert.equal(Number(total), expectedTotal, `the ledger holds exactly the ${ACCOUNTS} payments`);

    const crossed = await sql.query(
      `SELECT count(*)::int AS n FROM deposits d
        WHERE d.reference LIKE 'PAL_STRESS_ISO_%'
          AND d.user_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM transactions t WHERE t.reference = d.reference AND t.user_id = d.user_id
          ) AND d.status = 'completed'`
    );
    assert.equal(Number(crossed.rows[0].n), 0, "no credit was booked without its deposit's owner");

    await checkInvariants("scenario 8");
    EVIDENCE.push(
      `8. account isolation    ${ACCOUNTS} accounts settled concurrently → total $${Number(total)}, every balance exactly its own, 0 crossings`
    );
  });

  /* ---------------------------- scenario 9 ---------------------------- */
  /* A real database failure in the middle of a concurrent batch.           */

  test("9. an injected database failure leaves no partial credit behind", async () => {
    const half = Math.max(2, Math.floor(BATCH / 2));
    const pairs = [];
    for (let i = 0; i < half; i += 1) {
      const okUser = await seedAccount("rbok", i);
      const okRef = `PAL_STRESS_OK_${i}`;
      const okCheckout = `ws_STRESS_OK_${i}`;
      await seedPending(okUser, { reference: okRef, checkoutId: okCheckout });

      const badUser = await seedAccount("rbbad", i);
      const badRef = `PAL_STRESS_RB_${i}`;
      const badCheckout = `ws_STRESS_RB_${i}`;
      await seedPending(badUser, { reference: badRef, checkoutId: badCheckout });

      pairs.push({ okUser, okRef, okCheckout, badUser, badRef, badCheckout });
    }

    // A real failure inside the settlement transaction: the trigger fires on the
    // ledger insert, after the deposit row is locked and before it is updated.
    await sql.query(`
      CREATE OR REPLACE FUNCTION ${SCHEMA}.stress_refuse() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'stress: injected ledger failure'; END $$ LANGUAGE plpgsql
    `);
    await sql.query(`
      CREATE TRIGGER stress_refuse_trg BEFORE INSERT ON transactions
      FOR EACH ROW WHEN (NEW.reference LIKE 'PAL_STRESS_RB\\_%')
      EXECUTE FUNCTION ${SCHEMA}.stress_refuse()
    `);

    try {
      const pools = [];
      for (let i = 0; i < Math.min(half * 2, POOLS); i += 1) pools.push(await extraStore());

      const jobs = pairs.flatMap((p, i) => [
        fire(routesFor(pools[(i * 2) % pools.length]), envelope(p.okCheckout, { receipt: `STRESSRBOK${i}` })),
        fire(routesFor(pools[(i * 2 + 1) % pools.length]), envelope(p.badCheckout, { receipt: `STRESSRBBAD${i}` })),
      ]);
      const outcomes = await Promise.all(jobs);

      // A failing settlement is acknowledged too — a 5xx would start a retry
      // storm — so the proof is the database, not the response.
      assert.ok(outcomes.every((o) => o.ok), "every delivery is acknowledged");

      for (const [i, p] of pairs.entries()) {
        assert.equal(await balanceOf(store, p.okUser.id), USD, `the healthy settlement ${i} still credited`);
        assert.equal(await ledgerRows(p.okRef), 1, `the healthy settlement ${i} has its ledger entry`);
        assert.equal((await store.findDeposit(p.okRef)).status, "completed");

        assert.equal(await balanceOf(store, p.badUser.id), 0, `the failed settlement ${i} credited nothing`);
        assert.equal(await ledgerRows(p.badRef), 0, `the failed settlement ${i} left no ledger entry`);
        const stuck = await store.findDeposit(p.badRef);
        assert.equal(stuck.status, "pending", `the failed settlement ${i} left the deposit pending, not completed`);
        assert.equal(stuck.completed_at, null, `the failed settlement ${i} left no completion timestamp`);
        assert.equal(stuck.provider_reference, null, `the failed settlement ${i} did not attach a receipt`);

        const recorded = await deliveriesFor(p.badCheckout);
        assert.equal(recorded.length, 1, `the failure of settlement ${i} is on record`);
        assert.equal(recorded[0], "settlement_refused", `and recorded as refused (saw ${recorded[0]})`);
      }

      await checkInvariants("scenario 9");
      EVIDENCE.push(
        `9. injected failure     ${half} settlements failed mid-transaction → 0 credits, 0 ledger rows, all pending; ${half} healthy settlements credited`
      );
    } finally {
      await sql.query("DROP TRIGGER IF EXISTS stress_refuse_trg ON transactions");
      await sql.query(`DROP FUNCTION IF EXISTS ${SCHEMA}.stress_refuse()`);
    }
  });

  /* ---------------------------- scenario 10 --------------------------- */
  /* Everything above, read back through a brand new pool.                  */

  test("10. a restart finds every balance and record intact", async () => {
    const before = await sql.query(
      "SELECT COALESCE(SUM(real_balance), 0)::numeric AS total, count(*)::int AS n FROM users"
    );
    const completedBefore = await sql.query(
      "SELECT count(*)::int AS n, COALESCE(SUM(usd_amount), 0)::numeric AS total FROM deposits WHERE status = 'completed'"
    );

    // A new process would have a new pool and no memory of any of this.
    const restarted = await createPostgresStore({ connectionString: schemaUrl(TEST_URL, SCHEMA), poolSize: 4 });
    const { default: pg } = await import("pg");
    // And a connection opened after the work, so the totals are read from the
    // server rather than from anything this process already had in hand.
    const fresh = new pg.Client({ connectionString: schemaUrl(TEST_URL, SCHEMA) });
    await fresh.connect();
    try {
      const after = await fresh.query(
        "SELECT COALESCE(SUM(real_balance), 0)::numeric AS total, count(*)::int AS n FROM users"
      );

      assert.equal(
        Number(after.rows[0].total),
        Number(before.rows[0].total),
        "the total balance is unchanged by the restart"
      );
      assert.equal(Number(after.rows[0].n), Number(before.rows[0].n));

      // Spot-check through the new pool: the deposit read back, and the ledger
      // read back, must agree with each other.
      const done = await sql.query(
        "SELECT reference, user_id, usd_amount FROM deposits WHERE status = 'completed' ORDER BY reference LIMIT 5"
      );
      for (const row of done.rows) {
        const deposit = await restarted.findDeposit(row.reference);
        assert.equal(deposit.status, "completed", `${row.reference} survived the restart as completed`);
        assert.equal(Number(deposit.usd_amount), Number(row.usd_amount));

        const account = await restarted.findUserById(row.user_id);
        const ledger = await restarted.listTransactionsByUser(row.user_id, 500);
        const mine = ledger.filter((t) => t.type === "deposit");
        assert.ok(mine.length >= 1, `${row.user_id} still has its ledger entries`);
        assert.ok(
          Number(account.real_balance) >= mine.reduce((n, t) => n + Number(t.amount), 0) - 1e-9,
          "the stored balance still covers the credits on record"
        );
      }

      const completedAfter = await sql.query(
        "SELECT count(*)::int AS n, COALESCE(SUM(usd_amount), 0)::numeric AS total FROM deposits WHERE status = 'completed'"
      );
      assert.equal(
        Number(completedAfter.rows[0].n),
        Number(completedBefore.rows[0].n),
        "the completed deposits are still completed"
      );
      assert.equal(Number(completedAfter.rows[0].total), Number(completedBefore.rows[0].total));

      await checkInvariants("scenario 10");
      EVIDENCE.push(
        `10. restart             fresh pool: total balance $${Number(after.rows[0].total)} across ${Number(after.rows[0].n)} accounts, ${Number(completedAfter.rows[0].n)} completed deposits — unchanged`
      );
    } finally {
      await fresh.end();
      await restarted.close();
    }
  });
});
