/**
 * Daraja — the real Safaricom M-Pesa transport (STK Push / Lipa na M-Pesa
 * Online).
 *
 * This is the only module in the project that talks to a payment provider for
 * real, and it is deliberately small and boring: two endpoints plus an OAuth
 * token, no SDK, no dependency. Everything is injectable (`baseUrl`,
 * `fetchImpl`, `now`) so the whole flow can be driven against a stand-in server
 * in tests without touching Safaricom or the network.
 *
 * Three details are easy to get wrong and are the reason this is a module
 * rather than a few lines inline:
 *
 *   1. `Password` is base64 of `shortcode + passkey + timestamp` — concatenated
 *      with no separators — and the `Timestamp` must be the same value, in East
 *      Africa Time. A stale or local-time timestamp is rejected.
 *   2. Buy Goods (a till number) and PayBill differ by exactly one field:
 *      `CustomerBuyGoodsOnline` with the till in `PartyB`. Getting this wrong
 *      produces a valid-looking request that never reaches the merchant.
 *   3. `ResponseCode: "0"` on the request means *accepted for processing*, not
 *      paid. The money question is answered later, by the callback or by a
 *      query. This module never reports a push as a payment.
 *
 * Sources: Safaricom's developer portal (developer.safaricom.co.ke) for the
 * endpoints and the transaction types; see PAYMENTS.md for the exact references
 * and for what is verified versus merely documented.
 */

export const DARAJA_SANDBOX = "https://sandbox.safaricom.co.ke";
export const DARAJA_PRODUCTION = "https://api.safaricom.co.ke";

/** Kenya has no daylight saving, so UTC+3 is exact rather than approximate. */
const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Daraja's documented field limits; exceeding them is a hard rejection. */
const ACCOUNT_REFERENCE_MAX = 12;
const DESCRIPTION_MAX = 13;

export function darajaBaseUrl(environment) {
  return environment === "production" ? DARAJA_PRODUCTION : DARAJA_SANDBOX;
}

/**
 * A provider failure, carrying enough to diagnose it without ever carrying the
 * request body (which contains the password) or the credentials.
 */
