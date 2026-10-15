/**
 * Reconciliation for deposits whose M-Pesa callback never arrived.
 *
 * WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT.
 *
 * They run against the IN-MEMORY store, with the provider mocked. That is enough
 * to prove the decisions this module makes — what counts as a verified payment,
 * what is refused, what backs off, what stops — because those are made above the
 * store. It is NOT evidence about PostgreSQL: the atomic claim
 * (`claimDepositForReconciliation`) and the receipt-uniqueness guarantee come
 * from Postgres in a real deployment, and they are exercised in
 * tests/postgres/pg-reconcile.test.mjs, which refuses to run without a database.
 * Nothing here substitutes for that file.
 *
 * No live provider is contacted. Every query response below is a fixture.
 *
 * Run: npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../tools/store.mjs";
import { createPaymentRoutes } from "../tools/payments.mjs";
import {
  RECONCILE_OUTCOMES,
  backoffFor,
  classifyQueryResponse,
  createReconciler,
  reconcileConfig,
} from "../tools/reconcile.mjs";

/* ------------------------------- harness ------------------------------- */

const CALLBACK_TOKEN = "reconcile_test_token";

/** Collects what the worker said, so policy warnings can be asserted on. */
function capture() {
  const log = [];
  const warn = [];
  const error = [];
  return {
    log: (m) => log.push(String(m)),
    warn: (m) => warn.push(String(m)),
    error: (m) => error.push(String(m)),
    log_,
    warn_,
    error_,
  };
  function log_() {
    return log;
  }
  function warn_() {
    return warn;
  }
  function error_() {
    return error;
  }
}

/** The reconciliation thresholds these tests rely on: query after 1s. */
const FAST = { MPESA_RECONCILE_AFTER_MS: "1000", MPESA_RECONCILE_BACKOFF_MS: "1000", MPESA_RECONCILE_MAX_BACKOFF_MS: "8000" };

/**
 * A world with one funded-zero account, the real routes, and a scripted
 * provider. The store is the in-memory one — see the note at the top of the file.
 */
function makeWorld({ queryProvider, logger = capture(), reconcileOverrides = {} } = {}) {
  const store = createMemoryStore();
  const user = {
    id: "u_alice",
    email: "alice@example.com",
    username: "Alice",
    salt: "fixture-salt",
    password_hash: "fixture-hash",
    is_demo: false,
    demo_balance: 10_000,
    real_balance: 0,
    referral_code: "ALICE",
  };
  store._state.users.push(user);

  const routes = createPaymentRoutes({
    store,
    requireUser: async () => user,
    providers: {
      darajaStkPush: async () => ({ CheckoutRequestID: "ws_CO_FIXTURE", MerchantRequestID: "mr_FIXTURE" }),
      darajaStkQuery: queryProvider,
      cardCharge: async () => ({ id: "pi_fixture" }),
      tronDepositAddress: async () => ({ address: "TFixture", network: "TRC20" }),
    },
    exchange: {
      get: async () => ({
        base: "USD",
        quote: "KES",
        pair: "USD/KES",
        rate: 130,
        provider: "fixture",
        source: "fixture",
        sourceUrl: "http://fixture.test/latest/USD",
        asOf: "2026-10-14T00:00:00Z",
        fetchedAt: Date.now(),
        cached: false,
      }),
    },
    reconcile: reconcileConfig({ ...FAST, ...reconcileOverrides }),
    logger,
  });

  return { store, user, routes, reconciler: routes._reconcile, logger };
}

/** A pending M-Pesa deposit, old enough that its callback is considered lost. */
function seed(store, user, { reference, checkoutId, usd = 1, kes = 130, ageMs = 60_000 } = {}) {
  return store.insertDeposit({
    id: `dep_${reference}`,
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
    failure_reason: null,
    created_at: new Date(Date.now() - ageMs).toISOString(),
    completed_at: null,
  });
}

/**
 * Answers each call from the script, repeating the last entry once exhausted.
 * For one deposit the order of calls is the order of responses, so this is
 * deterministic — but for a batch it is NOT, which is what `scriptFor` is for.
 */
function scripted(responses) {
  const calls = [];
  const provider = async (request) => {
    calls.push(request);
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (typeof next === "function") return next(request);
    if (next instanceof Error) throw next;
    return next;
  };
  provider.calls = calls;
  return provider;
}

