/**
 * Deposit domain for the local API.
 *
 * ARCHITECTURE NOTE — read this before enabling anything.
 *
 * No live provider integration is enabled, and none is claimed. Daraja, a card
 * processor and a TRON custodian each require merchant onboarding that cannot be
 * conjured from a code change, so each is represented by exactly one injectable
 * transport function (`providers.darajaStkPush`, `providers.cardCharge`,
 * `providers.tronDepositAddress`).
 *
 * What that gives us:
 *   - with no credentials      -> 503 PAYMENT_PROVIDER_NOT_CONFIGURED
 *   - with credentials but no
 *     implemented integration  -> 501 PROVIDER_INTEGRATION_MISSING
 *   - in tests, with a fixture -> the whole intent flow runs for real
 *
 * So the request validation, the intent state machine, idempotency, the
 * ownership checks and the settle-once guarantee are all real and all tested,
 * while the network hop to a payment provider is the one thing that is not.
 * That boundary is deliberate and is the only thing standing between this and a
 * live integration.
 *
 * There is exactly ONE function that credits a wallet: `settleDeposit`. It
 * refuses pending, failed, cancelled, underpaid, wrong-currency and already
 * settled deposits, is serialised against concurrent callers, and rolls back if
 * the write fails.
 *
 * See PAYMENTS.md.
 */
import crypto from "node:crypto";
import { createDarajaClient, DarajaError, isBuyGoods } from "./daraja.mjs";
import { createReconciler, reconcileConfig } from "./reconcile.mjs";

/* ------------------------ TRC20 deposit wallet ------------------------ */

/**
 * The operator's own receiving wallet for USD₮ on TRON.
 *
 * This is configuration, not custody: no provider is contacted, nothing is
 * generated, and every account is shown the same address. A shared address
 * cannot tell two depositors apart, so attribution still requires an on-chain
 * confirmation you verify yourself — never a client-submitted hash.
 *
 * A deployment enables it by setting `TRON_DEPOSIT_ADDRESS` (which the mirrored
 * server does from this default). Setting that variable to an empty string
 * disables the static wallet and falls back to a custody provider, or to the
 * honest `503` when there is none.
 */
export const DEFAULT_TRON_DEPOSIT_ADDRESS = "TY6nEvWDneE8XuTj7ua8s1dSXdo7dkZWXW";

/** A TRON base58 address: a `T` followed by 33 base58 characters. */
export function isTronAddress(value) {
  return typeof value === "string" && /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value);
}

/* ------------------------------- config ------------------------------- */

export function config() {
  const env = process.env;

  /*
   * The payment environment is read once, here, and a value that is neither
   * `sandbox` nor `production` is an ERROR rather than a quiet default. The old
   * behaviour coerced it to sandbox — safe in direction, but it also meant a
   * typo looked like a working sandbox deployment, and an operator who thought
   * they had enabled production would see nothing wrong in the boot log.
   * `DARAJA_ENV` unset stays sandbox: that is the documented default, not a
   * fallback from a value someone did set.
   */
  const environmentRaw = String(env.DARAJA_ENV ?? "").trim().toLowerCase();
  const environment = environmentRaw === "production" ? "production" : "sandbox";
  const callbackUrl = String(env.DARAJA_CALLBACK_URL || "").trim();
  const callbackToken = String(env.DARAJA_CALLBACK_TOKEN || "").trim();

  /*
   * Configuration that cannot work is refused at the point of use, and this is
   * the list of reasons. Each one would otherwise fail silently in production:
   *
   *   - an unknown DARAJA_ENV, which must not be guessed at;
   *   - a callback URL that is not HTTPS for a public host, because Safaricom
   *     requires it and a plain-http callback would simply never arrive;
   *   - a callback URL that does not carry the token path, because the route
   *     would answer 404 to every result and the deposit would hang pending
   *     while the customer's money moved.
   */
  const problems = [];
  if (environmentRaw && environmentRaw !== "sandbox" && environmentRaw !== "production") {
    problems.push(`DARAJA_ENV="${environmentRaw}" is neither sandbox nor production`);
  }
  if (callbackUrl) {
    let parsed = null;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      problems.push("DARAJA_CALLBACK_URL is not a valid URL");
    }
    if (parsed) {
      const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
      if (parsed.protocol !== "https:" && !loopback) {
        problems.push("DARAJA_CALLBACK_URL must be https on a public host");
      }
      if (callbackToken && !parsed.pathname.endsWith(`/api/auth/mpesa/callback/${callbackToken}`)) {
        problems.push("DARAJA_CALLBACK_URL does not end with /api/auth/mpesa/callback/<DARAJA_CALLBACK_TOKEN>");
      }
    }
  }

  return {
    daraja: {
      consumerKey: env.DARAJA_CONSUMER_KEY,
      consumerSecret: env.DARAJA_CONSUMER_SECRET,
      shortcode: env.DARAJA_SHORTCODE,
      passkey: env.DARAJA_PASSKEY,
      callbackUrl,
      // The callback is public, so the URL carries an unguessable token. Without
      // one the callback route refuses, rather than accepting unauthenticated
      // POSTs that could credit a wallet.
      callbackToken,
      environment,
      // Kept so the boot log can say what was actually written, not what the
      // code guessed from it.
      environmentRaw,
      // Configuration that cannot work. Empty means nothing was found wrong.
      problems,
      // An escape hatch for tests and for pointing at a stand-in during a dry
      // run. Unset means the real Safaricom host for the chosen environment.
      baseUrl: env.DARAJA_BASE_URL || null,
      // A till (Buy Goods) and a paybill take the same request with one field
      // changed; DARAJA_TRANSACTION_TYPE decides which, and PartyB carries the
      // till number when it differs from the shortcode.
      transactionType: isBuyGoods(env.DARAJA_TRANSACTION_TYPE) ? "buygoods" : "paybill",
      partyB: env.DARAJA_PARTY_B || env.DARAJA_SHORTCODE,
      timeoutMs: Number(env.DARAJA_TIMEOUT_MS || 15_000),
      /**
       * Production Daraja charges a real shortcode and moves real money, so it
       * takes a second, deliberate variable on top of DARAJA_ENV=production.
       * A deployment built from this repository that copies its configuration
       * therefore will not take a real payment until someone means it to.
       */
      get blockedReason() {
        if (this.problems.length) return this.problems.join("; ");
        if (this.environment === "production" && env.DARAJA_ALLOW_PRODUCTION !== "1") {
          return "DARAJA_ENV=production requires DARAJA_ALLOW_PRODUCTION=1";
        }
        return null;
      },
      get blocked() {
        return this.blockedReason !== null;
      },
      get configured() {
        // A callback URL is part of being configured: without one Daraja cannot
        // report the result, so a prompt would be sent and never resolved.
        return !!(
          this.consumerKey && this.consumerSecret && this.shortcode && this.passkey &&
          this.callbackUrl && !this.blocked
        );
      },
      requiredEnv: [
        "DARAJA_CONSUMER_KEY",
        "DARAJA_CONSUMER_SECRET",
        "DARAJA_SHORTCODE",
        "DARAJA_PASSKEY",
        "DARAJA_CALLBACK_URL",
      ],
    },
    card: {
      provider: env.CARD_PROVIDER,
      secretKey: env.CARD_SECRET_KEY,
      returnUrl: env.CARD_RETURN_URL,
      timeoutMs: Number(env.CARD_TIMEOUT_MS || 15_000),
      get configured() {
        return !!(this.provider && this.secretKey);
      },
      requiredEnv: ["CARD_PROVIDER", "CARD_SECRET_KEY"],
    },
    tron: {
      provider: env.TRON_WALLET_PROVIDER,
      apiKey: env.TRON_API_KEY,
      // Present only when the deployment names a wallet. An empty string counts
      // as "not set", which is how the static wallet is turned off.
      depositAddress: String(env.TRON_DEPOSIT_ADDRESS || "").trim() || null,
      timeoutMs: Number(env.TRON_TIMEOUT_MS || 10_000),
      get configured() {
        // A named wallet is configuration enough: no provider call is made, so
        // no merchant credentials are needed to serve an address.
        return !!(this.depositAddress || (this.provider && this.apiKey));
      },
      requiredEnv: ["TRON_DEPOSIT_ADDRESS", "TRON_WALLET_PROVIDER", "TRON_API_KEY"],
    },
    exchangeRate: {
      // Keyless feed that publishes KES. (The ECB reference set does NOT include
      // KES — verified — so it cannot be used for USD/KES on its own.)
      url: env.EXCHANGE_RATE_API_URL || "https://open.er-api.com/v6/latest/USD",
      ttlMs: Number(env.EXCHANGE_RATE_TTL_MS || 6 * 60 * 60 * 1000),
      timeoutMs: Number(env.EXCHANGE_RATE_TIMEOUT_MS || 5_000),
    },
  };
}

