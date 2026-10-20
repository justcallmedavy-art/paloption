/**
 * Deposit-domain tests.
 *
 * IMPORTANT: no live provider is contacted anywhere in this file. Every
 * provider is exercised in its unconfigured state, and settlement is driven by
 * explicit fixtures. Nothing here proves that Daraja, a card processor or a
 * TRON custodian works — see PAYMENTS.md.
 *
 * Run: npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createMemoryStore } from "../tools/store.mjs";
import {
  ApiError,
  createPaymentRoutes,
  createExchangeRateService,
  validateAmount,
  normaliseMsisdn,
  validateCardFields,
  isTronAddress,
  DEFAULT_TRON_DEPOSIT_ADDRESS,
  builtInWalletAllowed,
} from "../tools/payments.mjs";

/* ----------------------------- harness ----------------------------- */

/**
 * A stand-in for the live feed. Injecting it means the intent-flow tests never
 * touch the network, which is what keeps them honest: the provider they use is
 * explicitly a fixture and nothing here claims a real payment occurred.
 */
function rateFixture(rate = 130) {
  return {
    get: async () => ({
      base: "USD",
      quote: "KES",
      pair: "USD/KES",
      rate,
      provider: "fixture-provider",
      source: "fixture-provider",
      sourceUrl: "http://fixture.test/latest/USD",
      asOf: "2026-10-14T00:00:00Z",
      fetchedAt: Date.now(),
      cached: false,
    }),
  };
}

/** Credentials that clear the "not configured" gate. Not real, and never sent. */
const PROVIDER_ENV = {
  DARAJA_CONSUMER_KEY: "fixture-key",
  DARAJA_CONSUMER_SECRET: "fixture-secret",
  DARAJA_SHORTCODE: "174379",
  DARAJA_PASSKEY: "fixture-passkey",
  DARAJA_CALLBACK_URL: "https://example.test/api/auth/mpesa/callback",
  CARD_PROVIDER: "fixture-processor",
  CARD_SECRET_KEY: "fixture-card-key",
  TRON_WALLET_PROVIDER: "fixture-custodian",
  TRON_API_KEY: "fixture-tron-key",
};

/**
 * Environment for the spawned server, with every provider credential cleared.
 *
 * The server now reads .env.local, so without this the "unconfigured provider"
 * assertions would depend on whether the machine running them happens to have
 * real credentials — and a developer with Daraja keys would also have tests
 * dialling Safaricom. An empty string is present-but-unset: the loader leaves it
 * alone, so the provider stays deliberately unconfigured. The TRON wallet is
 * intentionally left to its default, because that is what the mirror ships.
 */
function serverEnv(extra = {}) {
  return {
    ...process.env,
    DARAJA_CONSUMER_KEY: "",
    DARAJA_CONSUMER_SECRET: "",
    DARAJA_SHORTCODE: "",
    DARAJA_PASSKEY: "",
    DARAJA_CALLBACK_URL: "",
    DARAJA_CALLBACK_TOKEN: "",
    DARAJA_BASE_URL: "",
    CARD_PROVIDER: "",
    CARD_SECRET_KEY: "",
    ...extra,
  };
}

function harness({ providers, exchange = rateFixture(), env } = {}) {
  // The same store interface the server uses, in its in-memory form — so these
  // tests drive the code path that runs in production, not a parallel one. The
  // arrays are still reachable as `db` because that is what the assertions below
  // read; writes go through the store.
  const store = createMemoryStore();
  const db = store.db;
  const user = { id: "u_alice", email: "alice@example.com", username: "Alice", real_balance: 0, demo_balance: 10000, is_demo: false };
  const other = { id: "u_bob", email: "bob@example.com", username: "Bob", real_balance: 0, demo_balance: 0, is_demo: false };
  db.users.push(user, other);
  db.sessions = { token_alice: user.id, token_bob: other.id };

  const requireUser = async (ctx) => {
    const header = ctx?.req?.headers?.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const userId = token && db.sessions[token];
    if (!userId) throw new ApiError(401, "UNAUTHENTICATED", "Not authorised");
    return db.users.find((u) => u.id === userId);
  };

  // config() is read when the routes are built, so credentials must be in the
  // environment before this point.
  const saved = {};
  for (const [key, value] of Object.entries(env || {})) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  const routes = createPaymentRoutes({ store, requireUser, providers, exchange });

  return {
    db,
    store,
    user,
    other,
    routes,
    restore,
    get persistCalls() { return store.writes; },
    set failPersist(v) { store.failWrites = v; },
    ctx: (token, body = {}) => ({ req: { headers: token ? { authorization: `Bearer ${token}` } : {} }, body, params: {} }),
  };
}

/** Creates a pending deposit fixture directly in the store. */
function seedDeposit(db, userId, overrides = {}) {
  const deposit = {
    id: `dep_${db.deposits.length}`,
    user_id: userId,
    reference: `PAL_fixture${db.deposits.length}`,
    amount: 10,
    currency: "KES",
    method: "mpesa",
    status: "pending",
    is_demo: false,
    provider_reference: null,
    created_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
  db.deposits.unshift(deposit);
  return deposit;
}

/* ------------------------------ tests ------------------------------ */

describe("validation", () => {
  test("1. amount bounds", () => {
    assert.equal(validateAmount(10, 1900), 10);
    assert.equal(validateAmount(1, 1900), 1, "the $1 minimum itself is accepted");
    assert.equal(validateAmount(1900, 1900), 1900, "the maximum itself is accepted");
    assert.throws(() => validateAmount(0.1, 1900), /Minimum deposit is \$1/);
    assert.throws(() => validateAmount(5000, 1900), /Maximum deposit is \$1900/);
    assert.throws(() => validateAmount("abc", 1900), /must be a number/);
    // floats are rounded to cents, never left as raw float drift
    assert.equal(validateAmount(10.005, 1900), 10.01);
  });

  test("2. Kenyan phone numbers", () => {
    assert.equal(normaliseMsisdn("0712345678"), "254712345678");
    assert.equal(normaliseMsisdn("+254 712 345 678"), "254712345678");
    assert.equal(normaliseMsisdn("254712345678"), "254712345678");
    assert.equal(normaliseMsisdn("0110000000"), "254110000000");
    assert.throws(() => normaliseMsisdn("12345"), /valid Kenyan phone/);
    assert.throws(() => normaliseMsisdn(""), /required/);
    assert.throws(() => normaliseMsisdn("254312345678"), /valid Kenyan phone/);
  });

  test("card fields are validated but never returned", () => {
    const ok = validateCardFields({ number: "4242 4242 4242 4242", expiry: "12/30", cvc: "123", name: "Test User" });
    assert.deepEqual(ok, { last4: "4242", brand: "visa", expiry: "12/30" });
    assert.equal(ok.number, undefined, "raw PAN must not be returned");
    assert.equal(ok.cvc, undefined, "CVC must not be returned");
    assert.throws(() => validateCardFields({ number: "4242424242424241", expiry: "12/30", cvc: "123", name: "T U" }), /not valid/);
    assert.throws(() => validateCardFields({ number: "4242424242424242", expiry: "12/20", cvc: "123", name: "T U" }), /expired/);
    assert.throws(() => validateCardFields({ number: "4242424242424242", expiry: "13/30", cvc: "123", name: "T U" }), /month is not valid/);
  });
});

describe("authentication and authorisation", () => {
  test("3. unauthenticated requests are rejected", async () => {
    const h = harness();
    for (const call of [
      () => h.routes.mpesaStkPush(h.ctx(null, { amount: 10, phone: "0712345678" })),
      () => h.routes.cardDeposit(h.ctx(null, { amount: 10, card: {} })),
      () => h.routes.trc20Address(h.ctx(null)),
      () => h.routes.listDeposits(h.ctx(null)),
      () => h.routes.depositStatus({ req: { headers: {} }, params: { reference: "PAL_x" } }),
    ]) {
      await assert.rejects(call, (e) => e.status === 401 && e.code === "UNAUTHENTICATED");
    }
  });

  // exchange-rate deliberately is NOT in the list above. See the test below.
  test("24. exchange-rate is public, because the client never authenticates to it", async () => {
    const h = harness();
    const rate = await h.routes.exchangeRate({ req: { headers: {} }, body: {} });
    assert.equal(rate.pair, "USD/KES");
    assert.equal(rate.rate, 130);
    assert.equal(rate.source, "fixture-provider", "the source is reported, never invented");
  });

  test("13. a user cannot read another user's deposit", async () => {
    const h = harness();
    const deposit = seedDeposit(h.db, h.other.id);
    await assert.rejects(
      () => h.routes.depositStatus({ req: { headers: { authorization: "Bearer token_alice" } }, params: { reference: deposit.reference } }),
      (e) => e.status === 403 && e.code === "FORBIDDEN"
    );
    // and the owner can
    const own = await h.routes.depositStatus({ req: { headers: { authorization: "Bearer token_bob" } }, params: { reference: deposit.reference } });
    assert.equal(own.deposit.reference, deposit.reference);
  });

  test("listDeposits only returns the caller's own deposits", async () => {
    const h = harness();
    seedDeposit(h.db, h.user.id);
    seedDeposit(h.db, h.other.id);
    const mine = await h.routes.listDeposits(h.ctx("token_alice"));
    assert.equal(mine.deposits.length, 1);
    assert.equal(mine.deposits[0].user_id, undefined, "internal owner id must not leak");
  });
});

describe("unconfigured providers", () => {
  test("4. missing credentials produce a configuration error, not a fake success", async () => {
    const h = harness();
    const mpesa = await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" })).catch((e) => e);
    assert.equal(mpesa.status, 503);
    assert.equal(mpesa.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
    assert.deepEqual(mpesa.extra.required_env, [
      "DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_CALLBACK_URL",
    ]);

    const card = await h.routes.cardDeposit(h.ctx("token_alice", {
      amount: 10,
      card: { number: "4242424242424242", expiry: "12/30", cvc: "123", name: "Test User" },
    })).catch((e) => e);
    assert.equal(card.status, 503);
    assert.equal(card.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");

    const tron = await h.routes.trc20Address(h.ctx("token_alice")).catch((e) => e);
    assert.equal(tron.status, 503);
    assert.equal(tron.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
  });

  test("5. no wallet is credited when a provider is unconfigured", async () => {
    const h = harness();
    await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 25, phone: "0712345678" })).catch(() => {});
    assert.equal(h.user.real_balance, 0);
    assert.equal(h.db.transactions.length, 0);
  });

  test("10. an unconfigured TRC20 provider never invents an address", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.routes.trc20Address(h.ctx("token_alice")).catch(() => {});
    assert.equal(Object.keys(h.db.trc20_addresses).length, 0, "no address may be fabricated");
  });
});