/**
 * Answers by CheckoutRequestID rather than by call order.
 *
 * This matters: the worker queries a batch with several calls in flight, so
 * "first call gets first response" would hand a deposit an answer belonging to a
 * different one. Keying on the id the worker actually asked about is both
 * deterministic and what a real provider does.
 */
function scriptFor(map) {
  const calls = [];
  const provider = async (request) => {
    calls.push(request);
    const next = map[request.checkoutRequestId];
    if (next === undefined) {
      throw Object.assign(new Error(`no scripted answer for ${request.checkoutRequestId}`), { code: "TEST_NO_SCRIPT" });
    }
    if (typeof next === "function") return next(request);
    if (next instanceof Error) throw next;
    return next;
  };
  provider.calls = calls;
  return provider;
}

/** The query response for a completed payment, exactly as Safaricom documents it. */
const paid = (checkoutId, { amount = 130, receipt = "RECONCILE001", metadata = true } = {}) => {
  const base = {
    ResponseCode: "0",
    ResponseDescription: "The service request has been accepted successsfully",
    MerchantRequestID: `mr_${checkoutId}`,
    CheckoutRequestID: checkoutId,
    ResultCode: "0",
    ResultDesc: "The service request is processed successfully.",
  };
  if (!metadata) return base;
  return {
    ...base,
    CallbackMetadata: {
      Item: [
        { Name: "Amount", Value: amount },
        { Name: "MpesaReceiptNumber", Value: receipt },
        { Name: "TransactionDate", Value: 20261014153045 },
        { Name: "PhoneNumber", Value: 254712345678 },
      ],
    },
  };
};

/** A completed-but-unsuccessful transaction, e.g. the customer cancelled. */
const notPaid = (checkoutId, resultCode = 1032, desc = "Request cancelled by user") => ({
  ResponseCode: "0",
  CheckoutRequestID: checkoutId,
  ResultCode: String(resultCode),
  ResultDesc: desc,
});

/** The envelope Safaricom POSTs, used for the race test. */
const callbackEnvelope = (checkoutId, { amount = 130, receipt = "CALLBACK0001" } = {}) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: `mr_${checkoutId}`,
      CheckoutRequestID: checkoutId,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: amount },
          { Name: "MpesaReceiptNumber", Value: receipt },
          { Name: "TransactionDate", Value: 20261014153045 },
          { Name: "PhoneNumber", Value: 254712345678 },
        ],
      },
    },
  },
});

const balance = async (store, user) => Number((await store.findUserById(user.id)).real_balance);
const depositCredits = (store) => store._state.transactions.filter((t) => t.type === "deposit");
const stateOf = (store, reference) => store._state.deposits.find((d) => d.reference === reference);

/* -------------------------------- suite -------------------------------- */