/* ------------------------------- errors ------------------------------- */

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message, extra) => new ApiError(400, "INVALID_INPUT", message, extra);
const forbidden = (message) => new ApiError(403, "FORBIDDEN", message);
const notFound = (message) => new ApiError(404, "NOT_FOUND", message);
const conflict = (message) => new ApiError(409, "CONFLICT", message);
const tooMany = (message) => new ApiError(429, "RATE_LIMITED", message);

/** Constant-time compare, so a callback token cannot be discovered by timing. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Credentials are missing, so the deposit cannot be started. */
function providerNotConfigured(name, requiredEnv, extra = {}) {
  return new ApiError(
    503,
    "PAYMENT_PROVIDER_NOT_CONFIGURED",
    `${name} is not configured on this server, so the deposit cannot be started.`,
    { provider: name.toLowerCase(), required_env: requiredEnv, ...extra }
  );
}

/* ------------------------- provider transports ------------------------- */

/**
 * The ONLY places a payment provider would be contacted.
 *
 * The default implementation is honest about what it is: credentials alone are
 * not an integration, so it refuses rather than fabricating a provider response.
 * Tests inject fixtures here, which is what makes the intent flow testable while
 * still keeping every test's provider clearly synthetic.
 */
/**
 * One Daraja client per configuration, so the OAuth token is reused across
 * prompts instead of being fetched for every one. The fingerprint includes a
 * hash of the credentials — never the credentials themselves.
 */
let darajaClient = null;
let darajaClientKey = null;

function darajaClientFor(cfg) {
  const credentialPrint = crypto
    .createHash("sha256")
    .update(`${cfg.daraja.consumerKey}:${cfg.daraja.consumerSecret}`)
    .digest("hex")
    .slice(0, 16);
  const key = [
    cfg.daraja.environment,
    cfg.daraja.baseUrl || "",
    cfg.daraja.shortcode,
    cfg.daraja.partyB,
    cfg.daraja.transactionType,
    cfg.daraja.timeoutMs,
    credentialPrint,
  ].join("|");

  if (!darajaClient || darajaClientKey !== key) {
    darajaClient = createDarajaClient({
      environment: cfg.daraja.environment,
      baseUrl: cfg.daraja.baseUrl || undefined,
      consumerKey: cfg.daraja.consumerKey,
      consumerSecret: cfg.daraja.consumerSecret,
      shortcode: cfg.daraja.shortcode,
      passkey: cfg.daraja.passkey,
      partyB: cfg.daraja.partyB,
      transactionType: cfg.daraja.transactionType,
      timeoutMs: cfg.daraja.timeoutMs,
    });
    darajaClientKey = key;
  }
  return darajaClient;
}