export class DarajaError extends Error {
  constructor(message, { code = "DARAJA_ERROR", status = 502, details = {} } = {}) {
    super(message);
    this.name = "DarajaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * `YYYYMMDDHHmmss` in East Africa Time. Computed from UTC rather than the host
 * clock, because a developer laptop set to another timezone would otherwise
 * generate a timestamp Daraja treats as stale.
 */
export function darajaTimestamp(date = new Date()) {
  const t = new Date(date.getTime() + NAIROBI_OFFSET_MS);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}` +
    `${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `${p(t.getUTCHours())}${p(t.getUTCMinutes())}${p(t.getUTCSeconds())}`
  );
}

export function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`, "utf8").toString("base64");
}

/** A till (Buy Goods) and a PayBill differ only by this one string. */
export function darajaTransactionType(kind) {
  return kind === "buygoods" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline";
}

/** Values we accept for "this is a till number, not a paybill". */
export function isBuyGoods(value) {
  return ["buygoods", "buy_goods", "buy-goods", "till", "tillnumber"].includes(
    String(value || "").trim().toLowerCase()
  );
}

export function createDarajaClient({
  environment = "sandbox",
  consumerKey,
  consumerSecret,
  shortcode,
  passkey,
  partyB,
  transactionType = "paybill",
  timeoutMs = 15_000,
  baseUrl,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const base = String(baseUrl || darajaBaseUrl(environment)).replace(/\/+$/, "");
  const type = darajaTransactionType(transactionType);

  /** One token, reused until it is close to expiring. */
  let tokenCache = null;

  async function call(url, init, label) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
      throw new DarajaError(
        timedOut
          ? `The ${label} did not respond within ${timeoutMs}ms.`
          : `The ${label} could not be reached.`,
        {
          code: timedOut ? "DARAJA_TIMEOUT" : "DARAJA_UNREACHABLE",
          status: timedOut ? 504 : 502,
          details: { cause: String((err && err.message) || err) },
        }
      );
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Daraja can answer with an HTML error page; the caller sees null and the
      // status code rather than a JSON parse crash.
    }
    return { ok: res.ok, status: res.status, json, text };
  }

  /** Provider-reported fields only — never the request we sent. */
  function providerFields(status, json) {
    return {
      http_status: status,
      provider_error_code: json?.errorCode ?? null,
      provider_message: json?.errorMessage ?? json?.ResponseDescription ?? json?.ResultDesc ?? null,
      response_code: json?.ResponseCode ?? null,
    };
  }

  async function accessToken() {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 5_000) return tokenCache.token;

    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`, "utf8").toString("base64");
    const res = await call(
      `${base}/oauth/v1/generate?grant_type=client_credentials`,
      { method: "GET", headers: { Authorization: `Basic ${basic}` } },
      "Daraja authorisation"
    );

    const got = res.json?.access_token;
    if (!res.ok || !got) {
      throw new DarajaError("Daraja refused to issue an access token.", {
        code: "DARAJA_AUTH_FAILED",
        status: 502,
        details: providerFields(res.status, res.json),
      });
    }

    const ttlMs = (Number(res.json.expires_in) || 3599) * 1000;
    tokenCache = { token: got, expiresAt: Date.now() + ttlMs };
    return tokenCache.token;
  }

  /**
   * Sends the prompt. Resolves with Daraja's acknowledgement, which is NOT a
   * payment — see the module note. Rejects when Daraja refuses the request.
   */
  async function stkPush({ amount, msisdn, accountReference, description, callbackUrl }) {
    if (!callbackUrl) {
      throw new DarajaError("An M-Pesa result callback URL is required before a prompt can be sent.", {
        code: "DARAJA_CALLBACK_MISSING",
        status: 503,
      });
    }
    const kes = Math.round(Number(amount));
    if (!Number.isFinite(kes) || kes < 1) {
      throw new DarajaError("M-Pesa can only charge a whole number of shillings, at least 1.", {
        code: "DARAJA_AMOUNT_INVALID",
        status: 400,
        details: { amount: Number(amount) },
      });
    }

    const timestamp = darajaTimestamp(now());
    const payload = {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: type,
      Amount: kes,
      PartyA: msisdn,
      PartyB: partyB || shortcode,
      PhoneNumber: msisdn,
      CallBackURL: callbackUrl,
      AccountReference: String(accountReference || "StrategyOption").slice(0, ACCOUNT_REFERENCE_MAX),
      TransactionDesc: String(description || "Deposit").slice(0, DESCRIPTION_MAX),
    };

    const res = await call(
      `${base}/mpesa/stkpush/v1/processrequest`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      "Daraja STK Push"
    );

    // Daraja answers 200 even for a rejected request, so the body decides.
    if (!res.ok || String(res.json?.ResponseCode ?? "") !== "0" || !res.json?.CheckoutRequestID) {
      throw new DarajaError("Daraja did not accept the M-Pesa prompt request.", {
        code: "DARAJA_REJECTED",
        status: 502,
        details: providerFields(res.status, res.json),
      });
    }
    return res.json;
  }

  /** Reconciles a CheckoutRequestID. Used when a callback never arrived. */
  async function stkQuery({ checkoutRequestId }) {
    const timestamp = darajaTimestamp(now());
    const res = await call(
      `${base}/mpesa/stkpushquery/v1/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          BusinessShortCode: shortcode,
          Password: stkPassword(shortcode, passkey, timestamp),
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        }),
      },
      "Daraja STK Query"
    );

    if (!res.ok || !res.json) {
      throw new DarajaError("Daraja could not answer the STK query.", {
        code: "DARAJA_QUERY_FAILED",
        status: 502,
        details: providerFields(res.status, res.json),
      });
    }
    return res.json;
  }

  return {
    baseUrl: base,
    transactionType: type,
    accessToken,
    stkPush,
    stkQuery,
  };
}
