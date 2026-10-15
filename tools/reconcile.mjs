/**
 * Reconciliation for M-Pesa deposits whose callback never arrived.
 *
 * THE PROBLEM. An STK push is accepted, the intent is recorded `pending`, and
 * the outcome is supposed to arrive at the callback URL. If that delivery is lost
 * — the process was asleep, the tunnel died, Safaricom gave up retrying — the
 * deposit stays `pending` forever and the customer has paid without being
 * credited. Before this module, `stkQuery` existed and was documented as the fix
 * ("used when a callback never arrived") but nothing ever called it.
 *
 * THE RULE THIS MODULE OBEYS. A query is an *investigation*, not a payment.
 * Nothing here credits a wallet: the only function that does is `settleDeposit`
 * in payments.mjs, which validates the currency and the amount and credits
 * exactly once. This module decides whether a deposit is worth asking about, asks
 * once per attempt, and then hands the answer to that same settlement path — the
 * one the callback uses. There is no second way into the ledger.
 *
 * WHAT A REAL QUERY CAN AND CANNOT TELL US. Safaricom's STK query answers with
 * `ResponseCode`, `MerchantRequestID`, `CheckoutRequestID`, `ResultCode` and
 * `ResultDesc` — and, unlike the callback, it does NOT reliably return
 * `CallbackMetadata`, so it usually carries no receipt number and no amount:
 *
 *   { "ResponseCode": "0", "ResultCode": "0",
 *     "ResultDesc": "The service request is processed successfully." }
 *
 *   { "errorCode": "500.001.1001", "errorMessage": "The transaction is being processed" }
 *
 * (Shape taken from the client's documented examples; see PAYMENTS.md. The
 * official portal pages for the query endpoint render as shells, so this is
 * corroborated rather than vendor-verified.)
 *
 * That has a hard consequence, and it is the most important line in this file: a
 * bare `ResultCode: 0` means money moved, but with no receipt and no amount there
 * is nothing to verify against, so it is NOT credited automatically. It is
 * recorded as `paid_pending_receipt` — a documented review state, left `pending`,
 * logged loudly, never silently discarded — and a human settles it through the
 * same probe the callback uses. Crediting on a claim would be exactly the bug
 * this file exists to prevent. When a response does carry usable metadata (some
 * aggregators do return it), it goes through `settleDeposit` like any other
 * verified payment.
 *
 * Sources for the query shape: Safaricom's developer portal
 * (developer.safaricom.co.ke, M-Pesa Express / STK Push Query) and the
 * community-documented response examples recorded in PAYMENTS.md.
 */

/** Terminal outcomes recorded against a deposit. Anything else keeps retrying. */
export const RECONCILE_OUTCOMES = {
  /** Verified metadata arrived and settlement credited exactly once. */
  PAID: "reconciled_paid",
  /** The provider confirmed a non-zero result; failed through the guarded path. */
  NOT_PAID: "reconciled_not_paid",
  /**
   * `ResultCode: 0` with no receipt or amount. Money moved; nothing to verify.
   * Stays `pending`, stops retrying, needs a human.
   */
  PAID_PENDING_RECEIPT: "paid_pending_receipt",
  /** A settlement was refused (amount/currency/state). No credit happened. */
  NEEDS_REVIEW: "needs_review",
  /** A non-zero result arrived for a deposit that had already settled. */
  IGNORED_AFTER_SETTLEMENT: "ignored_after_settlement",
};

/**
 * Configuration, all optional, all off by default.
 *
 * `enabled` is deliberately a separate, explicit variable rather than "on
 * whenever credentials exist": a test run or a dry-run deployment must not start
 * querying Safaricom just because it happens to have keys.
 */