export function defaultProviders() {
  const missing = (label) => async () => {
    throw new ApiError(
      501,
      "PROVIDER_INTEGRATION_MISSING",
      `No ${label} integration is implemented on this server, so nothing was sent to the provider.`,
      { provider: label, docs: "PAYMENTS.md" }
    );
  };
  return {
    /**
     * The real Safaricom transport, selected only when the deployment has
     * credentials. Without them the honest refusal below stands, so an
     * unconfigured server can never look like it sent a prompt.
     */
    darajaStkPush: async (request) => {
      const cfg = config();
      if (!cfg.daraja.configured) return missing("Daraja STK Push")();
      try {
        return await darajaClientFor(cfg).stkPush(request);
      } catch (err) {
        if (err instanceof DarajaError) {
          throw new ApiError(err.status, err.code, err.message, err.details);
        }
        throw err;
      }
    },
    /**
     * The same transport's query endpoint, used only by reconciliation. It asks
     * what happened to a CheckoutRequestID we issued; it never moves money, and
     * a deployment without credentials refuses here rather than pretending to
     * have asked Safaricom anything.
     */
    darajaStkQuery: async (request) => {
      const cfg = config();
      if (!cfg.daraja.configured) return missing("Daraja STK Query")();
      try {
        return await darajaClientFor(cfg).stkQuery(request);
      } catch (err) {
        if (err instanceof DarajaError) {
          throw new ApiError(err.status, err.code, err.message, err.details);
        }
        throw err;
      }
    },
    cardCharge: missing("card processor"),
    /**
     * With an operator wallet named, we hand back exactly that address — nothing
     * is contacted and nothing is generated. With nothing configured we refuse,
     * so this endpoint still cannot be made to invent an address.
     */
    tronDepositAddress: async () => {
      const address = config().tron.depositAddress;
      if (!address) return missing("TRC20 custody")();
      if (!isTronAddress(address)) {
        throw new ApiError(
          500,
          "TRON_ADDRESS_INVALID",
          "The configured TRON deposit address is not a valid TRON address, so no address is served.",
          { env: "TRON_DEPOSIT_ADDRESS" }
        );
      }
      return { address, network: "TRC20", source: "static-operator-wallet" };
    },
  };
}

/**
 * Bounds a provider call. A timeout is NOT a failure: we cannot tell whether the
 * provider acted, so callers keep the deposit pending for reconciliation
 * instead of marking it failed.
 */
function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ApiError(504, "PROVIDER_TIMEOUT", `The ${label} did not respond within ${ms}ms.`, {
            provider: label,
          })
        ),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/* ----------------------------- validation ----------------------------- */

const LIMITS = { minUsd: 1, maxMpesaUsd: 1900, maxCardUsd: 10000 };

export function validateAmount(value, max) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw badRequest("Amount must be a number");
  if (amount < LIMITS.minUsd) throw badRequest(`Minimum deposit is $${LIMITS.minUsd}`);
  if (amount > max) throw badRequest(`Maximum deposit is $${max}`);
  // Money is handled in cents to avoid float drift.
  return Math.round(amount * 100) / 100;
}

/** Accepts 2547XXXXXXXX / 2541XXXXXXXX / 07XXXXXXXX / 01XXXXXXXX / +254… */
export function normaliseMsisdn(input) {
  const raw = String(input || "").replace(/[\s()-]/g, "");
  if (!raw) throw badRequest("Phone number is required");

  let digits = raw.replace(/^\+/, "");
  if (digits.startsWith("0")) digits = "254" + digits.slice(1);
  else if (!digits.startsWith("254")) digits = "254" + digits;

  // Safaricom/Airtel Kenya mobile ranges: 254 then 7 or 1, then 8 more digits.
  if (!/^254[71]\d{8}$/.test(digits)) {
    throw badRequest("Enter a valid Kenyan phone number, e.g. 254712345678");
  }
  return digits;
}

/**
 * The number a prompt went to, in a form that identifies it without storing it.
 *
 * `254712345678` -> `2547****678`. The prefix and the last three digits are what
 * a person recognises their own line by; the middle is what makes it personal
 * data. Without this, a deposit that failed at the provider cannot be diagnosed
 * afterwards — on 2026-10-18 one did, and there was no record of the number at
 * all, so neither the operator nor the customer could say what had been tried.
 */
export function maskMsisdn(input) {
  const digits = String(input || "").replace(/\D/g, "");
  // A whole number, or nothing. Masking a fragment would put a string that is
  // not a phone number into a column a reader will trust as one; the normaliser
  // admits 12 digits (254 + 9), and E.164 caps at 15, so anything outside that
  // is a caller bug rather than a number.
  if (!/^\d{10,15}$/.test(digits)) return null;
  return `${digits.slice(0, 4)}****${digits.slice(-3)}`;
}

/**
 * What a provider result code implies about what to do next.
 *
 * The deposit's `failure_reason` stays the provider's own sentence, verbatim: it
 * is evidence, and rewording it would make the record less true. These hints are
 * additive, they name no credential, and nothing here can move money.
 *
 * The sandbox note appears only for a sandbox deposit. A production deposit must
 * never be told to try a test number.
 */
const MPESA_RESULT_HINTS = {
  1: "The M-Pesa wallet does not have enough money for this charge.",
  17: "The M-Pesa account has reached a transaction limit.",
  1001: "Another M-Pesa transaction on this number is still in progress. Try again in a moment.",
  1019: "The request expired before it was completed.",
  1025: "Safaricom could not deliver the prompt to this number.",
  1032: "The prompt was cancelled on the phone, so nothing was charged.",
  1037: "The prompt was not answered before it expired, so nothing was charged.",
  2001: "The M-Pesa PIN was entered incorrectly, so nothing was charged.",
  9999: "Safaricom could not deliver the prompt to this number.",
};

const SANDBOX_PUSH_NOTE =
  " The sandbox only reliably delivers prompts to Safaricom's test number 254708374149; " +
  "another number can fail exactly this way. Retrying is safe — no money moved.";

export function mpesaResultHint(code, environment = null) {
  if (code == null) return null;
  const hint = MPESA_RESULT_HINTS[Number(code)];
  if (!hint) return null;
  const pushFailure = Number(code) === 9999 || Number(code) === 1025;
  return pushFailure && environment === "sandbox" ? hint + SANDBOX_PUSH_NOTE : hint;
}

/**
 * The mirrored client has two card forms and they post different shapes:
 *   {amount, cardNumber, cardExpiry, cardCvv, cardName}
 *   {amount, cardNumber, expiryMonth, expiryYear, cvv, cardholderName}
 * Accept both, plus a nested `card` object for API clients.
 */