describe("the static operator wallet", () => {
  const WALLET = "TY6nEvWDneE8XuTj7ua8s1dSXdo7dkZWXW";

  test("the shipped default is a well-formed TRON address", () => {
    assert.equal(DEFAULT_TRON_DEPOSIT_ADDRESS, WALLET);
    assert.ok(isTronAddress(DEFAULT_TRON_DEPOSIT_ADDRESS));
    assert.ok(isTronAddress("T" + "1".repeat(33)), "a T plus 33 base58 characters is the shape");
    assert.ok(!isTronAddress("not-an-address"));
    assert.ok(!isTronAddress(`${WALLET}0`), "34 characters exactly");
    assert.ok(!isTronAddress(`${WALLET}0`.slice(0, 33)), "33 is too short");
    assert.ok(!isTronAddress(""), "empty is not an address");
  });

  test("a configured wallet is served verbatim, then cached", async () => {
    const h = harness({ env: { TRON_DEPOSIT_ADDRESS: WALLET } });
    try {
      const first = await h.routes.trc20Address(h.ctx("token_alice"));
      assert.equal(first.address, WALLET, "the operator's own address, unaltered");
      assert.equal(first.network, "TRC20");
      assert.equal(first.cached, false, "the first read allocates");
      assert.equal(first.provider, "static-operator-wallet", "and names where it came from");

      const again = await h.routes.trc20Address(h.ctx("token_alice"));
      assert.equal(again.address, WALLET);
      assert.equal(again.cached, true);
      assert.equal(Object.keys(h.db.trc20_addresses).length, 1, "one entry, not one per read");

      // An address is not a payment: nothing was credited and no provider was
      // contacted to produce it.
      assert.deepEqual(h.db.transactions, []);
      assert.equal(h.user.real_balance, 0);
    } finally {
      h.restore();
    }
  });

  test("re-pointing the wallet reaches an account that already has a stale one", async () => {
    const h = harness({ env: { TRON_DEPOSIT_ADDRESS: WALLET } });
    try {
      // Left over from an earlier configuration. Serving it would send a
      // depositor to a wallet the operator no longer controls.
      h.db.trc20_addresses[h.user.id] = {
        address: "TStaleAddress00000000000000000000000",
        asset: "USDT",
        network: "TRC20",
      };
      const got = await h.routes.trc20Address(h.ctx("token_alice"));
      assert.equal(got.address, WALLET, "the configured wallet wins over a stale entry");
      assert.equal(got.cached, false);
    } finally {
      h.restore();
    }
  });

  test("the built-in demo wallet is opt-in, never inherited by saying nothing", () => {
    // This is the deployment that showed a public site an address nobody here
    // could spend from: it set nothing, and the default applied anyway.
    assert.equal(builtInWalletAllowed({}), false);
    assert.equal(builtInWalletAllowed({ TRON_ALLOW_BUILTIN_WALLET: "" }), false);
    assert.equal(builtInWalletAllowed({ TRON_ALLOW_BUILTIN_WALLET: "0" }), false);
    assert.equal(builtInWalletAllowed({ TRON_ALLOW_BUILTIN_WALLET: "no" }), false);
    for (const yes of ["1", "true", "YES", "on"]) {
      assert.equal(builtInWalletAllowed({ TRON_ALLOW_BUILTIN_WALLET: yes }), true, yes);
    }
  });

  test("a deployment that names no wallet refuses instead of serving the demo address", async () => {
    const h = harness({ env: { TRON_DEPOSIT_ADDRESS: "" } });
    try {
      const err = await h.routes.trc20Address(h.ctx("token_alice")).then(() => null, (e) => e);
      assert.ok(err, "the route must refuse");
      assert.equal(err.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
      assert.equal(JSON.stringify(err).includes(WALLET), false, "the demo wallet is never returned");
      assert.equal(Object.keys(h.db.trc20_addresses).length, 0, "and nothing is stored for later");
    } finally {
      h.restore();
    }
  });

  test("a malformed configured address is refused, never served or echoed", async () => {
    const h = harness({ env: { TRON_DEPOSIT_ADDRESS: "definitely-not-a-tron-address" } });
    try {
      const err = await h.routes.trc20Address(h.ctx("token_alice")).catch((e) => e);
      assert.equal(err.code, "TRON_ADDRESS_INVALID");
      assert.ok(!err.message.includes("definitely-not-a-tron-address"), "the value is not echoed");
      assert.equal(Object.keys(h.db.trc20_addresses).length, 0, "a bad address must never be cached");
    } finally {
      h.restore();
    }
  });

  test("an explicitly empty value disables the static wallet", async () => {
    const h = harness({ env: { TRON_DEPOSIT_ADDRESS: "" } });
    try {
      const err = await h.routes.trc20Address(h.ctx("token_alice")).catch((e) => e);
      assert.equal(err.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
      assert.equal(Object.keys(h.db.trc20_addresses).length, 0);
    } finally {
      h.restore();
    }
  });
});

describe("the M-Pesa result callback", () => {
  // The callback URL must carry the token path: a URL that does not is refused
  // as inconsistent configuration, because Safaricom's result would 404 and the
  // deposit would stay pending forever.
  const CALLBACK_ENV = {
    ...PROVIDER_ENV,
    DARAJA_CALLBACK_TOKEN: "cbk_test_token",
    DARAJA_CALLBACK_URL: "https://example.test/api/auth/mpesa/callback/cbk_test_token",
  };
  const TOKEN = "cbk_test_token";

  /** A STK Push fixture, so a pending deposit can be created without Safaricom. */
  function stkFixture() {
    return {
      darajaStkPush: async () => ({ CheckoutRequestID: "ws_CO_FIXTURE_1", MerchantRequestID: "mr_FIXTURE_1" }),
    };
  }

  /** Builds the envelope Safaricom POSTs to the callback URL. */
  function callbackFor(checkoutRequestId, { resultCode = 0, amount, receipt, desc } = {}) {
    const stkCallback = {
      MerchantRequestID: "mr_FIXTURE_1",
      CheckoutRequestID: checkoutRequestId,
      ResultCode: resultCode,
      ResultDesc: desc || (resultCode === 0 ? "The service request is processed successfully." : "Request cancelled by user"),
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

  const fire = (h, token, body) =>
    h.routes.mpesaCallback({ req: { headers: {} }, body, params: { token } }).catch((e) => e);

  /** Puts one pending M-Pesa deposit in the store, with a known checkout id. */
  async function pending(h) {
    await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" }));
    const deposit = h.db.deposits[0];
    assert.equal(deposit.status, "pending");
    assert.equal(deposit.checkout_request_id, "ws_CO_FIXTURE_1");
    return deposit;
  }

  test("a successful result credits exactly once, and a replay credits nothing", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);

      const first = await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { amount: 1300, receipt: "MPESA_RCPT_FIXTURE_1" }));
      assert.equal(first.ResultCode, 0, "Daraja is acknowledged");
      assert.equal(deposit.status, "completed");
      assert.equal(deposit.provider_reference, "MPESA_RCPT_FIXTURE_1", "the receipt is the audit trail");
      assert.equal(h.user.real_balance, 10, "1300 KES credits 10 USD");
      assert.equal(h.db.transactions.length, 1);

      // Safaricom can deliver the same notification more than once.
      const replay = await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { amount: 1300, receipt: "MPESA_RCPT_FIXTURE_1" }));
      assert.equal(replay.ResultCode, 0);
      assert.equal(h.user.real_balance, 10, "a replayed callback must not credit again");
      assert.equal(h.db.transactions.length, 1);
      assert.equal(h.db.mpesa_callbacks.length, 2, "both deliveries are kept for audit");
      assert.equal(h.db.mpesa_callbacks[0].outcome, "already_settled");
    } finally {
      h.restore();
    }
  });

  test("a cancelled prompt fails the intent and moves no money", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);
      const res = await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { resultCode: 1032 }));
      assert.equal(res.ResultCode, 0);
      assert.equal(deposit.status, "failed");
      assert.equal(deposit.mpesa_result_code, 1032);
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.transactions.length, 0);
      assert.equal(h.db.mpesa_callbacks[0].outcome, "not_paid");

      // The client tells a cancellation apart from a failure by this code, so it
      // has to survive into the status a browser polls — not just the row.
      const status = await h.routes.depositStatus({
        req: { headers: { authorization: "Bearer token_alice" } },
        params: { reference: deposit.reference },
      });
      assert.equal(status.deposit.mpesa_result_code, 1032);
      assert.equal(status.deposit.status, "failed");
    } finally {
      h.restore();
    }
  });

  test("a prompt Safaricom could not deliver says so, and keeps the number it went to", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);

      // The number is recorded, masked: identifiable to the person who typed it,
      // and not a phone number sitting in a ledger row.
      assert.equal(deposit.msisdn_masked, "2547****678");
      assert.ok(
        !JSON.stringify(deposit).includes("254712345678"),
        "the unmasked number must not reach the deposit record"
      );

      // ResultCode 9999 with this sentence is what the live sandbox returned on
      // 2026-10-18: the push was accepted, and the prompt never reached a phone.
      const res = await fire(
        h,
        TOKEN,
        callbackFor("ws_CO_FIXTURE_1", { resultCode: 9999, desc: "Error occurred while sending push request." })
      );
      assert.equal(res.ResultCode, 0, "Daraja is acknowledged either way");
      assert.equal(deposit.status, "failed");
      assert.equal(deposit.mpesa_result_code, 9999);
      assert.equal(
        deposit.failure_reason,
        "Error occurred while sending push request.",
        "the provider's own sentence is kept verbatim, not rewritten into a guess"
      );
      assert.equal(h.user.real_balance, 0, "nothing was credited");
      assert.equal(h.db.transactions.length, 0);

      // The status a client polls carries the masked number and what to do next.
      const status = await h.routes.depositStatus({
        req: { headers: { authorization: "Bearer token_alice" } },
        params: { reference: deposit.reference },
      });
      assert.equal(status.deposit.msisdn_masked, "2547****678");
      assert.match(status.deposit.failure_hint, /could not deliver the prompt/);
      assert.ok(
        !JSON.stringify(status).includes("254712345678"),
        "no response may carry the number in full"
      );
    } finally {
      h.restore();
    }
  });

  test("a late non-zero result cannot un-pay a deposit that already settled", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);

      // The customer pays, and it settles.
      await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { amount: 1300, receipt: "MPESA_RCPT_FIXTURE_1" }));
      assert.equal(deposit.status, "completed");
      assert.equal(h.user.real_balance, 10);

      // Then a NON-ZERO result for the same checkout id arrives. Safaricom does
      // this: a push that times out on the handset can report after the payment
      // it is describing has already been credited.
      const late = await fire(
        h,
        TOKEN,
        callbackFor("ws_CO_FIXTURE_1", { resultCode: 1037, desc: "DS timeout user cannot be reached." })
      );
      assert.equal(late.ResultCode, 0, "still acknowledged, so Safaricom stops retrying");

      assert.equal(deposit.status, "completed", "a settled deposit must not be flipped to failed");
      assert.equal(deposit.failure_reason, null, "and must not acquire a failure reason");
      assert.equal(h.user.real_balance, 10, "credited money stays credited");
      assert.equal(h.db.transactions.length, 1, "and no second ledger entry appears");
      assert.equal(
        h.db.mpesa_callbacks[0].outcome,
        "ignored_after_settlement",
        "the contradiction is recorded for reconciliation rather than acted on"
      );
    } finally {
      h.restore();
    }
  });

  test("a late non-zero result still fails a deposit that is genuinely pending", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);
      await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { resultCode: 1037, desc: "DS timeout user cannot be reached." }));
      assert.equal(deposit.status, "failed", "the guard must not stop a real failure");
      assert.equal(deposit.mpesa_result_code, 1037);
      assert.equal(h.db.mpesa_callbacks[0].outcome, "not_paid");
    } finally {
      h.restore();
    }
  });

  test("an underpaid result is refused rather than credited", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);
      const res = await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { amount: 100, receipt: "MPESA_RCPT_SHORT" }));
      assert.equal(res.ResultCode, 0, "we still acknowledge, so Safaricom stops retrying");
      assert.equal(h.user.real_balance, 0, "100 KES cannot settle a 1300 KES deposit");
      assert.equal(deposit.status, "pending", "and it stays open for reconciliation");
      assert.equal(h.db.mpesa_callbacks[0].outcome, "settlement_refused");
    } finally {
      h.restore();
    }
  });

  test("a result with no receipt is not treated as a payment", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const deposit = await pending(h);
      await fire(h, TOKEN, callbackFor("ws_CO_FIXTURE_1", { amount: 1300 }));
      assert.equal(deposit.status, "pending");
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.mpesa_callbacks[0].outcome, "missing_metadata");
    } finally {
      h.restore();
    }
  });

  test("a checkout id this server never issued creates nothing", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const res = await fire(h, TOKEN, callbackFor("ws_CO_SOMEONE_ELSE", { amount: 5000, receipt: "MPESA_RCPT_FORGED" }));
      assert.equal(res.ResultCode, 0);
      assert.equal(h.db.deposits.length, 0, "no deposit may be conjured from a callback");
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.mpesa_callbacks[0].outcome, "unknown_checkout");
    } finally {
      h.restore();
    }
  });

  test("the wrong callback token is refused", async () => {
    const h = harness({ env: CALLBACK_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      await pending(h);
      const err = await fire(h, "not-the-token", callbackFor("ws_CO_FIXTURE_1", { amount: 1300, receipt: "MPESA_RCPT_FIXTURE_1" }));
      assert.equal(err.status, 403);
      assert.equal(err.code, "FORBIDDEN");
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.mpesa_callbacks.length, 0, "an unauthenticated post is not even recorded");
    } finally {
      h.restore();
    }
  });

  test("without a callback token the route refuses instead of accepting anonymous posts", async () => {
    // The callback cannot require a Bearer token, so the URL secret is the only
    // thing standing between it and anyone on the internet.
    const h = harness({ env: PROVIDER_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      const err = await fire(h, "anything", callbackFor("ws_CO_FIXTURE_1", { amount: 1300, receipt: "R" }));
      assert.equal(err.status, 503);
      assert.equal(err.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
      assert.deepEqual(err.extra.required_env, ["DARAJA_CALLBACK_TOKEN"]);
      assert.equal(h.user.real_balance, 0);
    } finally {
      h.restore();
    }
  });
});