describe("deposit reconciliation", () => {
  const previousToken = process.env.DARAJA_CALLBACK_TOKEN;

  before(() => {
    // The callback route refuses without a configured token, and the race test
    // below calls it directly.
    process.env.DARAJA_CALLBACK_TOKEN = CALLBACK_TOKEN;
  });

  after(() => {
    if (previousToken === undefined) delete process.env.DARAJA_CALLBACK_TOKEN;
    else process.env.DARAJA_CALLBACK_TOKEN = previousToken;
  });

  test("1. a pending deposit whose callback never arrived is queried, once", async () => {
    const provider = scripted([notPaid("ws_CO_LOST1")]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_LOST1", checkoutId: "ws_CO_LOST1" });

    const summary = await reconciler.runOnce({ reason: "test" });

    assert.equal(provider.calls.length, 1, "the provider was asked exactly once");
    assert.equal(provider.calls[0].checkoutRequestId, "ws_CO_LOST1", "it asked about OUR CheckoutRequestID");
    assert.equal(summary.considered, 1, "one deposit was considered");
    assert.equal(stateOf(store, "PAL_LOST1").recon_attempts, 1, "the attempt is recorded on the deposit");
    assert.ok(stateOf(store, "PAL_LOST1").last_reconciled_at, "and so is when it happened");
  });

  test("2. a verified success from the query settles exactly once", async () => {
    const provider = scripted([paid("ws_CO_PAID1", { receipt: "VERIFIED0001" })]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_PAID1", checkoutId: "ws_CO_PAID1" });

    await reconciler.runOnce({ reason: "test" });

    const deposit = stateOf(store, "PAL_PAID1");
    assert.equal(deposit.status, "completed", "the deposit is completed");
    assert.equal(deposit.provider_reference, "VERIFIED0001", "settled with the provider's receipt");
    assert.equal(deposit.recon_outcome, RECONCILE_OUTCOMES.PAID, "and records how it was resolved");
    assert.equal(await balance(store, user), 1, "the wallet was credited once");
    assert.equal(depositCredits(store).length, 1, "one ledger entry");
  });

  test("3. a provider-confirmed failure never credits", async () => {
    const provider = scripted([notPaid("ws_CO_FAIL1", 1032, "Request cancelled by user")]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_FAIL1", checkoutId: "ws_CO_FAIL1" });

    await reconciler.runOnce({ reason: "test" });

    const deposit = stateOf(store, "PAL_FAIL1");
    assert.equal(deposit.status, "failed", "the deposit is failed");
    assert.equal(deposit.mpesa_result_code, 1032, "with the provider's result code recorded");
    assert.equal(deposit.failure_reason, "Request cancelled by user", "and its description");
    assert.equal(await balance(store, user), 0, "nothing was credited");
    assert.equal(depositCredits(store).length, 0, "no ledger entry");
  });

  test("4. a query timeout never credits and leaves the deposit pending", async () => {
    const timeout = Object.assign(new Error("Daraja did not answer within 15000ms"), { code: "RECONCILE_TIMEOUT" });
    const provider = scripted([timeout]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_SLOW1", checkoutId: "ws_CO_SLOW1" });

    const summary = await reconciler.runOnce({ reason: "test" });

    const deposit = stateOf(store, "PAL_SLOW1");
    assert.equal(deposit.status, "pending", "a timeout is not proof of failure");
    assert.equal(deposit.recon_outcome, null, "and it is not a terminal outcome");
    assert.ok(deposit.next_reconcile_at, "it will be retried");
    assert.equal(await balance(store, user), 0, "nothing was credited");
    assert.equal(summary.inconclusive, 1, "counted as inconclusive");
  });

  test("5. a provider error (still processing) never credits and retries", async () => {
    const provider = scripted([{ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_BUSY1", checkoutId: "ws_CO_BUSY1" });

    await reconciler.runOnce({ reason: "test" });

    const deposit = stateOf(store, "PAL_BUSY1");
    assert.equal(deposit.status, "pending", "still not established, so still pending");
    assert.equal(deposit.recon_outcome, null, "not terminal");
    assert.equal(await balance(store, user), 0, "nothing credited");
  });

  test("6. a query failure reports the provider's own code, without leaking the request", async () => {
    const provider = scripted([
      Object.assign(new Error("Daraja could not answer the STK query."), {
        code: "DARAJA_QUERY_FAILED",
        details: { errorCode: "500.001.1001", errorMessage: "The transaction is being processed", status: 500 },
      }),
    ]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_ERR1", checkoutId: "ws_CO_ERR1" });

    const summary = await reconciler.runOnce({ reason: "test" });

    assert.equal(summary.inconclusive, 1);
    assert.equal(await balance(store, user), 0, "nothing credited");
  });

  test("7. malformed and inconclusive responses never credit (classifier table)", () => {
    const cases = [
      [null, "malformed_response"],
      [undefined, "malformed_response"],
      ["not json", "malformed_response"],
      [[], "malformed_response"],
      [{}, "no_result_code"],
      [{ ResultCode: "not-a-number" }, "unparsable_result_code"],
      [{ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }, "provider_reported_error"],
      [{ ResponseCode: "1", ResultCode: "0" }, "query_not_accepted"],
    ];
    for (const [input, reason] of cases) {
      const verdict = classifyQueryResponse(input);
      assert.equal(verdict.verdict, "inconclusive", `${JSON.stringify(input)} must be inconclusive`);
      assert.equal(verdict.reason, reason, `${JSON.stringify(input)} reason`);
    }

    // And the ones that ARE decisions. `paid_unverified` is a decision, not an
    // inconclusive answer: it says the provider confirmed a payment we cannot
    // verify, which is exactly what the review state exists for.
    assert.equal(classifyQueryResponse(notPaid("ws_CO_X")).verdict, "not_paid");
    assert.equal(classifyQueryResponse(paid("ws_CO_X")).verdict, "paid");
    assert.equal(classifyQueryResponse(paid("ws_CO_X", { metadata: false })).verdict, "paid_unverified");
    assert.equal(classifyQueryResponse(paid("ws_CO_X", { metadata: false })).reason, "no_callback_metadata");

    const unparsableAmount = { ResponseCode: "0", ResultCode: "0", CallbackMetadata: { Item: [{ Name: "Amount", Value: "x" }, { Name: "MpesaReceiptNumber", Value: "R" }] } };
    assert.equal(classifyQueryResponse(unparsableAmount).verdict, "paid_unverified");
    assert.equal(classifyQueryResponse(unparsableAmount).reason, "unparsable_amount");

    const noAmount = { ResponseCode: "0", ResultCode: "0", CallbackMetadata: { Item: [{ Name: "MpesaReceiptNumber", Value: "R" }] } };
    assert.equal(classifyQueryResponse(noAmount).verdict, "paid_unverified", "a receipt with no amount is still unverifiable");

    // A non-zero result is a decision even without metadata.
    assert.equal(classifyQueryResponse(notPaid("ws_CO_X", 1037, "DS timeout user cannot be reached")).verdict, "not_paid");
  });

  test("8. repeated reconciliation does not double-credit", async () => {
    const provider = scripted([paid("ws_CO_ONCE1", { receipt: "ONCE00000001" })]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    const deposit = await seed(store, user, { reference: "PAL_ONCE1", checkoutId: "ws_CO_ONCE1" });

    await reconciler.runOnce({ reason: "test" });
    assert.equal(await balance(store, user), 1, "credited once");

    // A second worker holding a STALE copy of the deposit (still `pending` as far
    // as its own memory is concerned) tries to act on it. This is the realistic
    // double-credit path, and the claim is what stops it.
    const stale = { ...deposit, status: "pending" };
    const second = await reconciler.reconcileOne(stale);

    assert.equal(second.outcome, "not_claimed", "the claim refused it, because the row is no longer pending");
    assert.equal(await balance(store, user), 1, "and still credited exactly once");
    assert.equal(depositCredits(store).length, 1, "one ledger entry, not two");

    // And the batch scan does not even consider it again.
    const third = await reconciler.runOnce({ reason: "test" });
    assert.equal(third.considered, 0, "a completed deposit is not eligible for another attempt");
    assert.equal(await balance(store, user), 1, "balance unchanged");
  });

  test("9. a callback and reconciliation racing settle at most once", async () => {
    // Two different, individually valid receipts for the same deposit: whichever
    // path lands first must be the only one that credits.
    const provider = scripted([paid("ws_CO_RACE1", { receipt: "RACE_QUERY_01" })]);
    const { store, user, routes, reconciler } = makeWorld({ queryProvider: provider });
    const deposit = await seed(store, user, { reference: "PAL_RACE1", checkoutId: "ws_CO_RACE1" });

    const [callback] = await Promise.all([
      routes.mpesaCallback({
        req: { headers: {} },
        body: callbackEnvelope("ws_CO_RACE1", { receipt: "RACE_CALLBACK_1" }),
        params: { token: CALLBACK_TOKEN },
      }),
      reconciler.reconcileOne(deposit),
    ]);

    assert.equal(callback.ResultCode, 0, "the callback was answered, so Safaricom stops retrying");
    assert.equal(await balance(store, user), 1, "exactly one credit, whoever won");
    assert.equal(depositCredits(store).length, 1, "exactly one ledger entry");
    assert.equal(stateOf(store, "PAL_RACE1").status, "completed", "the deposit ended up completed");
  });

  test("10. a completed deposit is never claimed, so a late result cannot fail it", async () => {
    const provider = scripted([notPaid("ws_CO_DONE1", 1032)]);
    const { store, user, routes, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_DONE1", checkoutId: "ws_CO_DONE1" });

    // Settle it the normal way first.
    await routes.mpesaCallback({
      req: { headers: {} },
      body: callbackEnvelope("ws_CO_DONE1", { receipt: "DONE00000001" }),
      params: { token: CALLBACK_TOKEN },
    });
    assert.equal(stateOf(store, "PAL_DONE1").status, "completed");
    assert.equal(await balance(store, user), 1);

    // Now a query that says the payment failed arrives late.
    const summary = await reconciler.runOnce({ reason: "test" });

    assert.equal(provider.calls.length, 0, "a completed deposit is not even queried");
    assert.equal(summary.skipped, 0, "it never appeared in the due list");
    assert.equal(stateOf(store, "PAL_DONE1").status, "completed", "still completed");
    assert.equal(await balance(store, user), 1, "and the credit stands");
    assert.equal(stateOf(store, "PAL_DONE1").failure_reason, null, "no failure was written");
  });

  test("11. a bare ResultCode 0 is recorded for review, never credited (real Daraja shape)", async () => {
    const provider = scripted([paid("ws_CO_BARE1", { metadata: false })]);
    const { store, user, reconciler, logger } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_BARE1", checkoutId: "ws_CO_BARE1" });

    await reconciler.runOnce({ reason: "test" });

    const deposit = stateOf(store, "PAL_BARE1");
    assert.equal(deposit.status, "pending", "the deposit stays pending: we cannot verify the payment");
    assert.equal(await balance(store, user), 0, "NOT credited — there is no receipt and no amount to verify");
    assert.equal(deposit.recon_outcome, RECONCILE_OUTCOMES.PAID_PENDING_RECEIPT, "recorded as paid-pending-receipt");
    assert.equal(deposit.next_reconcile_at, null, "and it stops being retried");
    assert.ok(
      logger.warn_().some((line) => /PAID according to the provider but returned no receipt/.test(line)),
      "and it is reported loudly, not discarded"
    );
  });

  test("12. a human finishing a paid-pending-receipt deposit credits it exactly once", async () => {
    // The documented recovery policy: the provider says it was paid, so the
    // deposit is never failed or discarded — an operator verifies the receipt in
    // the M-Pesa portal and the deposit is settled through the same path.
    const provider = scripted([
      paid("ws_CO_REVIEW1", { metadata: false }), // first pass: paid, unverifiable
      paid("ws_CO_REVIEW1", { receipt: "HUMAN0000001" }), // after the human supplies the receipt
    ]);
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_REVIEW1", checkoutId: "ws_CO_REVIEW1" });

    await reconciler.runOnce({ reason: "test" });
    assert.equal(stateOf(store, "PAL_REVIEW1").recon_outcome, RECONCILE_OUTCOMES.PAID_PENDING_RECEIPT);
    assert.equal(stateOf(store, "PAL_REVIEW1").status, "pending");

    // The operator's step: re-open the deposit for one more attempt.
    await store.updateDeposit("dep_PAL_REVIEW1", { recon_outcome: null, next_reconcile_at: null });
    await reconciler.runOnce({ reason: "operator" });

    assert.equal(stateOf(store, "PAL_REVIEW1").status, "completed", "now settled");
    assert.equal(await balance(store, user), 1, "credited exactly once");
    assert.equal(depositCredits(store).length, 1);
  });

  test("13. an unknown CheckoutRequestID cannot credit, and a mismatched one is ignored", async () => {
    // (a) A forged callback naming a checkout id we never issued.
    const provider = scripted([notPaid("ws_CO_OURS1")]);
    const { store, user, routes, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_OURS1", checkoutId: "ws_CO_OURS1" });

    const forged = await routes.mpesaCallback({
      req: { headers: {} },
      body: callbackEnvelope("ws_CO_NEVER_ISSUED", { receipt: "FORGED000001" }),
      params: { token: CALLBACK_TOKEN },
    });
    assert.equal(forged.ResultCode, 0, "answered so Safaricom stops retrying");
    assert.equal(await balance(store, user), 0, "and nothing was credited");
    assert.equal(store._state.mpesa_callbacks.some((c) => c.outcome === "unknown_checkout"), true, "recorded as unknown");

    // (b) A query answer about a DIFFERENT transaction proves nothing here.
    const other = scripted([paid("ws_CO_SOMEBODY_ELSE", { receipt: "MISMATCH0001" })]);
    const world2 = makeWorld({ queryProvider: other });
    await seed(world2.store, world2.user, { reference: "PAL_MISMATCH1", checkoutId: "ws_CO_MISMATCH1" });

    await world2.reconciler.runOnce({ reason: "test" });

    assert.equal(await balance(world2.store, world2.user), 0, "a mismatched answer credits nothing");
    assert.equal(stateOf(world2.store, "PAL_MISMATCH1").status, "pending", "and changes no state");
    assert.equal(stateOf(world2.store, "PAL_MISMATCH1").recon_outcome, null, "it stays retryable");
  });

  test("14. an amount below the deposit's own settlement amount is refused, not credited", async () => {
    const provider = scripted([paid("ws_CO_SHORT1", { amount: 80, receipt: "SHORT0000001" })]);
    const { store, user, reconciler, logger } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_SHORT1", checkoutId: "ws_CO_SHORT1", kes: 130 });

    await reconciler.runOnce({ reason: "test" });

    assert.equal(await balance(store, user), 0, "an underpayment credits nothing");
    assert.equal(stateOf(store, "PAL_SHORT1").status, "pending", "and does not complete the deposit");
    assert.equal(stateOf(store, "PAL_SHORT1").recon_outcome, RECONCILE_OUTCOMES.NEEDS_REVIEW, "it asks for a human instead");
    assert.ok(logger.error_().some((line) => /settlement refused/.test(line)), "and says why");
  });

  test("15. a receipt already used by one deposit cannot credit a second", async () => {
    // The same M-Pesa receipt answered for two different deposits: one payment,
    // so at most one credit.
    const provider = scriptFor({
      ws_CO_DUP_A: paid("ws_CO_DUP_A", { receipt: "SHARED_RECEIPT" }),
      ws_CO_DUP_B: paid("ws_CO_DUP_B", { receipt: "SHARED_RECEIPT" }),
    });
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_DUP_A", checkoutId: "ws_CO_DUP_A" });
    await seed(store, user, { reference: "PAL_DUP_B", checkoutId: "ws_CO_DUP_B" });

    await reconciler.runOnce({ reason: "test" });

    assert.equal(await balance(store, user), 1, "one payment credits one wallet, however many attempts");
    assert.equal(depositCredits(store).length, 1, "one ledger entry");
    const completed = store._state.deposits.filter((d) => d.status === "completed");
    assert.equal(completed.length, 1, "exactly one of the two deposits completed");
  });

  test("16. retry limits and exponential backoff are honoured", async () => {
    const config = reconcileConfig({ ...FAST, MPESA_RECONCILE_BACKOFF_MS: "1000", MPESA_RECONCILE_MAX_BACKOFF_MS: "4000" });
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6].map((n) => backoffFor(n, config)),
      [1000, 2000, 4000, 4000, 4000, 4000],
      "doubles each attempt and stops at the ceiling"
    );

    // maxAttempts: 2 — the third query never happens.
    const provider = scripted([{ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }]);
    const { store, user, reconciler } = makeWorld({
      queryProvider: provider,
      reconcileOverrides: { MPESA_RECONCILE_MAX_ATTEMPTS: "2" },
    });
    await seed(store, user, { reference: "PAL_RETRY1", checkoutId: "ws_CO_RETRY1" });

    await reconciler.runOnce({ reason: "test" });
    assert.equal(stateOf(store, "PAL_RETRY1").recon_outcome, null, "attempt 1 is not terminal");

    // Rewind the schedule (the clock the worker saw has moved on).
    await store.updateDeposit("dep_PAL_RETRY1", { next_reconcile_at: new Date(Date.now() - 1000).toISOString() });
    await reconciler.runOnce({ reason: "test" });
    assert.equal(provider.calls.length, 2, "attempt 2 happened");
    assert.equal(stateOf(store, "PAL_RETRY1").recon_outcome, RECONCILE_OUTCOMES.NEEDS_REVIEW, "and then it stopped trying");
    assert.equal(stateOf(store, "PAL_RETRY1").next_reconcile_at, null, "no further schedule");

    await store.updateDeposit("dep_PAL_RETRY1", { next_reconcile_at: new Date(Date.now() - 1000).toISOString() });
    await reconciler.runOnce({ reason: "test" });
    assert.equal(provider.calls.length, 2, "a review-marked deposit is never queried again");
  });

  test("17. one failing query does not stop the others being processed", async () => {
    const provider = scriptFor({
      ws_CO_ONE: notPaid("ws_CO_ONE", 1032),
      ws_CO_TWO: Object.assign(new Error("boom"), { code: "DARAJA_QUERY_FAILED" }),
      ws_CO_THREE: paid("ws_CO_THREE", { receipt: "THIRD0000001" }),
    });
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_ONE", checkoutId: "ws_CO_ONE", ageMs: 120_000 });
    await seed(store, user, { reference: "PAL_TWO", checkoutId: "ws_CO_TWO", ageMs: 110_000 });
    await seed(store, user, { reference: "PAL_THREE", checkoutId: "ws_CO_THREE", ageMs: 100_000 });

    const summary = await reconciler.runOnce({ reason: "test" });

    assert.equal(summary.considered, 3, "all three were attempted");
    assert.equal(stateOf(store, "PAL_ONE").status, "failed", "the first was resolved");
    assert.equal(stateOf(store, "PAL_TWO").status, "pending", "the one that errored is left pending");
    assert.equal(stateOf(store, "PAL_THREE").status, "completed", "the last one was still settled");
    assert.equal(await balance(store, user), 1, "exactly one credit");
  });

  test("18. a restart resumes from the persisted attempt count", async () => {
    const failing = scripted([{ errorCode: "500.001.1001", errorMessage: "The transaction is being processed" }]);
    const first = makeWorld({ queryProvider: failing });
    await seed(first.store, first.user, { reference: "PAL_RESUME1", checkoutId: "ws_CO_RESUME1" });
    await first.reconciler.runOnce({ reason: "before restart" });

    const afterFirst = stateOf(first.store, "PAL_RESUME1");
    assert.equal(afterFirst.recon_attempts, 1, "attempt 1 recorded");
    assert.ok(afterFirst.next_reconcile_at, "with a next attempt scheduled");

    // A brand-new worker over the same ledger — the state is in the store, not in
    // the process, which is what makes a redeploy safe.
    const secondReconciler = createReconciler({
      ledger: {
        listDue: (options) => first.store.listReconcilableDeposits(options),
        claim: (id, options) => first.store.claimDepositForReconciliation(id, options),
        failIfUnsettled: (id, patch) => first.store.failDepositIfUnsettled(id, patch),
        update: (id, patch) => first.store.updateDeposit(id, patch),
      },
      settleDeposit: first.routes._settleDeposit,
      queryProvider: failing,
      config: reconcileConfig(FAST),
      logger: capture(),
    });

    const early = await secondReconciler.runOnce({ reason: "after restart" });
    assert.equal(early.considered, 0, "the backoff is respected across a restart");
    assert.equal(failing.calls.length, 1, "so the provider was not asked again yet");

    await first.store.updateDeposit("dep_PAL_RESUME1", { next_reconcile_at: new Date(Date.now() - 1000).toISOString() });
    await secondReconciler.runOnce({ reason: "after restart" });

    assert.equal(stateOf(first.store, "PAL_RESUME1").recon_attempts, 2, "the count continued from 1, not from 0");
  });

  test("19. overlapping runs cannot happen at once", async () => {
    let release;
    const gatePromise = new Promise((resolve) => {
      release = resolve;
    });
    const provider = async () => {
      await gatePromise;
      return notPaid("ws_CO_OVERLAP");
    };
    const { store, user, reconciler } = makeWorld({ queryProvider: provider });
    await seed(store, user, { reference: "PAL_OVERLAP", checkoutId: "ws_CO_OVERLAP" });

    const running = reconciler.runOnce({ reason: "first" });
    // Give the first run a chance to get as far as the provider call.
    await new Promise((r) => setTimeout(r, 20));
    const second = await reconciler.runOnce({ reason: "second" });

    assert.equal(second.skipped, true, "the second run declined to start");
    assert.match(String(second.reason), /already in progress/);

    release();
    const first = await running;
    assert.equal(first.considered, 1, "the first run finished normally");
  });
});
