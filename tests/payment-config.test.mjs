/**
 * Payment-environment configuration tests.
 *
 * Two properties are load-bearing and were not covered before:
 *
 *   1. A configuration that cannot work is refused rather than guessed at. An
 *      unknown DARAJA_ENV, a callback URL without the token path, and a public
 *      plain-http callback were all silently accepted, and each one produces the
 *      same user-visible symptom: a pending deposit whose result never arrives.
 *   2. An M-Pesa deposit records which environment created it. Without that,
 *      a sandbox deposit that somehow settled would be indistinguishable from
 *      real money — in the wallet and in the ledger.
 *
 * No provider is contacted: the transport is a fixture, exactly as in
 * tests/payments.test.mjs.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../tools/store.mjs";
import { ApiError, config, createPaymentRoutes } from "../tools/payments.mjs";
import {
  PAYMENTS_ENV_LABEL_ID,
  injectPaymentsEnvironmentBanner,
  paymentsEnvironmentBanner,
} from "../tools/client-patches.mjs";

const DARAJA_KEYS = [
  "DARAJA_ENV",
  "DARAJA_CONSUMER_KEY",
  "DARAJA_CONSUMER_SECRET",
  "DARAJA_SHORTCODE",
  "DARAJA_PASSKEY",
  "DARAJA_CALLBACK_URL",
  "DARAJA_CALLBACK_TOKEN",
  "DARAJA_ALLOW_PRODUCTION",
  "DARAJA_TRANSACTION_TYPE",
  "DARAJA_PARTY_B",
];

const saved = {};
for (const key of DARAJA_KEYS) saved[key] = process.env[key];
afterEach(() => {
  for (const key of DARAJA_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A complete, self-consistent sandbox configuration. */
function sandboxEnv(extra = {}) {
  for (const key of DARAJA_KEYS) delete process.env[key];
  Object.assign(process.env, {
    DARAJA_ENV: "sandbox",
    DARAJA_CONSUMER_KEY: "fixture-key",
    DARAJA_CONSUMER_SECRET: "fixture-secret",
    DARAJA_SHORTCODE: "174379",
    DARAJA_PASSKEY: "fixture-passkey",
    DARAJA_CALLBACK_TOKEN: "fixture-token",
    DARAJA_CALLBACK_URL: "https://api.example.test/api/auth/mpesa/callback/fixture-token",
    ...extra,
  });
}

function harness() {
  const store = createMemoryStore();
  const user = { id: "u_alice", email: "alice@example.com", username: "Alice", real_balance: 0, demo_balance: 10000, is_demo: false };
  store.db.users.push(user);
  store.db.sessions = { token_alice: user.id };

  const requireUser = async (ctx) => {
    const header = ctx?.req?.headers?.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const userId = token && store.db.sessions[token];
    if (!userId) throw new ApiError(401, "UNAUTHENTICATED", "Not authorised");
    return store.db.users.find((u) => u.id === userId);
  };

  const routes = createPaymentRoutes({
    store,
    requireUser,
    exchange: {
      get: async () => ({
        base: "USD",
        quote: "KES",
        pair: "USD/KES",
        rate: 130,
        provider: "fixture-provider",
        source: "fixture-provider",
        sourceUrl: "http://fixture.test/latest/USD",
        asOf: "2026-10-17T00:00:00Z",
        fetchedAt: Date.now(),
        cached: false,
      }),
    },
    providers: {
      darajaStkPush: async () => ({ CheckoutRequestID: "ws_CO_FIXTURE_ENV", MerchantRequestID: "mr_FIXTURE_ENV" }),
    },
  });

  return {
    store,
    user,
    routes,
    ctx: (body = {}) => ({ req: { headers: { authorization: "Bearer token_alice" } }, body, params: {} }),
  };
}

describe("DARAJA_ENV is validated, never guessed at", () => {
  test("an unknown value blocks payment processing and says why", () => {
    sandboxEnv({ DARAJA_ENV: "staging" });
    const cfg = config().daraja;
    assert.equal(cfg.environment, "sandbox", "the safe direction is kept");
    assert.equal(cfg.environmentRaw, "staging", "what was written is reported, not what was guessed");
    assert.equal(cfg.blocked, true);
    assert.equal(cfg.configured, false);
    assert.match(cfg.blockedReason, /DARAJA_ENV="staging" is neither sandbox nor production/);
  });

  test("unset means sandbox: the documented default is not an error", () => {
    sandboxEnv({ DARAJA_ENV: "" });
    const cfg = config().daraja;
    assert.equal(cfg.environment, "sandbox");
    assert.equal(cfg.blocked, false);
    assert.equal(cfg.configured, true);
  });

  test("production still needs its second lock", () => {
    sandboxEnv({ DARAJA_ENV: "production" });
    assert.equal(config().daraja.blocked, true);
    assert.match(config().daraja.blockedReason, /DARAJA_ALLOW_PRODUCTION=1/);

    process.env.DARAJA_ALLOW_PRODUCTION = "1";
    assert.equal(config().daraja.blocked, false);
    assert.equal(config().daraja.configured, true);
    assert.equal(config().daraja.environment, "production");
  });
});