describe("settlement integrity", () => {
  test("6. a verified fixture settles and credits exactly once", async () => {
    const h = harness();
    const deposit = seedDeposit(h.db, h.user.id, { amount: 10 });
    const result = await h.routes._settleDeposit({
      reference: deposit.reference,
      providerReference: "MPESA_RCPT_FIXTURE_1",
      verifiedAmount: 10,
      currency: "KES",
    });
    assert.equal(result.credited, true);
    assert.equal(deposit.status, "completed");
    assert.equal(h.user.real_balance, 10);
    assert.equal(h.db.transactions.length, 1);
    assert.equal(h.db.transactions[0].type, "deposit");
  });

  test("7. replaying the same settlement does not credit twice", async () => {
    const h = harness();
    const deposit = seedDeposit(h.db, h.user.id, { amount: 10 });
    const args = { reference: deposit.reference, providerReference: "MPESA_RCPT_FIXTURE_2", verifiedAmount: 10, currency: "KES" };
    const first = await h.routes._settleDeposit(args);
    const second = await h.routes._settleDeposit(args);
    assert.equal(first.credited, true);
    assert.equal(second.credited, false);
    assert.equal(second.reason, "already_settled");
    assert.equal(h.user.real_balance, 10, "credited once only");
    assert.equal(h.db.transactions.length, 1);
  });

  test("8. ten concurrent settlements of one fixture credit exactly once", async () => {
    const h = harness();
    const deposit = seedDeposit(h.db, h.user.id, { amount: 50 });
    const args = { reference: deposit.reference, providerReference: "MPESA_RCPT_FIXTURE_3", verifiedAmount: 50, currency: "KES" };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => h.routes._settleDeposit(args).catch((e) => ({ error: e.code || e.message })))
    );
    const credited = results.filter((r) => r.credited === true).length;
    assert.equal(credited, 1, "exactly one of ten concurrent settlements may credit");
    assert.equal(h.user.real_balance, 50);
    assert.equal(h.db.transactions.length, 1);
  });

  test("9. a failed or cancelled deposit cannot be settled", async () => {
    const h = harness();
    for (const status of ["failed", "cancelled"]) {
      const deposit = seedDeposit(h.db, h.user.id, { status });
      await assert.rejects(
        () => h.routes._settleDeposit({ reference: deposit.reference, providerReference: "X", verifiedAmount: 10, currency: "KES" }),
        (e) => e.status === 409 && e.code === "CONFLICT"
      );
    }
    assert.equal(h.user.real_balance, 0);
  });

  test("14. an unverified settlement is refused", async () => {
    const h = harness();
    const noProviderRef = seedDeposit(h.db, h.user.id);
    await assert.rejects(
      () => h.routes._settleDeposit({ reference: noProviderRef.reference, verifiedAmount: 10, currency: "KES" }),
      (e) => e.status === 400
    );
    const noAmount = seedDeposit(h.db, h.user.id);
    await assert.rejects(
      () => h.routes._settleDeposit({ reference: noAmount.reference, providerReference: "X" }),
      (e) => e.status === 400 && /Verified amount is required/.test(e.message)
    );
    // a verified amount lower than the deposit is also refused
    const underpaid = seedDeposit(h.db, h.user.id, { amount: 100 });
    await assert.rejects(
      () => h.routes._settleDeposit({ reference: underpaid.reference, providerReference: "X", verifiedAmount: 5, currency: "KES" }),
      (e) => e.status === 400 && /less than the deposit/.test(e.message)
    );
    assert.equal(h.user.real_balance, 0, "nothing credited in any of these cases");
  });

  test("15. a persist failure rolls the settlement back", async () => {
    const h = harness();
    const deposit = seedDeposit(h.db, h.user.id, { amount: 75 });
    h.failPersist = true;
    await assert.rejects(
      () => h.routes._settleDeposit({ reference: deposit.reference, providerReference: "FIXTURE_ROLLBACK", verifiedAmount: 75, currency: "KES" }),
      (e) => e.status === 500 && e.code === "SETTLEMENT_FAILED"
    );
    assert.equal(deposit.status, "pending", "deposit must not stay completed");
    assert.equal(h.user.real_balance, 0, "balance must not be credited");
    assert.equal(h.db.transactions.length, 0, "no orphan ledger entry");
    // and it can still settle cleanly once the write succeeds
    h.failPersist = false;
    const retry = await h.routes._settleDeposit({ reference: deposit.reference, providerReference: "FIXTURE_ROLLBACK", verifiedAmount: 75, currency: "KES" });
    assert.equal(retry.credited, true);
    assert.equal(h.user.real_balance, 75);
  });

  test("an unknown reference is a 404", async () => {
    const h = harness();
    await assert.rejects(
      () => h.routes._settleDeposit({ reference: "PAL_nope", providerReference: "X", verifiedAmount: 1, currency: "KES" }),
      (e) => e.status === 404
    );
  });
});