export function reconcileConfig(env = process.env) {
  const positive = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    enabled: String(env.MPESA_RECONCILE_ENABLED || "") === "1",
    /**
     * How long a deposit waits for its callback before it is queried. A callback
     * normally lands within seconds, so this is a safety margin: querying sooner
     * would race the callback and produce a "still being processed" answer.
     */
    afterMs: positive(env.MPESA_RECONCILE_AFTER_MS, 90_000),
    intervalMs: positive(env.MPESA_RECONCILE_INTERVAL_MS, 60_000),
    batchSize: Math.min(positive(env.MPESA_RECONCILE_BATCH, 25), 200),
    concurrency: Math.min(positive(env.MPESA_RECONCILE_CONCURRENCY, 3), 10),
    /** Attempts per deposit before it stops being retried automatically. */
    maxAttempts: Math.min(positive(env.MPESA_RECONCILE_MAX_ATTEMPTS, 6), 50),
    backoffMs: positive(env.MPESA_RECONCILE_BACKOFF_MS, 30_000),
    maxBackoffMs: positive(env.MPESA_RECONCILE_MAX_BACKOFF_MS, 30 * 60_000),
    /** Bounds one provider call. A timeout is inconclusive, never a failure. */
    timeoutMs: positive(env.MPESA_RECONCILE_TIMEOUT_MS, 15_000),
  };
}

/** Exponential backoff with a ceiling. Attempt 1 waits `backoffMs`. */
export function backoffFor(attempt, config) {
  const step = Math.max(1, Number(attempt) || 1);
  return Math.min(config.backoffMs * 2 ** (step - 1), config.maxBackoffMs);
}

/**
 * Reads a query response. Pure, so every branch below can be tested without a
 * provider, a clock or a database.
 *
 * Never throws, and never returns a verdict that could credit on a guess: an
 * unreadable response is `inconclusive`, which retries and credits nothing.
 */
export function classifyQueryResponse(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { verdict: "inconclusive", reason: "malformed_response" };
  }

  const errorCode = raw.errorCode ?? raw.ErrorCode ?? null;
  const errorMessage = raw.errorMessage ?? raw.ErrorMessage ?? null;
  const responseCode = raw.ResponseCode ?? raw.responseCode ?? null;
  const rawResult = raw.ResultCode ?? raw.resultCode ?? null;

  // No result code at all: the provider is reporting a problem with the query
  // itself (still processing, bad shortcode, unauthorised). Worth retrying, and
  // never worth crediting.
  if (rawResult == null) {
    return {
      verdict: "inconclusive",
      reason: errorCode || errorMessage ? "provider_reported_error" : "no_result_code",
      provider_error_code: errorCode == null ? null : String(errorCode).slice(0, 40),
      provider_error_message: errorMessage == null ? null : String(errorMessage).slice(0, 200),
      response_code: responseCode == null ? null : String(responseCode).slice(0, 20),
    };
  }

  const resultCode = Number(rawResult);
  if (!Number.isFinite(resultCode)) {
    return { verdict: "inconclusive", reason: "unparsable_result_code" };
  }
  const resultDesc = typeof raw.ResultDesc === "string" ? raw.ResultDesc.slice(0, 200) : null;

  // A query that was not itself accepted tells us nothing about the payment.
  if (responseCode != null && String(responseCode) !== "0") {
    return {
      verdict: "inconclusive",
      reason: "query_not_accepted",
      response_code: String(responseCode).slice(0, 20),
      result_code: resultCode,
    };
  }

  // Any non-zero result means no money moved. This is the same meaning the
  // callback handler gives it, so both paths agree.
  if (resultCode !== 0) {
    return { verdict: "not_paid", result_code: resultCode, result_desc: resultDesc };
  }

  // ResultCode 0: the payment succeeded. Now — can we verify it?
  const items = raw.CallbackMetadata && (raw.CallbackMetadata.Item ?? raw.CallbackMetadata);
  const item = (name) =>
    Array.isArray(items) ? items.find((i) => i && (i.Name === name || i.name === name))?.Value : undefined;
  const receipt = item("MpesaReceiptNumber") ?? item("MpesaReceiptNumber".toLowerCase());
  const amount = item("Amount") ?? item("amount");

  if (receipt == null || amount == null) {
    return { verdict: "paid_unverified", result_code: 0, result_desc: resultDesc, reason: "no_callback_metadata" };
  }
  const verifiedAmount = Number(amount);
  if (!Number.isFinite(verifiedAmount)) {
    return { verdict: "paid_unverified", result_code: 0, result_desc: resultDesc, reason: "unparsable_amount" };
  }
  return {
    verdict: "paid",
    result_code: 0,
    result_desc: resultDesc,
    receipt: String(receipt).slice(0, 64),
    amount: verifiedAmount,
  };
}