export function readCardFields(body = {}) {
  const nested = body.card || {};
  const number = body.cardNumber ?? nested.number;

  let expiry = body.cardExpiry ?? nested.expiry;
  if (!expiry && body.expiryMonth != null && body.expiryYear != null) {
    const month = String(body.expiryMonth).padStart(2, "0");
    const year = String(body.expiryYear).slice(-2).padStart(2, "0");
    expiry = `${month}/${year}`;
  }

  return {
    number,
    expiry,
    cvc: body.cardCvv ?? body.cvv ?? nested.cvc,
    name: body.cardName ?? body.cardholderName ?? nested.name,
  };
}

/** Card field hygiene: we validate the shape, then keep last4/brand only. */
export function validateCardFields(card = {}) {
  const number = String(card.number || "").replace(/\s|-/g, "");
  if (!/^\d{12,19}$/.test(number) || !luhn(number)) throw badRequest("Card number is not valid");

  if (!/^\d{2}\s*\/\s*\d{2}$/.test(String(card.expiry || ""))) throw badRequest("Expiry must be MM/YY");
  const [mm, yy] = String(card.expiry).split("/").map((s) => s.trim());
  const month = Number(mm);
  if (month < 1 || month > 12) throw badRequest("Expiry month is not valid");
  const expiresEnd = new Date(2000 + Number(yy), month, 1).getTime();
  if (expiresEnd < Date.now()) throw badRequest("Card has expired");

  if (!/^\d{3,4}$/.test(String(card.cvc || ""))) throw badRequest("CVC is not valid");
  const name = String(card.name || "").trim();
  if (name.length < 2) throw badRequest("Cardholder name is required");

  // The PAN, CVC and cardholder name are intentionally dropped here: they are
  // never stored, logged or returned.
  return { last4: number.slice(-4), brand: cardBrand(number), expiry: `${mm}/${yy}` };
}