describe("exchange rate provider", () => {
  let fixture;
  let mode = "good";

  before(async () => {
    fixture = http.createServer((req, res) => {
      if (mode === "good") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          result: "success", base_code: "USD", provider: "fixture-provider",
          time_last_update_utc: "Wed, 14 Oct 2026 00:00:00 +0000",
          rates: { USD: 1, KES: 129.5 },
        }));
      }
      if (mode === "malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{ not json at all");
      }
      if (mode === "nocurrency") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ result: "success", base_code: "USD", rates: { USD: 1, EUR: 0.9 } }));
      }
      if (mode === "rejected") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ result: "error", "error-type": "quota" }));
      }
      res.writeHead(500);
      res.end("boom");
    });
    await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  });

  after(() => fixture.close());

  const url = () => `http://127.0.0.1:${fixture.address().port}/latest/USD`;
  const service = () => createExchangeRateService({ url: url(), ttlMs: 60_000, timeoutMs: 2000 });

  test("returns a validated rate with source and timestamp", async () => {
    mode = "good";
    const rate = await service().get();
    assert.equal(rate.rate, 129.5);
    assert.equal(rate.pair, "USD/KES");
    assert.equal(rate.provider, "fixture-provider");
    assert.ok(rate.asOf, "must expose an update timestamp");
    assert.equal(rate.cached, false);
  });

  test("caches within the TTL", async () => {
    mode = "good";
    const svc = service();
    const first = await svc.get();
    mode = "500";
    const second = await svc.get(); // still cached, provider not re-consulted
    assert.equal(second.cached, true);
    assert.equal(second.rate, first.rate);
  });

  test("12. a malformed provider response is rejected, not guessed", async () => {
    mode = "malformed";
    await assert.rejects(() => service().get(), (e) => e.status === 503 && e.code === "EXCHANGE_RATE_UNAVAILABLE");
  });

  test("12b. missing KES in the response is rejected", async () => {
    mode = "nocurrency";
    await assert.rejects(() => service().get(), (e) => e.status === 503 && /KES/.test(e.extra.reason));
  });

  test("12c. a provider-reported error is rejected", async () => {
    mode = "rejected";
    await assert.rejects(() => service().get(), (e) => e.status === 503);
  });

  test("11. a missing/unreachable provider fails loudly with no hardcoded fallback", async () => {
    const dead = createExchangeRateService({ url: "http://127.0.0.1:1/latest/USD", ttlMs: 1000, timeoutMs: 300 });
    await assert.rejects(
      () => dead.get(),
      (e) => e.status === 503 && e.code === "EXCHANGE_RATE_UNAVAILABLE" && !/129/.test(JSON.stringify(e.extra))
    );
  });

  test("stale cache is served with a warning rather than a fabricated rate", async () => {
    mode = "good";
    const svc = createExchangeRateService({ url: url(), ttlMs: 0, timeoutMs: 2000 });
    const fresh = await svc.get();
    mode = "500";
    const stale = await svc.get();
    assert.equal(stale.stale, true);
    assert.equal(stale.rate, fresh.rate);
    assert.match(stale.warning, /last known rate/);
  });

  test("ECB-style XML is parsed as an EUR base and derived to USD/KES", async () => {
    const xmlServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(`<Cube><Cube time='2026-10-14'><Cube currency='USD' rate='1.25'/><Cube currency='KES' rate='160.0'/></Cube></Cube>`);
    });
    await new Promise((r) => xmlServer.listen(0, "127.0.0.1", r));
    try {
      const svc = createExchangeRateService({ url: `http://127.0.0.1:${xmlServer.address().port}/`, ttlMs: 1000, timeoutMs: 2000 });
      const rate = await svc.get();
      assert.equal(rate.rate, 128); // 160 / 1.25
      assert.equal(rate.asOf, "2026-10-14");
    } finally {
      xmlServer.close();
    }
  });
});