describe("the callback URL has to be one Safaricom can actually reach", () => {
  test("a URL without the token path is inconsistent configuration", () => {
    sandboxEnv({ DARAJA_CALLBACK_URL: "https://api.example.test/api/auth/mpesa/callback" });
    const cfg = config().daraja;
    assert.equal(cfg.configured, false);
    assert.match(cfg.blockedReason, /does not end with \/api\/auth\/mpesa\/callback\/<DARAJA_CALLBACK_TOKEN>/);
  });

  test("a public plain-http callback is refused", () => {
    sandboxEnv({ DARAJA_CALLBACK_URL: "http://api.example.test/api/auth/mpesa/callback/fixture-token" });
    assert.equal(config().daraja.configured, false);
    assert.match(config().daraja.blockedReason, /must be https on a public host/);
  });

  test("a loopback stand-in is still allowed, because the suite drives one", () => {
    sandboxEnv({ DARAJA_CALLBACK_URL: "http://127.0.0.1:4999/api/auth/mpesa/callback/fixture-token" });
    assert.equal(config().daraja.configured, true);
  });
});

describe("a refused deposit is a 503 with the reason, not a 500 or a fake intent", () => {
  test("an inconsistent environment refuses before any deposit is recorded", async () => {
    sandboxEnv({ DARAJA_ENV: "prod" });
    const h = harness();
    const err = await h.routes.mpesaStkPush(h.ctx({ amount: 1, phone: "0712345678" })).catch((e) => e);
    assert.equal(err.status, 503);
    assert.equal(err.code, "PAYMENT_PROVIDER_NOT_CONFIGURED");
    assert.equal(err.extra.environment, "sandbox");
    assert.match(err.extra.reason, /neither sandbox nor production/);
    assert.equal(h.store.db.deposits.length, 0, "nothing was recorded for a prompt that was never sent");
    assert.equal(h.user.real_balance, 0);
  });
});

describe("a deposit records the environment that created it", () => {
  test("a sandbox deposit is stamped sandbox, in the response and in the row", async () => {
    sandboxEnv();
    const h = harness();
    const result = await h.routes.mpesaStkPush(h.ctx({ amount: 1, phone: "0712345678" }));
    assert.equal(result.deposit.environment, "sandbox");
    assert.equal(result.deposit.status, "pending");
    assert.equal(h.store.db.deposits[0].environment, "sandbox", "the stored row carries it too");
  });

  test("a production deposit is stamped production", async () => {
    sandboxEnv({ DARAJA_ENV: "production", DARAJA_ALLOW_PRODUCTION: "1" });
    const h = harness();
    const result = await h.routes.mpesaStkPush(h.ctx({ amount: 1, phone: "0712345678" }));
    assert.equal(result.deposit.environment, "production");
    assert.equal(h.store.db.deposits[0].environment, "production");
  });

  test("the environment is visible in the deposit list and in a status read", async () => {
    sandboxEnv();
    const h = harness();
    const { deposit } = await h.routes.mpesaStkPush(h.ctx({ amount: 1, phone: "0712345678" }));

    const list = await h.routes.listDeposits(h.ctx());
    assert.equal(list.deposits[0].environment, "sandbox");

    const one = await h.routes.depositStatus({ req: { headers: { authorization: "Bearer token_alice" } }, params: { reference: deposit.reference } });
    assert.equal(one.deposit.environment, "sandbox");
  });
});

describe("the payment environment is visible on the page, not only in the database", () => {
  test("a sandbox build is labelled sandbox, in words a visitor can read", () => {
    const banner = paymentsEnvironmentBanner("sandbox");
    assert.match(banner, new RegExp(`id="${PAYMENTS_ENV_LABEL_ID}"`));
    assert.match(banner, /M-Pesa sandbox/);
    assert.match(banner, /no real money/);
  });

  test("a production build says the opposite, so the two cannot be confused", () => {
    const banner = paymentsEnvironmentBanner("production");
    assert.match(banner, /M-Pesa LIVE/);
    assert.doesNotMatch(banner, /no real money/);
    assert.notEqual(banner, paymentsEnvironmentBanner("sandbox"));
  });

  test("an unnamed environment produces no label at all", () => {
    assert.equal(paymentsEnvironmentBanner(""), null);
    assert.equal(paymentsEnvironmentBanner("staging"), null);
    assert.equal(injectPaymentsEnvironmentBanner("<html><body>x</body></html>", "").injected, false);
  });

  test("the label is inserted before </body>, once", () => {
    const page = "<html><body><div id=\"root\"></div></body></html>";
    const first = injectPaymentsEnvironmentBanner(page, "sandbox");
    assert.equal(first.injected, true);
    assert.ok(first.html.indexOf(PAYMENTS_ENV_LABEL_ID) < first.html.lastIndexOf("</body>"));
    const again = injectPaymentsEnvironmentBanner(first.html, "sandbox");
    assert.equal(again.injected, false);
    assert.equal(again.html, first.html, "a second pass must not stack labels");
  });

  test("a page without a body is refused with a reason, never silently dropped", () => {
    const result = injectPaymentsEnvironmentBanner("<div>fragment</div>", "sandbox");
    assert.equal(result.injected, false);
    assert.match(result.reason, /no <\/body>/);
  });
});