function luhn(number) {
  let sum = 0;
  let double = false;
  for (let i = number.length - 1; i >= 0; i--) {
    let d = Number(number[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function cardBrand(number) {
  if (/^4/.test(number)) return "visa";
  if (/^5[1-5]/.test(number) || /^2[2-7]/.test(number)) return "mastercard";
  return "unknown";
}

/* ------------------------------ primitives ------------------------------ */

/** Serialises async work so two settlements cannot interleave. */
export function mutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

/** Fixed-window limiter, keyed per user+route. */
export function rateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const buckets = new Map();
  return function limit(key) {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start >= windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) throw tooMany("Too many requests, please slow down");
  };
}

export const reference = (prefix) => `${prefix}_${crypto.randomBytes(10).toString("hex")}`;

/* --------------------------- exchange rate --------------------------- */

/**
 * USD→KES, cached with a TTL. On failure with no cache we return a structured
 * error — we never silently substitute a hardcoded rate.
 */
export function createExchangeRateService(cfg = config().exchangeRate) {
  let cache = null;

  /** Accepts either a JSON rates payload or an ECB-style XML feed. */
  function parsePayload(text) {
    const trimmed = text.trim();

    if (trimmed.startsWith("{")) {
      const body = JSON.parse(trimmed);
      if (body.result && body.result !== "success") throw new Error(`provider reported ${body.result}`);
      const rates = body.rates || body.conversion_rates;
      if (!rates || typeof rates !== "object") throw new Error("provider response contains no rates");
      return {
        rates,
        base: body.base_code || body.base || "USD",
        asOf: body.time_last_update_utc || null,
        provider: body.provider || new URL(cfg.url).host,
      };
    }

    // ECB reference rates: EUR-based XML with single-quoted attributes.
    const date = (trimmed.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/) || [])[1];
    const rates = { EUR: 1 };
    for (const m of trimmed.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
      rates[m[1]] = Number(m[2]);
    }
    if (Object.keys(rates).length < 2) throw new Error("provider response contains no rates");
    return { rates, base: "EUR", asOf: date || null, provider: "European Central Bank" };
  }

  async function fetchRate() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.url, {
        headers: { accept: "application/json, text/xml;q=0.9, */*;q=0.8" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`provider responded ${res.status}`);
      return parsePayload(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * No usable rate. Serve the last known value if we have one, otherwise fail
   * loudly — we never invent a rate.
   */
  function unusable(reason) {
    if (cache) {
      return {
        ...cache,
        cached: true,
        stale: true,
        warning: "exchange rate provider unavailable; showing the last known rate",
      };
    }
    throw new ApiError(503, "EXCHANGE_RATE_UNAVAILABLE", "Exchange rate is temporarily unavailable", {
      provider: new URL(cfg.url).host,
      reason,
    });
  }

  return {
    get cache() {
      return cache;
    },
    async get({ force = false } = {}) {
      if (!force && cache && Date.now() - cache.fetchedAt < cfg.ttlMs) {
        return { ...cache, cached: true };
      }

      let payload;
      try {
        payload = await fetchRate();
      } catch (err) {
        return unusable(String((err && err.message) || err));
      }

      const { rates, base, asOf, provider } = payload;
      const baseCode = base || "USD";

      const kesPerBase = Number(rates.KES);
      if (!Number.isFinite(kesPerBase) || kesPerBase <= 0) {
        return unusable("provider does not publish a usable KES rate");
      }

      let usdToKes = kesPerBase;
      if (baseCode !== "USD") {
        const usdPerBase = Number(rates.USD);
        if (!Number.isFinite(usdPerBase) || usdPerBase <= 0) {
          return unusable("provider does not publish USD, needed to derive USD/KES");
        }
        usdToKes = kesPerBase / usdPerBase;
      }

      if (!Number.isFinite(usdToKes) || usdToKes <= 0) {
        return unusable("derived USD/KES rate is invalid");
      }

      cache = {
        pair: "USD/KES",
        rate: Number(usdToKes.toFixed(4)),
        base: "USD",
        quote: "KES",
        provider,
        source: provider,
        sourceUrl: cfg.url,
        asOf: asOf || null,
        fetchedAt: Date.now(),
      };
      return { ...cache, cached: false };
    },
  };
}

/* ------------------------------ handlers ------------------------------ */

export function createPaymentRoutes({
  store,
  requireUser,
  providers = defaultProviders(),
  exchange = createExchangeRateService(),
  reconcile = reconcileConfig(),
  logger = console,
}) {
  const cfg = config();
  const limit = rateLimiter({ windowMs: 60_000, max: 20 });
  const addressLimit = rateLimiter({ windowMs: 60_000, max: 10 });
  const withLock = mutex();

  /**
   * In-flight address allocations, keyed by user. Two concurrent requests for
   * the same account share one provider call, so a UI that asks twice still
   * results in exactly one allocated address.
   */
  const allocations = new Map();

  // All of this state lives in the store (tools/store.mjs). Nothing is cached in
  // this process, so a second instance serving the same account sees exactly the
  // same deposits — and a restart sees all of them.

  /**
   * The client-facing deposit. `amount` is always USD — what the user deposits
   * and what we credit. `settlement_*` is what the provider charges, which for
   * M-Pesa is KES. Keeping both is what stops the two being confused.
   */
  const publicDeposit = (d) => ({
    id: d.id,
    reference: d.reference,
    amount: d.amount,
    currency: d.currency,
    usd_amount: d.usd_amount ?? d.amount,
    settlement_currency: d.settlement_currency || d.currency,
    settlement_amount: d.settlement_amount ?? d.amount,
    settlement_rate: d.settlement_rate ?? null,
    method: d.method,
    status: d.status,
    // "sandbox" or "production" for an M-Pesa deposit, null for a method that
    // has no provider environment. A later reader must be able to tell a test
    // deposit from one that moved money; the wallet itself cannot say.
    environment: d.environment ?? null,
    // Where the prompt went, masked. Answers "which number was this?" without
    // putting a phone number in the response, or in the logs.
    msisdn_masked: d.msisdn_masked || null,
    provider_reference: d.provider_reference || null,
    // The provider's result code, so a client can tell a prompt the customer
    // cancelled (1032) from a failure that needs their attention. It is not a
    // secret: it is the number Safaricom itself puts in the callback.
    mpesa_result_code: d.mpesa_result_code == null ? null : Number(d.mpesa_result_code),
    failure_reason: d.failure_reason || null,
    // Additive guidance for a code we know; null for one we do not. The
    // provider's own sentence above is never replaced by this.
    failure_hint: d.status === "completed" ? null : mpesaResultHint(d.mpesa_result_code, d.environment),
    created_at: d.created_at,
    completed_at: d.completed_at || null,
  });

  /** A replayed idempotency key returns the original deposit, never a second one. */
  async function replayDeposit(user, key) {
    if (!key) return null;
    const existingId = await store.findIdempotentKey(user.id, key);
    if (!existingId) return null;
    return store.findDeposit(existingId);
  }

  async function rememberKey(user, key, deposit) {
    if (key) await store.rememberIdempotentKey(user.id, key, deposit.id);
  }

  /**
   * Records the intent, before the provider is contacted. Nothing here credits
   * anything and nothing here is a payment.
   */
  async function recordPendingDeposit(user, { method, amountUsd, settlement, environment = null, msisdnMasked = null }) {
    const deposit = {
      id: reference("dep"),
      user_id: user.id,
      reference: reference("STO"),
      method,
      environment,
      msisdn_masked: msisdnMasked,
      amount: amountUsd,
      currency: "USD",
      usd_amount: amountUsd,
      settlement_currency: settlement.currency,
      settlement_amount: settlement.amount,
      settlement_rate: settlement.rate ?? null,
      status: "pending",
      is_demo: !!user.is_demo,
      provider_reference: null,
      failure_reason: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    };
    return store.insertDeposit(deposit);
  }

  /**
   * Records why an intent did not proceed. A timeout stays pending: we cannot
   * tell whether the provider acted, so it is left for reconciliation rather
   * than wrongly marked failed.
   */
  async function failDeposit(deposit, err) {
    const code = (err && err.code) || "PROVIDER_ERROR";
    const patch = { failure_reason: code, status: code === "PROVIDER_TIMEOUT" ? "pending" : "failed" };
    try {
      await store.updateDeposit(deposit.id, patch);
    } catch (writeErr) {
      console.error("[payments] could not record a failed intent:", writeErr.message);
    }
    return Object.assign(deposit, patch);
  }

  /**
   * The ONLY path that credits a wallet. It requires a settled, verified
   * payment reference, is idempotent, and is serialised so replaying or racing
   * the same reference credits exactly once.
   */
  async function settleDeposit({ reference: depRef, userId, providerReference, verifiedAmount, currency }) {
    return withLock(async () => {
      // One transaction for the whole settlement, and the deposit row is locked
      // first. A concurrent settlement of the same deposit waits here and then
      // sees `completed`, instead of both reading `pending` and both crediting.
      // The ledger insert is additionally guarded by a unique index in the
      // database, so even a coding mistake here cannot pay twice.
      try {
        const args = { reference: depRef, userId, providerReference, verifiedAmount, currency };
        return await store.tx((t) => settleWithin(t, args));
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(500, "SETTLEMENT_FAILED", "The deposit could not be settled; no funds were credited", {
          reason: String((err && err.message) || err),
        });
      }
    });
  }

  /**
   * The settlement itself, inside the caller's transaction. Split out only so the
   * failure wrapper above stays readable.
   */
  async function settleWithin(t, args) {
    const { reference: depRef, userId, providerReference, verifiedAmount, currency } = args;
    {
      const deposit = await t.lockDeposit(depRef);
      if (!deposit) throw notFound("Unknown deposit reference");
      if (userId && deposit.user_id !== userId) throw forbidden("That deposit belongs to another account");

      // Idempotency: a settled deposit is never settled again.
      if (deposit.status === "completed") return { credited: false, reason: "already_settled", deposit };
      if (deposit.status === "failed" || deposit.status === "cancelled") {
        throw conflict(`Cannot settle a ${deposit.status} deposit`);
      }
      if (!providerReference && !deposit.provider_reference) {
        throw badRequest("A verified provider reference is required to settle a deposit");
      }

      // A provider reference identifies ONE payment, so it may identify one
      // deposit. Without this, the same M-Pesa receipt delivered twice — or
      // reused by a hostile client against a second deposit — would credit a
      // second wallet for a single payment.
      //
      // Postgres refuses this independently, at the unique index on
      // `provider_reference`; this check is what gives the in-memory store the
      // same behaviour, and it is the difference between "the database saves us"
      // and "the application is correct". Under concurrency the database is
      // still the backstop: the index rejects the loser of the race.
      if (providerReference) {
        const owner = await t.findDeposit(providerReference);
        if (owner && owner.id !== deposit.id) {
          throw conflict("That M-Pesa receipt is already attached to another deposit, so it cannot settle this one");
        }
      }

      // Verified against the currency and amount the *provider* settles in, not
      // the USD figure the client sent. Nothing here trusts the browser.
      const settleCurrency = deposit.settlement_currency || deposit.currency;
      const settleAmount = deposit.settlement_amount ?? deposit.amount;
      if (verifiedAmount == null) throw badRequest("Verified amount is required");
      if (currency && currency !== settleCurrency) {
        throw badRequest("Verified currency does not match the deposit");
      }
      // KES settlement is billed in whole shillings, so allow a cent of drift.
      if (Number(verifiedAmount) + 0.01 < settleAmount) {
        throw badRequest("Verified amount is less than the deposit amount");
      }

      const account = await t.findUserById(deposit.user_id);
      if (!account) throw notFound("Account not found");

      const completedAt = new Date().toISOString();
      // The wallet is credited in USD. The settlement amount is kept for audit.
      const credit = deposit.usd_amount ?? deposit.amount;

      // Incremented in the database (balance = balance + credit) rather than read
      // into this process and written back, so a concurrent trade cannot have its
      // debit overwritten by a stale copy of the balance.
      //
      // Credited first, because the ledger row records the balance it produced.
      // Both statements are inside the caller's transaction, so a duplicate
      // reference that trips the unique index rolls the credit back with it.
      const balance = await t.creditBalance({
        userId: deposit.user_id,
        balanceKey: "real_balance",
        amount: credit,
      });

      await t.insertTransaction({
        id: reference("tx"),
        user_id: deposit.user_id,
        type: "deposit",
        amount: credit,
        currency: "USD",
        method: deposit.method,
        reference: deposit.reference,
        status: "completed",
        balance_after: balance,
        created_at: completedAt,
      });

      const settled = await t.updateDeposit(deposit.id, {
        status: "completed",
        provider_reference: providerReference || deposit.provider_reference,
        verified_amount: Number(verifiedAmount),
        completed_at: completedAt,
      });

      return { credited: true, deposit: settled, balance };
    }
  }

  /* --------------------------- reconciliation --------------------------- */

  /**
   * The narrow slice of the store the reconciler needs. It is written out here
   * rather than passing the whole store, so the reconciler cannot reach for
   * something it was not meant to touch — and so the tests can hand it a fake.
   */
  const reconcileLedger = {
    listDue: (options) => store.listReconcilableDeposits(options),
    claim: (id, options) => store.claimDepositForReconciliation(id, options),
    failIfUnsettled: (id, patch) => store.failDepositIfUnsettled(id, patch),
    update: (id, patch) => store.updateDeposit(id, patch),
  };

  /**
   * The worker that chases deposits whose callback never arrived.
   *
   * It is given THIS module's `settleDeposit` — the one function that credits a
   * wallet — so a reconciled payment and a callback-settled payment go through
   * the same validation and the same exactly-once guarantee. There is no second
   * crediting path, deliberately.
   */
  const reconciler = createReconciler({
    ledger: reconcileLedger,
    settleDeposit,
    /**
     * A caller may inject only some providers (the tests do). Asking a missing
     * one must be a typed refusal the reconciler treats as inconclusive, not a
     * TypeError — the same honesty the default providers have towards a
     * deployment with no credentials.
     */
    queryProvider: (request) => {
      const query = providers.darajaStkQuery;
      if (typeof query !== "function") {
        throw new ApiError(
          501,
          "PROVIDER_INTEGRATION_MISSING",
          "No Daraja STK query integration is available on this server, so nothing was asked of the provider.",
          { provider: "Daraja STK Query", docs: "PAYMENTS.md" }
        );
      }
      return query(request);
    },
    config: reconcile,
    logger,
  });

  /* ------------------------------ routes ------------------------------ */

  return {
    exchange,

    /**
     * GET /api/auth/exchange-rate
     *
     * Deliberately NOT authenticated. The mirrored client requests this with no
     * Authorization header at all — read straight out of the chunk — so
     * requiring auth produced a 401 and a silent fall back to the client's own
     * hardcoded 130. A public USD/KES reference rate is not user data and has
     * nothing to protect. The rate itself is never invented: if the provider
     * cannot be reached there is no rate, and the caller gets 503
     * EXCHANGE_RATE_UNAVAILABLE rather than a fabricated conversion.
     */
    async exchangeRate() {
      const rate = await exchange.get();
      // The modal converts a USD amount into KES.
      return {
        base: rate.base,
        quote: rate.quote,
        pair: rate.pair,
        rate: rate.rate,
        usd_to_kes: rate.rate,
        provider: rate.provider,
        source: rate.source,
        source_url: rate.sourceUrl,
        as_of: rate.asOf,
        updated_at: rate.asOf,
        fetched_at: rate.fetchedAt,
        cached: !!rate.cached,
        stale: !!rate.stale,
        warning: rate.warning || null,
      };
    },

    /** POST /api/auth/mpesa/stk-push */
    async mpesaStkPush(ctx) {
      const user = await requireUser(ctx);
      limit(`mpesa:${user.id}`);

      // The client's amount field is USD; M-Pesa settles in KES.
      const amountUsd = validateAmount(ctx.body.amount, LIMITS.maxMpesaUsd);
      const msisdn = normaliseMsisdn(ctx.body.phone || ctx.body.phone_number || ctx.body.msisdn);

      const replay = await replayDeposit(user, ctx.body.idempotency_key);
      if (replay) return { replay: true, deposit: publicDeposit(replay), status: replay.status };

      if (!cfg.daraja.configured) {
        throw providerNotConfigured(
          "Daraja (M-Pesa)",
          // Say which switch is missing when it is the production opt-in, rather
          // than listing credentials that are in fact present.
          cfg.daraja.blocked && cfg.daraja.environment === "production"
            ? cfg.daraja.requiredEnv.concat(["DARAJA_ALLOW_PRODUCTION=1"])
            : cfg.daraja.requiredEnv,
          // The environment is not a secret, and a refusal that does not say
          // which environment it refused is hard to act on. The *reason* is the
          // inconsistency itself — never a credential.
          { environment: cfg.daraja.environment, reason: cfg.daraja.blockedReason || "credentials missing" }
        );
      }

      // A KES charge cannot be issued without a rate, so an unavailable feed
      // blocks the deposit instead of guessing a conversion.
      const rate = await exchange.get();
      const settlementAmount = Math.round(amountUsd * rate.rate);

      // Intent first, provider second — never the other way round.
      const deposit = await recordPendingDeposit(user, {
        method: "mpesa",
        amountUsd,
        // Stamped at intent time, from the configuration that is actually in
        // force. A sandbox deposit must never look like a real one later.
        environment: cfg.daraja.environment,
        // Masked at intent time: the full number is sent to Daraja and kept
        // nowhere. It is what makes a provider failure diagnosable afterwards.
        msisdnMasked: maskMsisdn(msisdn),
        settlement: { currency: "KES", amount: settlementAmount, rate: rate.rate, rateAt: rate.fetchedAt },
      });
      await rememberKey(user, ctx.body.idempotency_key, deposit);

      let ack;
      try {
        ack = await withTimeout(
          providers.darajaStkPush({
            amount: settlementAmount,
            currency: "KES",
            msisdn,
            accountReference: deposit.reference,
            description: "StrategyOption deposit",
            callbackUrl: cfg.daraja.callbackUrl,
          }),
          cfg.daraja.timeoutMs,
          "Daraja"
        );
      } catch (err) {
        await failDeposit(deposit, err);
        throw err;
      }

      const acknowledged = await store.updateDeposit(deposit.id, {
        checkout_request_id: ack.CheckoutRequestID || null,
        merchant_request_id: ack.MerchantRequestID || null,
        provider_reference: ack.CheckoutRequestID || null,
      });
      Object.assign(deposit, acknowledged || {});

      // An accepted STK Push is not a payment. The wallet is credited only from
      // a verified settlement — never here, and never from the browser.
      return {
        deposit: publicDeposit(deposit),
        status: "pending",
        message: "STK Push sent. Approve the prompt on your phone; the deposit credits once the payment is verified.",
      };
    },

    /**
     * POST /api/auth/mpesa/callback/:token
     *
     * Daraja's result notification. This route cannot require a Bearer token —
     * Safaricom has none to send — so it is authenticated two other ways:
     *
     *   - the path carries a secret token that only a configured deployment has,
     *     and the comparison is constant-time;
     *   - the `CheckoutRequestID` must match a deposit THIS server created. A
     *     callback naming an id we never issued creates nothing.
     *
     * Even then the body is not trusted as proof of payment. `settleDeposit`
     * still enforces the currency and the amount, and it credits exactly once, so
     * a replayed or forged callback cannot top up a wallet twice. Anything that
     * cannot be verified leaves the deposit pending for reconciliation.
     */
    async mpesaCallback(ctx) {
      const configuredToken = cfg.daraja.callbackToken;
      if (!configuredToken) {
        throw providerNotConfigured("The M-Pesa result callback", ["DARAJA_CALLBACK_TOKEN"]);
      }
      if (!safeEqual(ctx.params?.token || "", configuredToken)) {
        throw forbidden("Unknown callback token");
      }

      // Daraja's envelope: { Body: { stkCallback: { ... } } }
      const stk = ctx.body?.Body?.stkCallback;
      if (!stk || typeof stk.CheckoutRequestID !== "string") {
        throw badRequest("Malformed M-Pesa callback");
      }

      const entry = {
        id: reference("cbk"),
        checkout_request_id: stk.CheckoutRequestID,
        merchant_request_id: stk.MerchantRequestID || null,
        result_code: stk.ResultCode == null ? null : Number(stk.ResultCode),
        result_desc: stk.ResultDesc || null,
        received_at: new Date().toISOString(),
        outcome: null,
        payload: ctx.body,
      };

      /** Records the delivery once, with the outcome it ended up having. */
      const recordCallback = async (outcome, extra = {}) => {
        Object.assign(entry, extra, { outcome });
        await store.insertMpesaCallback(entry);
      };

      const deposit = await store.findDepositByCheckoutId(stk.CheckoutRequestID);

      // Not one of ours: acknowledge so Safaricom stops retrying, record it, and
      // create nothing. A deposit is only ever born from an authenticated
      // request by a signed-in user.
      if (!deposit) {
        await recordCallback("unknown_checkout");
        return { ResultCode: 0, ResultDesc: "Accepted" };
      }

      entry.deposit_reference = deposit.reference;
      entry.user_id = deposit.user_id;

      // Any non-zero code — the user cancelled, the SIM timed out, the balance
      // was short — means no money moved. Record it and fail the intent; a
      // failed deposit can never later be settled.
      if (entry.result_code !== 0) {
        // Fail it ONLY while it is still pending.
        //
        // Safaricom delivers results seconds apart, retries them, and is not
        // ordered: a non-zero result can legitimately arrive after a zero one
        // has already settled this same deposit. Letting that write land would
        // flip a paid deposit to `failed` with the money still sitting in the
        // ledger — the record and the ledger disagreeing is the one state a
        // reconciliation cannot untangle, and the depositor is shown "failed"
        // for a payment their own handset confirms they made. The guard is
        // inside the statement, so it cannot lose a race with a settlement.
        const failed = await store.failDepositIfUnsettled(deposit.id, {
          mpesa_result_code: entry.result_code,
          failure_reason: stk.ResultDesc || `MPESA_RESULT_${entry.result_code}`,
          status: "failed",
        });
        await recordCallback(
          failed ? "not_paid" : "ignored_after_settlement",
          failed
            ? {}
            : { settlement_error: "a non-zero result arrived for a deposit that was already settled" }
        );
        return { ResultCode: 0, ResultDesc: "Accepted" };
      }

      const items = stk.CallbackMetadata?.Item;
      const item = (name) =>
        Array.isArray(items) ? items.find((i) => i && i.Name === name)?.Value : undefined;
      const receipt = item("MpesaReceiptNumber");
      const amount = item("Amount");

      // ResultCode 0 with no receipt is not a verified payment, so it stays
      // pending rather than crediting on a claim.
      if (!receipt || amount == null) {
        await recordCallback("missing_metadata");
        return { ResultCode: 0, ResultDesc: "Accepted" };
      }

      try {
        const settlement = await settleDeposit({
          reference: deposit.reference,
          providerReference: String(receipt),
          verifiedAmount: Number(amount),
          currency: "KES",
        });
        await recordCallback(settlement.credited ? "credited" : settlement.reason || "already_settled", {
          mpesa_receipt: String(receipt),
        });
      } catch (err) {
        // Never answer Daraja with an error: a 4xx/5xx invites a retry storm, and
        // the money question is unresolved either way. Record why and leave the
        // deposit pending for reconciliation.
        await recordCallback("settlement_refused", {
          settlement_error: err?.code || String((err && err.message) || err),
        });
      }

      // The only body Daraja needs. Nothing internal is echoed back.
      return { ResultCode: 0, ResultDesc: "Accepted" };
    },

    /** POST /api/auth/card/deposit */
    async cardDeposit(ctx) {
      const user = await requireUser(ctx);
      limit(`card:${user.id}`);

      const amountUsd = validateAmount(ctx.body.amount, LIMITS.maxCardUsd);
      // Validate both client shapes, keep last4/brand, discard the rest.
      const card = validateCardFields(readCardFields(ctx.body));

      const replay = await replayDeposit(user, ctx.body.idempotency_key);
      if (replay) return { replay: true, deposit: publicDeposit(replay), status: replay.status };

      if (!cfg.card.configured) {
        throw providerNotConfigured("Card payments", cfg.card.requiredEnv);
      }

      const deposit = await recordPendingDeposit(user, {
        method: "card",
        amountUsd,
        settlement: { currency: "USD", amount: amountUsd },
      });
      await rememberKey(user, ctx.body.idempotency_key, deposit);

      let intent;
      try {
        intent = await withTimeout(
          providers.cardCharge({
            amount: amountUsd,
            currency: "USD",
            reference: deposit.reference,
            // The PAN would go straight to the processor from the client; it is
            // never routed through, or stored by, this server.
            returnUrl: cfg.card.returnUrl,
          }),
          cfg.card.timeoutMs,
          "card processor"
        );
      } catch (err) {
        await failDeposit(deposit, err);
        throw err;
      }

      const paymentIntentId = intent.id || null;
      await store.updateDeposit(deposit.id, { provider_reference: paymentIntentId });
      deposit.payment_intent_id = paymentIntentId;
      deposit.provider_reference = paymentIntentId;

      // A payment intent is not a payment: the processor confirms the charge
      // (by webhook or server-side verification), and only then does
      // settleDeposit credit the wallet.
      return {
        deposit: publicDeposit(deposit),
        status: "pending",
        card: { brand: card.brand, last4: card.last4 },
        next_action: intent.next_action || null,
        message: "Payment intent created. The deposit credits once the processor confirms the charge.",
      };
    },

    /**
     * GET /api/auth/trc20/my-address
     *
     * One address per account, cached indefinitely, with concurrent requests
     * sharing a single allocation. The client used to fire this in an unbounded
     * loop from one modal open (fixed in client-patches.mjs); the cache here
     * means even a client that ignores the fix still cannot be handed two
     * different addresses.
     */
    async trc20Address(ctx) {
      const user = await requireUser(ctx);

      // A cached address costs nothing, so it must not consume the rate limit.
      // When an operator wallet is configured it is the source of truth, so a
      // cache entry for a *different* address is stale and must not be served:
      // re-pointing the wallet has to reach accounts that already have one.
      const existing = await store.getTrc20Address(user.id);
      if (existing && (!cfg.tron.depositAddress || existing.address === cfg.tron.depositAddress)) {
        return { ...existing, cached: true };
      }

      addressLimit(`trc20:${user.id}`);

      if (!cfg.tron.configured) {
        // We will not invent an address and label it as a deposit address.
        throw providerNotConfigured("TRC20 wallet", cfg.tron.requiredEnv);
      }

      const inFlight = allocations.get(user.id);
      if (inFlight) return inFlight;

      const allocation = (async () => {
        const granted = await withTimeout(
          providers.tronDepositAddress({ userId: user.id, asset: "USDT", network: "TRC20" }),
          cfg.tron.timeoutMs,
          "TRC20 custody provider"
        );
        if (!granted || !granted.address) {
          throw new ApiError(502, "PROVIDER_BAD_RESPONSE", "The custody provider did not return a deposit address");
        }
        const record = {
          address: String(granted.address),
          asset: "USDT",
          network: granted.network || "TRC20",
          provider: cfg.tron.provider || granted.source || null,
          assigned_at: new Date().toISOString(),
        };
        await store.setTrc20Address(user.id, record);
        return { ...record, cached: false };
      })();

      allocations.set(user.id, allocation);
      try {
        return await allocation;
      } finally {
        allocations.delete(user.id);
      }
    },

    /** GET /api/auth/deposits — the authenticated status the client polls. */
    async listDeposits(ctx) {
      const user = await requireUser(ctx);
      const deposits = (await store.listDepositsByUser(user.id)).map(publicDeposit);
      return { deposits };
    },

    /** GET /api/auth/deposits/:reference — ownership enforced. */
    async depositStatus(ctx) {
      const user = await requireUser(ctx);
      const deposit = await store.findDeposit(ctx.params.reference);
      if (!deposit) throw notFound("Unknown deposit reference");
      if (deposit.user_id !== user.id) throw forbidden("That deposit belongs to another account");
      return { deposit: publicDeposit(deposit) };
    },

    /** Exposed for the settlement tests only — not routed over HTTP. */
    _settleDeposit: settleDeposit,
    _limit: limit,
    /**
     * Reconciliation, deliberately NOT a route.
     *
     * Nothing about it is reachable over HTTP: a public "reconcile now" endpoint
     * would let anyone make this server hammer Safaricom. The server starts its
     * interval, tools/reconcile.mjs drives it by hand from a shell that already
     * holds the database credentials, and the tests call it directly.
     */
    _reconcile: reconciler,
  };
}