describe("payment intent flow (fixture providers only)", () => {
  /** A STK Push fixture. Records what it was asked to charge. */
  function stkFixture(overrides = {}) {
    const calls = [];
    return {
      calls,
      darajaStkPush: async (request) => {
        calls.push(request);
        if (overrides.reject) throw new ApiError(400, "PROVIDER_REJECTED", "STK Push rejected by Daraja");
        if (overrides.hang) return new Promise(() => {});
        return { CheckoutRequestID: "ws_CO_FIXTURE_1", MerchantRequestID: "mr_FIXTURE_1" };
      },
    };
  }

  test("4b. a Daraja that refuses to authorise fails loudly and credits nothing", async () => {
    // Daraja is now a live integration, so with credentials present this server
    // really does call Safaricom. The stub stands in for Safaricom so the test
    // never leaves the machine, and it pins the failure path: no acknowledgement
    // is invented and no wallet is credited.
    const stub = http.createServer((req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorCode: "404.001.03", errorMessage: "Invalid Access Token" }));
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const h = harness({
      env: { ...PROVIDER_ENV, DARAJA_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
      exchange: rateFixture(130),
    });
    try {
      const err = await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" })).catch((e) => e);
      assert.equal(err.status, 502);
      assert.equal(err.code, "DARAJA_AUTH_FAILED");
      // The provider's own words come through; the credentials do not.
      assert.equal(err.extra.provider_message, "Invalid Access Token");
      assert.ok(!JSON.stringify(err.extra).includes("fixture-secret"), "credentials must never leak into an error");

      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.transactions.length, 0);
      // The intent is recorded before the provider is contacted, so the failure
      // leaves one auditable deposit — marked failed, never paid.
      assert.equal(h.db.deposits.length, 1);
      assert.equal(h.db.deposits[0].status, "failed");
      assert.equal(h.db.deposits[0].failure_reason, "DARAJA_AUTH_FAILED");
      assert.equal(h.db.deposits[0].provider_reference, null, "no provider reference was ever obtained");
    } finally {
      h.restore();
      stub.close();
    }
  });

  test("18. USD amounts and KES settlement are kept apart", async () => {
    const stk = stkFixture();
    const h = harness({ env: PROVIDER_ENV, providers: stk, exchange: rateFixture(130) });
    try {
      const result = await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" }));

      // What Daraja is asked to charge is KES, not the client's USD figure.
      assert.equal(stk.calls.length, 1);
      assert.equal(stk.calls[0].amount, 1300);
      assert.equal(stk.calls[0].currency, "KES");
      assert.equal(stk.calls[0].msisdn, "254712345678");

      // The deposit carries both figures, labelled.
      assert.equal(result.status, "pending");
      assert.equal(result.deposit.usd_amount, 10);
      assert.equal(result.deposit.currency, "USD");
      assert.equal(result.deposit.settlement_currency, "KES");
      assert.equal(result.deposit.settlement_amount, 1300);
      assert.equal(result.deposit.settlement_rate, 130);
      assert.equal(result.deposit.provider_reference, "ws_CO_FIXTURE_1");

      // Accepted is not paid.
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.transactions.length, 0);

      // Settling in KES credits the USD figure, not the KES one.
      const deposit = h.db.deposits[0];
      const settled = await h.routes._settleDeposit({
        reference: deposit.reference,
        providerReference: "MPESA_RCPT_FIXTURE_1",
        verifiedAmount: 1300,
        currency: "KES",
      });
      assert.equal(settled.credited, true);
      assert.equal(h.user.real_balance, 10, "1300 KES must credit 10 USD, never 1300");
    } finally {
      h.restore();
    }
  });

  test("a settlement in the wrong currency is refused", async () => {
    const h = harness({ env: PROVIDER_ENV, providers: stkFixture(), exchange: rateFixture(130) });
    try {
      await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" }));
      const deposit = h.db.deposits[0];
      await assert.rejects(
        () => h.routes._settleDeposit({ reference: deposit.reference, providerReference: "X", verifiedAmount: 1300, currency: "USD" }),
        (e) => e.status === 400 && /currency does not match/.test(e.message)
      );
      assert.equal(h.user.real_balance, 0);
    } finally {
      h.restore();
    }
  });

  test("19. a provider rejection fails the intent and credits nothing", async () => {
    const stk = stkFixture({ reject: true });
    const h = harness({ env: PROVIDER_ENV, providers: stk, exchange: rateFixture(130) });
    try {
      const err = await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" })).catch((e) => e);
      assert.equal(err.code, "PROVIDER_REJECTED");
      assert.equal(h.db.deposits[0].status, "failed");
      assert.equal(h.db.deposits[0].failure_reason, "PROVIDER_REJECTED");
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.transactions.length, 0);
    } finally {
      h.restore();
    }
  });

  test("20. a provider timeout stays pending, because we cannot tell what happened", async () => {
    const h = harness({
      env: { ...PROVIDER_ENV, DARAJA_TIMEOUT_MS: "25" },
      providers: stkFixture({ hang: true }),
      exchange: rateFixture(130),
    });
    try {
      const err = await h.routes.mpesaStkPush(h.ctx("token_alice", { amount: 10, phone: "0712345678" })).catch((e) => e);
      assert.equal(err.status, 504);
      assert.equal(err.code, "PROVIDER_TIMEOUT");
      // A timeout is not a failure — the charge may still land, so it must not be
      // marked failed, and it must certainly not be credited.
      assert.equal(h.db.deposits[0].status, "pending");
      assert.equal(h.db.deposits[0].failure_reason, "PROVIDER_TIMEOUT");
      assert.equal(h.user.real_balance, 0);
      assert.equal(h.db.transactions.length, 0);
    } finally {
      h.restore();
    }
  });

  test("21. a duplicate idempotency key replays instead of charging twice", async () => {
    const stk = stkFixture();
    const h = harness({ env: PROVIDER_ENV, providers: stk, exchange: rateFixture(130) });
    try {
      const body = { amount: 10, phone: "0712345678", idempotency_key: "key-abc" };
      const first = await h.routes.mpesaStkPush(h.ctx("token_alice", body));
      const second = await h.routes.mpesaStkPush(h.ctx("token_alice", body));
      assert.equal(second.replay, true);
      assert.equal(second.deposit.reference, first.deposit.reference);
      assert.equal(h.db.deposits.length, 1, "one intent, not two");
      assert.equal(stk.calls.length, 1, "the provider is not contacted twice");
    } finally {
      h.restore();
    }
  });

  test("16. both of the client's card body shapes are accepted", async () => {
    const seen = [];
    const providers = { cardCharge: async (req) => { seen.push(req); return { id: "pi_FIXTURE_1" }; } };

    for (const body of [
      // shape 1 — three call sites in the client's bundle
      { amount: 10, cardNumber: "4242 4242 4242 4242", cardExpiry: "12/30", cardCvv: "123", cardName: "Test User" },
      // shape 2 — the other card form in the bundle
      { amount: 10, cardNumber: "4242424242424242", expiryMonth: "3", expiryYear: "2030", cvv: "123", cardholderName: "Test User" },
      // shape 3 — nested, for plain API clients
      { amount: 10, card: { number: "4242424242424242", expiry: "12/30", cvc: "123", name: "Test User" } },
    ]) {
      const h = harness({ env: PROVIDER_ENV, providers, exchange: rateFixture(130) });
      try {
        const result = await h.routes.cardDeposit(h.ctx("token_alice", body));
        assert.equal(result.status, "pending");
        assert.equal(result.card.brand, "visa");
        assert.equal(result.card.last4, "4242");
        assert.equal(result.deposit.settlement_currency, "USD");
        assert.equal(result.deposit.settlement_amount, 10);
        assert.equal(result.deposit.provider_reference, "pi_FIXTURE_1");
        assert.equal(h.db.transactions.length, 0, "an intent is not a payment");
      } finally {
        h.restore();
      }
    }

    // The single-digit month in shape 2 was normalised before validation.
    assert.equal(seen.length, 3);
    assert.equal(seen[1].amount, 10);
  });

  test("17. no card deposit stores the PAN, CVC or expiry anywhere", async () => {
    const h = harness({ env: PROVIDER_ENV, providers: { cardCharge: async () => ({ id: "pi_FIXTURE_2" }) }, exchange: rateFixture(130) });
    try {
      const PAN = "4242424242424242";
      const HOLDER = "Test Trader";
      const result = await h.routes.cardDeposit(
        h.ctx("token_alice", { amount: 10, cardNumber: PAN, cardExpiry: "12/30", cardCvv: "123", cardName: HOLDER })
      );
      const persisted = JSON.stringify(h.db);
      const returned = JSON.stringify(result);

      // Distinctive strings only. Do NOT search for the 3-digit CVV: deposit
      // references and ids are random hex, so "123" turns up by chance and the
      // assertion fails at random.
      assert.ok(!persisted.includes(PAN), "the store must not contain the PAN");
      assert.ok(!persisted.includes(HOLDER), "the store must not contain the cardholder name");
      assert.ok(!returned.includes(PAN), "the response must not echo the PAN");
      assert.ok(returned.includes("4242"), "last4 is the only card detail kept");

      // Structural, and stricter than a substring search: the deposit must not
      // carry a card field at all, whatever its value.
      const deposit = h.db.deposits[0];
      for (const field of ["card", "number", "cardNumber", "cvv", "cvc", "cardCvv", "expiry", "cardExpiry", "name", "cardName"]) {
        assert.ok(!(field in deposit), `the deposit must not carry a "${field}" field`);
      }
      assert.deepEqual(h.db.transactions, [], "an intent is not a payment");
    } finally {
      h.restore();
    }
  });

  test("22. a cached TRC20 address costs nothing and never consumes the rate limit", async () => {
    const h = harness({ env: PROVIDER_ENV });
    try {
      const address = "TFixtureDepositAddress0000000000000000";
      h.db.trc20_addresses[h.user.id] = { address, asset: "USDT", network: "TRC20" };
      for (let i = 0; i < 25; i++) {
        const got = await h.routes.trc20Address(h.ctx("token_alice"));
        assert.equal(got.address, address, "the same address is returned every time");
        assert.equal(got.cached, true);
      }
    } finally {
      h.restore();
    }
  });

  test("23. concurrent address requests share one allocation", async () => {
    let calls = 0;
    const h = harness({
      env: PROVIDER_ENV,
      providers: {
        tronDepositAddress: async () => {
          calls += 1;
          await new Promise((r) => setTimeout(r, 25));
          return { address: "TFixtureAllocated0000000000000000000", network: "TRC20" };
        },
      },
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => h.routes.trc20Address(h.ctx("token_alice")))
      );
      assert.equal(calls, 1, "five concurrent callers must produce one provider call");
      assert.equal(new Set(results.map((r) => r.address)).size, 1, "and one address");
      assert.equal(Object.keys(h.db.trc20_addresses).length, 1);
    } finally {
      h.restore();
    }
  });

  test("the TRC20 allocation is per account, never shared across users", async () => {
    let n = 0;
    const h = harness({
      env: PROVIDER_ENV,
      providers: { tronDepositAddress: async () => ({ address: `TFixtureAddress${++n}`, network: "TRC20" }) },
    });
    try {
      const alice = await h.routes.trc20Address(h.ctx("token_alice"));
      const bob = await h.routes.trc20Address(h.ctx("token_bob"));
      assert.notEqual(alice.address, bob.address);
      assert.equal(Object.keys(h.db.trc20_addresses).length, 2);
    } finally {
      h.restore();
    }
  });
});