/** Bounds a provider call. Rejects with a labelled timeout; no payload leak. */
function withDeadline(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} did not answer within ${ms}ms`);
      err.code = "RECONCILE_TIMEOUT";
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Enough of an error to diagnose it, and never the request body (which carries
 * the Daraja password) or the whole provider response.
 */
export function safeError(err) {
  if (!err) return { code: null, message: "unknown" };
  const details = err.details && typeof err.details === "object" ? err.details : {};
  const code = err.code || details.errorCode || null;
  return {
    code: code == null ? null : String(code).slice(0, 60),
    message: String(err.message || err).slice(0, 200),
    provider_error_code: details.errorCode == null ? null : String(details.errorCode).slice(0, 40),
    provider_error_message: details.errorMessage == null ? null : String(details.errorMessage).slice(0, 200),
  };
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1));
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await fn(items[index]);
      } catch (err) {
        // One deposit's unexpected failure must not abort the batch.
        results[index] = { reference: items[index]?.reference ?? null, outcome: "error", error: safeError(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The worker.
 *
 * `ledger` is the narrow slice of the store this module needs, so the tests can
 * drive it against a fake or the real store without either being special-cased:
 *
 *   listDue({ now, olderThanMs, limit }) -> deposits
 *   claim(id, { now, nextAt })           -> deposit | null   (atomic)
 *   failIfUnsettled(id, patch)           -> deposit | null   (guarded)
 *   update(id, patch)                    -> deposit | null
 *
 * `settleDeposit` is the application's only crediting path, passed in so this
 * module cannot invent a second one.
 */
export function createReconciler({
  ledger,
  settleDeposit,
  queryProvider,
  config = reconcileConfig(),
  clock = () => Date.now(),
  logger = console,
} = {}) {
  if (!ledger) throw new Error("createReconciler needs a ledger");
  if (typeof settleDeposit !== "function") throw new Error("createReconciler needs settleDeposit");
  if (typeof queryProvider !== "function") throw new Error("createReconciler needs a queryProvider");

  const state = { running: false, started: false, timer: null, current: null, lastRun: null, runs: 0, stopped: false };

  /** Records a terminal (or retryable) outcome on the claimed deposit. */
  const finish = async (deposit, patch) => {
    try {
      await ledger.update(deposit.id, { last_reconciled_at: new Date(clock()).toISOString(), ...patch });
    } catch (err) {
      // The outcome could not be recorded, so the deposit will come round again.
      // That is safe — every action taken here is idempotent — and worth saying.
      logger.error(`[reconcile] could not record the outcome for ${deposit.reference}: ${safeError(err).message}`);
    }
  };

  async function reconcileOne(deposit) {
    const now = clock();
    const attempts = Number(deposit.recon_attempts || 0) + 1;
    const claimed = await ledger.claim(deposit.id, { now, nextAt: now + backoffFor(attempts, config) });
    if (!claimed) {
      // Another worker has it, it settled, or it left `pending` — all fine.
      return { reference: deposit.reference, outcome: "not_claimed", attempt: Number(deposit.recon_attempts || 0) };
    }

    let raw;
    try {
      raw = await withDeadline(
        queryProvider({
          checkoutRequestId: claimed.checkout_request_id,
          reference: claimed.reference,
          amount: claimed.settlement_amount,
          currency: claimed.settlement_currency,
        }),
        config.timeoutMs,
        "Daraja STK Query"
      );
    } catch (err) {
      // A timeout, a network error or a provider error is inconclusive: we could
      // not establish the outcome, so nothing is credited and nothing is failed.
      const error = safeError(err);
      const exhausted = attempts >= config.maxAttempts;
      const patch = exhausted
        ? { recon_outcome: RECONCILE_OUTCOMES.NEEDS_REVIEW, next_reconcile_at: null }
        : { next_reconcile_at: new Date(now + backoffFor(attempts, config)).toISOString() };
      await finish(claimed, patch);
      logger.warn(
        `[reconcile] ${claimed.reference} attempt ${attempts}: query failed (${error.code || "no code"}) — deposit left pending` +
          (exhausted ? ", marked for review" : "")
      );
      return { reference: claimed.reference, outcome: exhausted ? "needs_review" : "inconclusive", attempt: attempts, error };
    }

    let verdict = classifyQueryResponse(raw);

    // The response must be about the transaction we asked about. Safaricom echoes
    // the CheckoutRequestID back; if it names a different one, this answer proves
    // nothing about this deposit and is treated as inconclusive rather than
    // acted on. Crediting the wrong intent on a mixed-up answer is exactly the
    // kind of bug that has no obvious symptom until the books disagree.
    const returnedCheckout = raw && typeof raw === "object" ? raw.CheckoutRequestID ?? raw.checkoutRequestID ?? null : null;
    if (returnedCheckout != null && String(returnedCheckout) !== String(claimed.checkout_request_id)) {
      verdict = { verdict: "inconclusive", reason: "checkout_id_mismatch" };
    }

    if (verdict.verdict === "not_paid") {
      // The provider says no money moved. Use the SAME guarded transition the
      // callback uses: it only touches a deposit that is still pending, so a
      // deposit that settled in the meantime cannot be un-paid by this.
      const failed = await ledger.failIfUnsettled(claimed.id, {
        status: "failed",
        mpesa_result_code: verdict.result_code,
        failure_reason: verdict.result_desc || `MPESA_RESULT_${verdict.result_code}`,
        last_reconciled_at: new Date(clock()).toISOString(),
        next_reconcile_at: null,
      });
      const outcome = failed ? RECONCILE_OUTCOMES.NOT_PAID : RECONCILE_OUTCOMES.IGNORED_AFTER_SETTLEMENT;
      await finish(claimed, { recon_outcome: outcome, next_reconcile_at: null });
      logger.log(
        `[reconcile] ${claimed.reference} attempt ${attempts}: provider result ${verdict.result_code}` +
          ` (${verdict.result_desc || "no description"}) — ${failed ? "deposit failed, nothing credited" : "already settled, left alone"}`
      );
      return { reference: claimed.reference, outcome: failed ? "not_paid" : "ignored_after_settlement", attempt: attempts, result_code: verdict.result_code };
    }

    if (verdict.verdict === "paid_unverified") {
      // Money moved but there is no receipt and no amount to verify. Crediting
      // here would be paying out on an unverifiable claim, so it does not happen;
      // the deposit stays pending and a human finishes it. This is the case a
      // real Daraja query produces most often, so it is deliberately loud.
      await finish(claimed, { recon_outcome: RECONCILE_OUTCOMES.PAID_PENDING_RECEIPT, next_reconcile_at: null });
      logger.warn(
        `[reconcile] ${claimed.reference} is PAID according to the provider but returned no receipt or amount` +
          ` (${verdict.reason}) — NOT credited automatically; needs a human to verify it in the M-Pesa portal`
      );
      return { reference: claimed.reference, outcome: "paid_pending_receipt", attempt: attempts, result_code: 0 };
    }

    if (verdict.verdict === "paid") {
      try {
        const settlement = await settleDeposit({
          reference: claimed.reference,
          userId: claimed.user_id,
          providerReference: verdict.receipt,
          verifiedAmount: verdict.amount,
          currency: claimed.settlement_currency || claimed.currency || "KES",
        });
        const credited = !!settlement?.credited;
        await finish(claimed, {
          recon_outcome: credited ? RECONCILE_OUTCOMES.PAID : RECONCILE_OUTCOMES.PAID + ":already_settled",
          next_reconcile_at: null,
        });
        logger.log(
          `[reconcile] ${claimed.reference} attempt ${attempts}: verified payment — ${credited ? "credited once" : "already settled, not credited again"}`
        );
        return { reference: claimed.reference, outcome: credited ? "paid" : "already_settled", attempt: attempts, result_code: 0 };
      } catch (err) {
        // settleDeposit refused: wrong amount or currency, wrong account, a
        // deposit that is no longer settleable. Nothing was credited either way,
        // and retrying will not change that — so it stops and asks for a human.
        const error = safeError(err);
        await finish(claimed, { recon_outcome: RECONCILE_OUTCOMES.NEEDS_REVIEW, next_reconcile_at: null });
        logger.error(
          `[reconcile] ${claimed.reference} attempt ${attempts}: provider reported payment but settlement refused (${error.code || "no code"}) — not credited, needs review`
        );
        return { reference: claimed.reference, outcome: "settlement_refused", attempt: attempts, error };
      }
    }

    // Inconclusive: the query was understood but does not establish an outcome.
    const exhausted = attempts >= config.maxAttempts;
    await finish(
      claimed,
      exhausted
        ? { recon_outcome: RECONCILE_OUTCOMES.NEEDS_REVIEW, next_reconcile_at: null }
        : { next_reconcile_at: new Date(now + backoffFor(attempts, config)).toISOString() }
    );
    logger.log(
      `[reconcile] ${claimed.reference} attempt ${attempts}: inconclusive (${verdict.reason}${
        verdict.provider_error_message ? `: ${verdict.provider_error_message}` : ""
      }) — deposit left pending${exhausted ? ", marked for review" : ""}`
    );
    return { reference: claimed.reference, outcome: exhausted ? "needs_review" : "inconclusive", attempt: attempts, reason: verdict.reason };
  }

  /** One pass over the deposits that are due. Single-flight by construction. */
  async function runOnce({ reason = "manual", limit } = {}) {
    if (state.running) return { skipped: true, reason: "a run is already in progress" };
    state.running = true;
    const started = clock();
    const run = (async () => {
      const now = clock();
      const due = await ledger.listDue({
        now,
        olderThanMs: config.afterMs,
        limit: limit ?? config.batchSize,
      });
      const results = await mapLimit(due, config.concurrency, reconcileOne);
      const tally = results.reduce((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] || 0) + 1;
        return acc;
      }, {});
      const summary = {
        reason,
        due: due.length,
        considered: results.length,
        credited: tally.paid || 0,
        failed: tally.not_paid || 0,
        needs_review: (tally.needs_review || 0) + (tally.paid_pending_receipt || 0) + (tally.settlement_refused || 0),
        inconclusive: tally.inconclusive || 0,
        skipped: tally.not_claimed || 0,
        errors: (tally.error || 0) + (tally.ignored_after_settlement || 0),
        duration_ms: Math.max(0, clock() - started),
        at: new Date(clock()).toISOString(),
        outcomes: tally,
      };
      state.lastRun = summary;
      state.runs += 1;
      // A quiet pass says nothing; a pass that did something says what.
      if (summary.considered) {
        logger.log(
          `[reconcile] ${summary.considered} deposit(s) queried: ${summary.credited} credited, ${summary.failed} failed,` +
            ` ${summary.needs_review} for review, ${summary.inconclusive} inconclusive (${summary.duration_ms}ms)`
        );
      }
      return summary;
    })();
    state.current = run;
    try {
      return await run;
    } finally {
      state.running = false;
      state.current = null;
    }
  }

  /** Starts the interval. Overlapping runs are impossible: see `runOnce`. */
  function start() {
    if (state.started) return false;
    state.started = true;
    state.stopped = false;
    state.timer = setInterval(() => {
      runOnce({ reason: "interval" }).catch((err) => logger.error(`[reconcile] interval run failed: ${safeError(err).message}`));
    }, config.intervalMs);
    // Never hold the process open on its own.
    if (typeof state.timer.unref === "function") state.timer.unref();
    return true;
  }

  /** Stops the interval and waits for the run in flight, so a deploy is clean. */
  async function stop() {
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.started = false;
    const inFlight = state.current;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* the run reports its own failures */
      }
    }
    return true;
  }

  return {
    start,
    stop,
    runOnce,
    reconcileOne,
    status: () => ({
      enabled: !!config.enabled,
      running: state.running,
      started: state.started,
      runs: state.runs,
      last_run: state.lastRun,
      config: {
        after_ms: config.afterMs,
        interval_ms: config.intervalMs,
        batch_size: config.batchSize,
        concurrency: config.concurrency,
        max_attempts: config.maxAttempts,
        backoff_ms: config.backoffMs,
        max_backoff_ms: config.maxBackoffMs,
        timeout_ms: config.timeoutMs,
      },
    }),
  };
}