describe("HTTP surface", () => {
  let stub;
  let child;
  let base;
  let childErrors = "";

  before(async () => {
    // A stand-in exchange-rate feed, for the same reason the end-to-end suite
    // below has one: this server is spawned, so without a stub the
    // /api/auth/exchange-rate assertion below dials open.er-api.com over the
    // public internet, and a blip there fails the suite while the server is
    // behaving exactly as documented — it answers 503
    // EXCHANGE_RATE_UNAVAILABLE rather than inventing a rate. Measured: one full
    // run in five went red with `503 !== 200`, and pointing
    // EXCHANGE_RATE_API_URL at a closed port reproduces it every time.
    stub = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ result: "success", base_code: "USD", rates: { USD: 1, KES: 130 }, time_last_update_utc: "Wed, 14 Oct 2026 00:00:00 +0000" })
      );
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;

    // PORT=0: the OS picks a free port and the server reports it, so a leftover
    // process from an earlier run can never collide with this one.
    child = spawn(process.execPath, ["tools/server.mjs", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: serverEnv({ EXCHANGE_RATE_API_URL: `${stubUrl}/latest/USD` }),
    });
    child.stderr.on("data", (buf) => { childErrors += buf.toString(); });

    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server never reported a port")), 15_000);
      let out = "";
      child.stdout.on("data", (buf) => {
        out += buf.toString();
        const match = out.match(/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.on("error", reject);
    });
  });

  after(() => {
    if (child) child.kill();
    if (stub) stub.close();
    if (/Error|EADDRINUSE/.test(childErrors)) {
      throw new Error(`the server wrote to stderr:\n${childErrors}`);
    }
  });

  const post = (path, body, token) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });

  test("every /api response is JSON, including errors", async () => {
    const res = await fetch(`${base}/api/auth/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type"), /application\/json/);
    const body = await res.json();
    assert.equal(body.code, "UNKNOWN_ROUTE");
  });

  test("the four previously-404ing routes are real handlers now", async () => {
    const token = (await (await post("/api/auth/demo", {})).json()).token;

    // No token: this is exactly how the mirrored client calls it. The status is
    // asserted strictly because the feed behind it is the stub above, so a 503
    // here means this server could not read a rate it was handed, not that the
    // internet was busy.
    const rate = await fetch(`${base}/api/auth/exchange-rate`);
    assert.equal(rate.status, 200, "exchange-rate must not 404, and must not demand a token");
    const rateBody = await rate.json();
    assert.equal(rateBody.pair, "USD/KES", "the stubbed feed publishes KES, so a rate is served");
    assert.equal(rateBody.rate, 130, "and it is the rate the feed gave, not a hardcoded one");
    assert.ok(rateBody.source, "the rate names its source");
    assert.ok(rateBody.updated_at, "and when it was updated");

    const mpesa = await post("/api/auth/mpesa/stk-push", { amount: 10, phone: "0712345678" }, token);
    assert.notEqual(mpesa.status, 404, "mpesa route must exist");
    assert.equal(mpesa.status, 503);

    const card = await post("/api/auth/card/deposit", { amount: 10, card: { number: "4242424242424242", expiry: "12/30", cvc: "123", name: "T U" } }, token);
    assert.notEqual(card.status, 404);
    assert.equal(card.status, 503);

    // TRC20 is a real handler too, but this server was started without naming a
    // wallet — and a deployment that names no wallet must not fall back to the
    // built-in demo address. It answers the honest 503 instead. That the route
    // does serve an address when one is configured is pinned by "a configured
    // wallet is served verbatim" above; this asserts the unconfigured case.
    const trc20 = await fetch(`${base}/api/auth/trc20/my-address`, { headers: { authorization: `Bearer ${token}` } });
    assert.notEqual(trc20.status, 404);
    assert.equal(trc20.status, 503, "no wallet named, so no wallet is shown");
    const trc20Body = await trc20.json();
    assert.equal(trc20Body.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
    assert.equal(JSON.stringify(trc20Body).includes("TY6nEvWDneE8XuTj7ua8s1dSXdo7dkZWXW"), false, "the demo address never leaks");
  });

  test("no endpoint returns 200 with a fake payment success", async () => {
    const token = (await (await post("/api/auth/demo", {})).json()).token;
    for (const [path, body] of [
      ["/api/auth/mpesa/stk-push", { amount: 10, phone: "0712345678" }],
      ["/api/auth/card/deposit", { amount: 10, card: { number: "4242424242424242", expiry: "12/30", cvc: "123", name: "T U" } }],
    ]) {
      const res = await post(path, body, token);
      const parsed = await res.json();
      assert.notEqual(parsed.status, "completed", `${path} must not claim completion`);
      assert.notEqual(parsed.status, "success");
    }
  });

  test("inputs are rejected before any provider is consulted", async () => {
    const token = (await (await post("/api/auth/demo", {})).json()).token;
    assert.equal((await post("/api/auth/mpesa/stk-push", { amount: 0.1, phone: "0712345678" }, token)).status, 400);
    assert.equal((await post("/api/auth/mpesa/stk-push", { amount: 10, phone: "nope" }, token)).status, 400);
    assert.equal((await post("/api/auth/mpesa/stk-push", { amount: 10, phone: "0712345678" }, null)).status, 401);
  });
});

/**
 * Trading engine tests.
 *
 * These run the real server over a real WebSocket and drive the exact frames
 * the mirrored client sends — captured from its own bundle, not invented here.
 * The market is random noise, so nothing asserts a specific win or loss; the
 * invariants checked are the ones that must hold whatever the price does.
 */
describe("trading engine and auto-trading bot", () => {
  let child;
  let base;
  let port;
  let childErrors = "";
  let token;
  const sockets = [];

  before(async () => {
    child = spawn(process.execPath, ["tools/server.mjs", "0"], { stdio: ["ignore", "pipe", "pipe"], env: serverEnv() });
    child.stderr.on("data", (buf) => { childErrors += buf.toString(); });

    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server never reported a port")), 15_000);
      let out = "";
      child.stdout.on("data", (buf) => {
        out += buf.toString();
        const match = out.match(/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); port = Number(match[1]); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.on("error", reject);
    });

    token = (await (await fetch(`${base}/api/auth/demo`, { method: "POST" })).json()).token;
  });

  after(() => {
    for (const ws of sockets) ws.close();
    if (child) child.kill();
    if (/EADDRINUSE/.test(childErrors)) throw new Error(`the server wrote to stderr:\n${childErrors}`);
  });

  /** Opens a socket and authenticates it, collecting every frame it receives. */
  async function trader(tok = token) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames = [];
    ws.addEventListener("message", (e) => { try { frames.push(JSON.parse(e.data)); } catch { /* ignore */ } });
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
      setTimeout(() => reject(new Error("the socket never opened")), 5000);
    });
    const send = (msg) => ws.send(JSON.stringify(msg));
    send({ type: "auth", token: tok });
    await waitFor(frames, (f) => f.type === "auth_success", 3000, "auth_success");
    return { ws, frames, send };
  }

  // Newest-first, so an earlier reply of the same type is never mistaken for the
  // answer to the request just sent. Reads the live array, never a copy of it.
  async function waitFor(frames, pred, ms, label, from = 0) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (let i = frames.length - 1; i >= from; i--) if (pred(frames[i])) return frames[i];
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${label}; saw ${[...new Set(frames.map((f) => f.type))].join(", ")}`);
  }

  const BOT_CONFIG = { asset: "volatility_10_1s", direction: "even", isDemo: true, lossMultiple: 3, stake: 5, targetProfit: 200, targetLoss: 999 };

  test("23. the bot opens real positions and its session P/L is the running sum of settled trades", async () => {
    const t = await trader();
    t.send({ type: "auto_trading_start", config: { ...BOT_CONFIG, ticks: 1 } });

    const started = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session, 3000, "the start acknowledgement");
    assert.equal(started.session.active, true);
    assert.equal(started.session.sessionPL, 0, "a fresh session starts at zero");
    assert.equal(started.session.lossMultiple, 3, "the requested risk is echoed back");

    // Drive several trades and check the accounting on every settlement: the
    // stake doubles-or-resets by the martingale rule and the P/L is a true sum.
    const settled = [];
    const deadline = Date.now() + 25_000;
    while (settled.length < 4 && Date.now() < deadline) {
      let sum = 0;
      for (const s of settled) sum += s.lastResult.profitLoss;
      const extra = t.frames.filter((f) => f.type === "auto_trading_update" && f.data.lastResult).slice(settled.length)[0];
      if (!extra) { await new Promise((r) => setTimeout(r, 100)); continue; }
      const s = extra.data;
      assert.equal(s.tradesCount, settled.length + 1, "each settlement books exactly one trade");
      assert.equal(s.winsCount + s.lossesCount, s.tradesCount, "wins and losses partition the trades");
      assert.equal(s.sessionPL, Number((sum + s.lastResult.profitLoss).toFixed(2)), "session P/L is the running sum");
      assert.ok(["won", "lost"].includes(s.lastResult.status), "the trade settled won or lost");
      settled.push(s);
    }
    assert.ok(settled.length >= 4, `expected at least four settled trades, saw ${settled.length}`);

    // The stake charged for each trade must follow the previous result.
    let previousStake = BOT_CONFIG.stake;
    for (const s of settled) {
      const expected = s.lastResult.status === "won" ? BOT_CONFIG.stake : previousStake * BOT_CONFIG.lossMultiple;
      assert.equal(s.currentStake, expected, `stake after a ${s.lastResult.status} settlement`);
      previousStake = s.currentStake;
    }

    // The stake it claims to be about to risk is the stake the next trade opens with.
    const opens = t.frames.filter((f) => f.type === "position_update" && f.action === "add" && f.data.auto === true).map((f) => f.data);
    assert.ok(opens.length >= 4, `the bot must open a position per trade, saw ${opens.length}`);
    assert.equal(opens[3].stake, settled[2].currentStake, "the next trade is opened with the resized stake");
    assert.match(opens[0].id, /^pos_/, "positions are real ledger entries");

    t.send({ type: "auto_trading_status" });
    const live = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.tradesCount === settled.length, 3000, "the live session");
    assert.equal(live.session.sessionPL, settled[settled.length - 1].sessionPL, "status reports the session in progress");

    t.send({ type: "auto_trading_stop" });
    const stopped = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.stopReason === "stopped_by_user", 3000, "the stop acknowledgement");
    assert.equal(stopped.session.active, false);
  });

  test("24. stopping opens no further trades but still books the one already in flight", async () => {
    const t = await trader();
    t.send({ type: "auto_trading_start", config: { ...BOT_CONFIG, ticks: 2 } });
    await waitFor(t.frames, (f) => f.type === "position_update" && f.action === "add" && f.data.auto === true, 5000, "the first position");

    t.send({ type: "auto_trading_stop" });
    const stopped = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.stopReason === "stopped_by_user", 3000, "the stop acknowledgement");
    const opensAtStop = t.frames.filter((f) => f.type === "position_update" && f.action === "add" && f.data.auto === true).length;

    await new Promise((r) => setTimeout(r, 6000));
    const opensAfter = t.frames.filter((f) => f.type === "position_update" && f.action === "add" && f.data.auto === true).length;
    assert.equal(opensAfter, opensAtStop, "a stopped bot must not open another trade");

    // The in-flight trade had already staked real money. Dropping it from the
    // totals would understate what the session actually won or lost.
    const last = t.frames.filter((f) => f.type === "auto_trading_update").at(-1).data;
    assert.equal(last.active, false, "every update after the stop still reports inactive");
    assert.equal(last.stopReason, "stopped_by_user");
    assert.equal(last.tradesCount, stopped.session.tradesCount + 1, "the in-flight trade is booked exactly once");
    assert.equal(last.winsCount + last.lossesCount, last.tradesCount);
  });

  test("25. a reconnect restores the running session instead of losing it", async () => {
    const t = await trader();
    t.send({ type: "auto_trading_start", config: { ...BOT_CONFIG, ticks: 5 } });
    const started = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session, 3000, "the start acknowledgement");
    const again = await trader();
    const restored = again.frames.find((f) => f.type === "auth_success");
    assert.equal(restored.data.autoTrading.active, true, "auth_success carries the live session");
    assert.equal(restored.data.autoTrading.startedAt, started.session.startedAt, "it is the same session, not a new one");

    again.send({ type: "auto_trading_status" });
    const status = await waitFor(again.frames, (f) => f.type === "auto_trading_response" && f.session, 3000, "the status reply");
    assert.equal(status.session.startedAt, started.session.startedAt);

    t.send({ type: "auto_trading_stop" });
    await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.active === false, 3000, "the stop acknowledgement");
  });

  test("26. manual trades share the engine, so the stake is debited and refusals are coded", async () => {
    const t = await trader();
    const before = t.frames.find((f) => f.type === "auth_success").data.demo_balance;

    t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", trade_type: "even_odd", direction: "odd", stake: 5, ticks: 2 } });
    const opened = await waitFor(t.frames, (f) => f.type === "position_update" && f.action === "add", 3000, "the manual position");
    assert.equal(opened.data.stake, 5);
    assert.equal(opened.data.direction, "odd");
    assert.equal(opened.data.potential_payout, 9.76, "a $5 even/odd stake pays 1.9522x, the panel's 95.22%");
    assert.notEqual(opened.data.auto, true, "a manual trade is not a bot trade");
    await waitFor(t.frames, (f) => f.type === "balance_update" && f.data.demo_balance === before - 5, 3000, "the debited balance");

    t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", stake: 1e9 } });
    const refused = await waitFor(t.frames, (f) => f.type === "trade_error", 3000, "the refusal");
    assert.equal(refused.data.code, "INSUFFICIENT_BALANCE");

    t.send({ type: "manual_trade", config: { asset: "not-a-real-market", stake: 5 } });
    const unknown = await waitFor(t.frames, (f) => f.type === "trade_error" && f.data.code === "UNKNOWN_ASSET", 3000, "the unknown-asset refusal");
    assert.match(unknown.data.message, /not-a-real-market/);
  });

  // The client sends no contract type — only `direction`, plus `selectedDigit`
  // for the digit contracts. Deriving the type from the direction is what stops
  // an "over 5" trade being booked as even/odd and losing every single time.
  test("27. a digit contract is recognised from the direction, and priced like the panel says", async () => {
    const t = await trader();
    const cases = [
      [{ direction: "over", selectedDigit: 5 }, { trade_type: "over_under", target_digit: 5, potential_payout: 23.75 }],
      [{ direction: "under", selectedDigit: 5 }, { trade_type: "over_under", target_digit: 5, potential_payout: 19 }],
      [{ direction: "over", selectedDigit: 7 }, { trade_type: "over_under", target_digit: 7, potential_payout: 47.5 }],
      [{ direction: "over", selectedDigit: 8 }, { trade_type: "over_under", target_digit: 8, potential_payout: 95 }],
      [{ direction: "match", selectedDigit: 3 }, { trade_type: "match_differ", target_digit: 3, potential_payout: 95 }],
      [{ direction: "differ", selectedDigit: 3 }, { trade_type: "match_differ", target_digit: 3, potential_payout: 10.56 }],
      [{ direction: "even" }, { trade_type: "even_odd", target_digit: null, potential_payout: 19.52 }],
      [{ direction: "odd" }, { trade_type: "even_odd", target_digit: null, potential_payout: 19.52 }],
    ];

    for (const [config, expected] of cases) {
      const seen = t.frames.length;
      t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", stake: 10, ticks: 1, ...config } });
      const opened = await waitFor(t.frames, (f) => f.type === "position_update" && f.action === "add", 3000, `a position for ${JSON.stringify(config)}`, seen);
      for (const [field, value] of Object.entries(expected)) {
        assert.equal(opened.data[field], value, `${config.direction} ${config.selectedDigit ?? ""}: ${field}`);
      }
      // and it must settle by the rule that contract actually uses
      const closed = await waitFor(t.frames, (f) => f.type === "position_update" && f.action === "close" && f.data.id === opened.data.id, 6000, "the settlement");
      const p = closed.data;
      const won =
        p.trade_type === "over_under" ? (p.direction === "over" ? p.exit_digit > p.target_digit : p.exit_digit < p.target_digit)
        : p.trade_type === "match_differ" ? (p.direction === "match" ? p.exit_digit === p.target_digit : p.exit_digit !== p.target_digit)
        : p.direction === (p.exit_digit % 2 === 0 ? "even" : "odd");
      assert.equal(p.status, won ? "won" : "lost", `${p.trade_type}/${p.direction} must be settled by its own rule (digit ${p.exit_digit} vs ${p.target_digit})`);
      assert.equal(p.profit_loss, Number((won ? p.potential_payout - p.stake : -p.stake).toFixed(2)), "the P/L must follow the recorded payout");
    }
  });

  test("28. a contract that could never win is refused instead of taken", async () => {
    const t = await trader();
    // The client blocks both of these; the server must not accept them either.
    let seen = t.frames.length;
    t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", stake: 10, direction: "over", selectedDigit: 9 } });
    const over9 = await waitFor(t.frames, (f) => f.type === "trade_error" && f.data.code === "IMPOSSIBLE_SIDE", 3000, "the over-9 refusal", seen);
    assert.match(over9.data.message, /no winning digits/);

    seen = t.frames.length;
    t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", stake: 10, direction: "under", selectedDigit: 0 } });
    await waitFor(t.frames, (f) => f.type === "trade_error" && f.data.code === "IMPOSSIBLE_SIDE", 3000, "the under-0 refusal", seen);

    seen = t.frames.length;
    t.send({ type: "manual_trade", config: { asset: "volatility_10_1s", stake: 10, direction: "match" } });
    const noDigit = await waitFor(t.frames, (f) => f.type === "trade_error" && f.data.code === "INVALID_TARGET_DIGIT", 3000, "the missing-digit refusal", seen);
    assert.match(noDigit.data.message, /digit from 0 to 9/);

    // A fresh account, so "not running" cannot be confused with the stopped
    // session an earlier test legitimately left behind for the same user.
    const fresh = (await (await fetch(`${base}/api/auth/demo`, { method: "POST" })).json()).token;
    const alone = await trader(fresh);
    seen = alone.frames.length;
    alone.send({ type: "auto_trading_start", config: { asset: "volatility_10_1s", direction: "over", selectedDigit: 9, stake: 5 } });
    await waitFor(alone.frames, (f) => f.type === "trade_error" && f.data.code === "IMPOSSIBLE_SIDE", 3000, "the bot's refusal", seen);

    alone.send({ type: "auto_trading_status" });
    const status = await waitFor(alone.frames, (f) => f.type === "auto_trading_response", 3000, "the status reply", seen);
    assert.equal(status.session, null, "a refused bot must never start");

    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(alone.frames.filter((f) => f.type === "position_update" && f.action === "add").length, 0, "a refused bot must not open a trade");
  });

  test("29. a stopped session is remembered, because the panel shows it as the last session", async () => {
    const t = await trader();
    t.send({ type: "auto_trading_start", config: { ...BOT_CONFIG, ticks: 5 } });
    await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.active === true, 3000, "the start acknowledgement");
    t.send({ type: "auto_trading_stop" });
    const stopped = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.active === false, 3000, "the stop acknowledgement");

    t.send({ type: "auto_trading_status" });
    const again = await waitFor(t.frames, (f) => f.type === "auto_trading_response" && f.session?.active === false, 3000, "the status reply");
    assert.equal(again.session.startedAt, stopped.session.startedAt, "the same finished session comes back");
    assert.equal(again.session.stopReason, "stopped_by_user");

    // Reconnecting must show the same finished session, not a blank panel.
    const other = await trader();
    assert.equal(other.frames.find((f) => f.type === "auth_success").data.autoTrading.startedAt, stopped.session.startedAt);
  });
});

/* ------------------ M-Pesa through the real HTTP server ------------------ */

describe("M-Pesa end to end, through the real server process", () => {
  let stub;
  let child;
  let base;
  let stderr = "";
  let lastPush = null;

  before(async () => {
    // A stand-in Safaricom (auth, prompt, rate feed): this drives the real
    // server binary, its real router and its real callback URL, with no
    // outbound call anywhere.
    stub = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const send = (payload) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url.startsWith("/oauth/v1/generate")) return send({ access_token: "AT_e2e", expires_in: 3599 });
      if (req.url.startsWith("/latest/USD")) {
        return send({ result: "success", base_code: "USD", rates: { USD: 1, KES: 130 }, time_last_update_utc: "Wed, 14 Oct 2026 00:00:00 +0000" });
      }
      if (req.url === "/mpesa/stkpush/v1/processrequest") {
        lastPush = JSON.parse(raw);
        return send({ MerchantRequestID: "mr_e2e", CheckoutRequestID: "ws_CO_E2E", ResponseCode: "0", CustomerMessage: "Success. Request accepted for processing" });
      }
      return send({});
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const stubUrl = `http://127.0.0.1:${stub.address().port}`;

    child = spawn(process.execPath, ["tools/server.mjs", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: serverEnv({
        DARAJA_CONSUMER_KEY: "e2e-key",
        DARAJA_CONSUMER_SECRET: "e2e-secret",
        DARAJA_SHORTCODE: "174379",
        DARAJA_PASSKEY: "e2e-passkey",
        DARAJA_TRANSACTION_TYPE: "buygoods",
        DARAJA_PARTY_B: "880100",
        DARAJA_CALLBACK_TOKEN: "e2e-token",
        DARAJA_CALLBACK_URL: `${stubUrl}/api/auth/mpesa/callback/e2e-token`,
        DARAJA_BASE_URL: stubUrl,
        EXCHANGE_RATE_API_URL: `${stubUrl}/latest/USD`,
      }),
    });
    child.stderr.on("data", (b) => { stderr += b.toString(); });

    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the server never reported a port")), 15_000);
      let out = "";
      child.stdout.on("data", (b) => {
        out += b.toString();
        const match = out.match(/127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.on("error", reject);
    });
  });

  after(() => {
    if (child) child.kill();
    if (stub) stub.close();
    if (/Error|EADDRINUSE/.test(stderr)) throw new Error(`the server wrote to stderr:\n${stderr}`);
  });

  test("a till prompt goes out as Buy Goods, and the result callback credits once", async () => {
    const token = (await (await fetch(`${base}/api/auth/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })).json()).token;
    const auth = { authorization: `Bearer ${token}` };
    const me = async () => (await (await fetch(`${base}/api/auth/me`, { headers: auth })).json()).user;

    const push = await fetch(`${base}/api/auth/mpesa/stk-push`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ amount: 10, phone: "0712345678" }),
    });
    const pushBody = await push.text();
    assert.equal(push.status, 200, pushBody);
    const started = JSON.parse(pushBody);
    assert.equal(started.status, "pending", "an accepted prompt is not a payment");
    assert.equal(started.deposit.settlement_amount, 1300, "10 USD at 130 KES");
    assert.equal(started.deposit.provider_reference, "ws_CO_E2E");

    // What the stand-in Safaricom was actually asked to charge.
    assert.equal(lastPush.TransactionType, "CustomerBuyGoodsOnline", "a till is Buy Goods");
    assert.equal(lastPush.PartyB, "880100", "the till number, not the shortcode");
    assert.equal(lastPush.BusinessShortCode, "174379");
    assert.equal(lastPush.Amount, 1300);
    assert.equal(Buffer.from(lastPush.Password, "base64").toString("utf8"), `174379e2e-passkey${lastPush.Timestamp}`);

    const balanceBefore = (await me()).real_balance;

    const callback = (body, tok = "e2e-token") =>
      fetch(`${base}/api/auth/mpesa/callback/${tok}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const item = (name, value) => ({ Name: name, Value: value });
    const result = (receipt, amount = 1300) => ({
      Body: {
        stkCallback: {
          MerchantRequestID: "mr_e2e",
          CheckoutRequestID: "ws_CO_E2E",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [item("Amount", amount), item("MpesaReceiptNumber", receipt), item("TransactionDate", 20261014153045), item("PhoneNumber", 254712345678)],
          },
        },
      },
    });

    const credited = await callback(result("E2E_RECEIPT_1"));
    assert.equal(credited.status, 200, await credited.text());
    assert.equal((await me()).real_balance, balanceBefore + 10, "1300 KES credits 10 USD, not 1300");

    // Safaricom can redeliver the same result; the wallet must not move twice.
    assert.equal((await callback(result("E2E_RECEIPT_1"))).status, 200);
    assert.equal((await me()).real_balance, balanceBefore + 10, "a replayed callback credits nothing");

    // The callback is public, so the URL secret is the only thing in the way.
    assert.equal((await callback(result("E2E_FORGED"), "wrong-token")).status, 403);
    assert.equal((await me()).real_balance, balanceBefore + 10, "a forged callback credits nothing");
  });
});
