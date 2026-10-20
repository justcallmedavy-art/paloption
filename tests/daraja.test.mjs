/**
 * Daraja client tests.
 *
 * Everything runs against a stand-in HTTP server that speaks Daraja's three
 * endpoints, so no test touches Safaricom or the network. What is asserted is
 * the wire format the real API requires — the password construction, the
 * timestamp timezone, the Buy Goods vs PayBill field, and that a provider
 * refusal is never dressed up as a successful push.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createDarajaClient,
  DarajaError,
  darajaTimestamp,
  stkPassword,
  darajaTransactionType,
  isBuyGoods,
  darajaBaseUrl,
  DARAJA_SANDBOX,
  DARAJA_PRODUCTION,
} from "../tools/daraja.mjs";

/* --------------------------- pure helpers --------------------------- */

describe("Daraja request construction", () => {
  test("the timestamp is East Africa Time, not the host's clock", () => {
    // 21:30:45 UTC is 00:30:45 the NEXT day in Nairobi (UTC+3, no DST).
    assert.equal(darajaTimestamp(new Date("2026-10-14T21:30:45Z")), "20261015003045");
    assert.equal(darajaTimestamp(new Date("2026-01-02T03:04:05Z")), "20260102060405");
    assert.equal(darajaTimestamp(new Date("2026-06-30T21:00:00Z")), "20260701000000");
    assert.match(darajaTimestamp(), /^\d{14}$/, "a fixed 14-digit shape with no timezone suffix");
  });

  test("the password is base64 of shortcode + passkey + timestamp, concatenated", () => {
    const password = stkPassword("174379", "passkey-fixture", "20261015003045");
    assert.equal(Buffer.from(password, "base64").toString("utf8"), "174379passkey-fixture20261015003045");
  });

  test("a till is Buy Goods and a paybill is PayBill — one field apart", () => {
    assert.equal(darajaTransactionType("buygoods"), "CustomerBuyGoodsOnline");
    assert.equal(darajaTransactionType("paybill"), "CustomerPayBillOnline");
    assert.equal(darajaTransactionType(undefined), "CustomerPayBillOnline", "paybill is the default");

    for (const value of ["buygoods", "BUY_GOODS", "buy-goods", "till", " Till "]) {
      assert.ok(isBuyGoods(value), `${value} should read as a till`);
    }
    for (const value of ["", "paybill", "paybill-online", undefined]) {
      assert.ok(!isBuyGoods(value), `${value} should not read as a till`);
    }
  });

  test("the two environments map to the two hosts", () => {
    assert.equal(darajaBaseUrl("sandbox"), DARAJA_SANDBOX);
    assert.equal(darajaBaseUrl("production"), DARAJA_PRODUCTION);
    assert.equal(darajaBaseUrl("anything-else"), DARAJA_SANDBOX, "sandbox is the safe default");
  });
});

/* ------------------------- client over the wire ------------------------- */

/** A stand-in for Safaricom: the three endpoints, nothing else. */
function fakeDaraja({ oauthStatus = 200, pushResponse, queryResponse } = {}) {
  const seen = { tokens: 0, oauthAuth: null, pushes: [], queries: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;

    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.url.startsWith("/oauth/v1/generate")) {
      seen.tokens += 1;
      seen.oauthAuth = req.headers.authorization;
      seen.grantType = new URL(req.url, "http://x").searchParams.get("grant_type");
      if (oauthStatus !== 200) {
        return json(oauthStatus, { errorCode: "404.001.03", errorMessage: "Invalid Access Token" });
      }
      return json(200, { access_token: "AT_fixture", expires_in: 3599 });
    }

    if (req.url === "/mpesa/stkpush/v1/processrequest") {
      seen.pushes.push({ body, auth: req.headers.authorization, contentType: req.headers["content-type"] });
      return json(200, pushResponse || {
        MerchantRequestID: "mr_1",
        CheckoutRequestID: "ws_CO_1",
        ResponseCode: "0",
        ResponseDescription: "Success. Request accepted for processing",
        CustomerMessage: "Success. Request accepted for processing",
      });
    }

    if (req.url === "/mpesa/stkpushquery/v1/query") {
      seen.queries.push({ body, auth: req.headers.authorization });
      return json(200, queryResponse || {
        ResponseCode: "0",
        ResultCode: "0",
        ResultDesc: "The service request is processed successfully.",
      });
    }

    json(404, { errorMessage: `no such endpoint: ${req.url}` });
  });
  return { server, seen };
}

describe("the Daraja client", () => {
  let fake;
  let baseUrl;

  before(async () => {
    fake = fakeDaraja();
    await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${fake.server.address().port}`;
  });

  after(() => fake.server.close());

  const client = (overrides = {}) =>
    createDarajaClient({
      environment: "sandbox",
      baseUrl,
      consumerKey: "fixture-key",
      consumerSecret: "fixture-secret",
      shortcode: "174379",
      passkey: "passkey-fixture",
      now: () => new Date("2026-10-14T21:30:45Z"),
      ...overrides,
    });

  test("authorises with Basic credentials and reuses the token", async () => {
    fake.seen.tokens = 0;
    const c = client();
    const request = { amount: 10, msisdn: "254708374149", callbackUrl: "https://example.test/cb" };

    await c.stkPush({ ...request, accountReference: "PAL_1" });
    await c.stkPush({ ...request, accountReference: "PAL_2" });

    assert.equal(fake.seen.tokens, 1, "the token is cached, not refetched per prompt");
    assert.equal(
      fake.seen.oauthAuth,
      `Basic ${Buffer.from("fixture-key:fixture-secret").toString("base64")}`,
      "consumer key and secret travel as HTTP Basic"
    );
    assert.equal(fake.seen.grantType, "client_credentials");
    assert.equal(fake.seen.pushes[1].auth, "Bearer AT_fixture", "the push carries the bearer token");
    assert.equal(fake.seen.pushes[1].contentType, "application/json");
  });

  test("a till sends Buy Goods with the till in PartyB", async () => {
    const c = client({ transactionType: "buygoods", partyB: "880100" });
    await c.stkPush({
      amount: 1300,
      msisdn: "254708374149",
      accountReference: "PAL_till",
      description: "StrategyOption deposit",
      callbackUrl: "https://example.test/cb",
    });

    const sent = fake.seen.pushes.at(-1).body;
    assert.equal(sent.TransactionType, "CustomerBuyGoodsOnline");
    assert.equal(sent.PartyB, "880100", "the till number, not the paybill");
    assert.equal(sent.BusinessShortCode, "174379");
    assert.equal(sent.PartyA, "254708374149");
    assert.equal(sent.PhoneNumber, "254708374149");
    assert.equal(sent.Amount, 1300);
    assert.equal(sent.CallBackURL, "https://example.test/cb");
    assert.equal(sent.Timestamp, "20261015003045");

    // The password must be built from exactly the timestamp that was sent.
    assert.equal(
      Buffer.from(sent.Password, "base64").toString("utf8"),
      `174379passkey-fixture${sent.Timestamp}`
    );
  });

  test("a paybill sends PayBill with the shortcode in PartyB", async () => {
    const c = client({ transactionType: "paybill" });
    await c.stkPush({ amount: 5, msisdn: "254708374149", callbackUrl: "https://example.test/cb" });
    const sent = fake.seen.pushes.at(-1).body;
    assert.equal(sent.TransactionType, "CustomerPayBillOnline");
    assert.equal(sent.PartyB, "174379");
  });

  test("amounts are whole shillings, and the field limits are respected", async () => {
    const c = client();
    await c.stkPush({
      amount: 12.6,
      msisdn: "254708374149",
      callbackUrl: "https://example.test/cb",
      accountReference: "a-very-long-account-reference",
      description: "a description that is far too long",
    });
    const sent = fake.seen.pushes.at(-1).body;
    assert.equal(sent.Amount, 13, "M-Pesa takes whole shillings");
    assert.ok(sent.AccountReference.length <= 12, "AccountReference is capped at 12");
    assert.ok(sent.TransactionDesc.length <= 13, "TransactionDesc is capped at 13");

    await assert.rejects(
      () => c.stkPush({ amount: 0.4, msisdn: "254708374149", callbackUrl: "https://x.test/cb" }),
      (e) => e instanceof DarajaError && e.code === "DARAJA_AMOUNT_INVALID"
    );
  });

  test("an accepted request is returned as an acknowledgement, not a payment", async () => {
    const c = client();
    const ack = await c.stkPush({ amount: 10, msisdn: "254708374149", callbackUrl: "https://example.test/cb" });
    assert.equal(ack.CheckoutRequestID, "ws_CO_1");
    assert.equal(ack.MerchantRequestID, "mr_1");
    // Nothing in the acknowledgement claims money moved.
    assert.equal(ack.ResultCode, undefined);
    assert.equal(ack.status, undefined);
  });

  test("a callback URL is mandatory before a prompt is sent", async () => {
    await assert.rejects(
      () => client().stkPush({ amount: 10, msisdn: "254708374149" }),
      (e) => e instanceof DarajaError && e.code === "DARAJA_CALLBACK_MISSING" && e.status === 503
    );
  });

  test("the STK query reconciles a checkout id", async () => {
    const c = client();
    const result = await c.stkQuery({ checkoutRequestId: "ws_CO_1" });
    assert.equal(result.ResultCode, "0");
    const sent = fake.seen.queries.at(-1).body;
    assert.equal(sent.CheckoutRequestID, "ws_CO_1");
    assert.equal(sent.BusinessShortCode, "174379");
    assert.equal(Buffer.from(sent.Password, "base64").toString("utf8"), `174379passkey-fixture${sent.Timestamp}`);
  });

  test("an authorisation failure is coded, and never carries the credentials", async () => {
    const refusing = fakeDaraja({ oauthStatus: 401 });
    await new Promise((r) => refusing.server.listen(0, "127.0.0.1", r));
    try {
      const c = client({ baseUrl: `http://127.0.0.1:${refusing.server.address().port}` });
      const err = await c.stkPush({ amount: 10, msisdn: "254708374149", callbackUrl: "https://example.test/cb" }).catch((e) => e);
      assert.ok(err instanceof DarajaError);
      assert.equal(err.code, "DARAJA_AUTH_FAILED");
      assert.equal(err.details.provider_message, "Invalid Access Token");
      assert.ok(!JSON.stringify(err.details).includes("fixture-secret"), "the secret must not surface");
      assert.ok(!JSON.stringify(err.details).includes("fixture-key"), "nor the consumer key");
    } finally {
      refusing.server.close();
    }
  });

  test("a rejected prompt is an error, even when Daraja answers 200", async () => {
    const rejected = fakeDaraja({
      pushResponse: { ResponseCode: "1", ResponseDescription: "The initiator information is invalid", errorCode: "400.002.02" },
    });
    await new Promise((r) => rejected.server.listen(0, "127.0.0.1", r));
    try {
      const c = client({ baseUrl: `http://127.0.0.1:${rejected.server.address().port}` });
      const err = await c.stkPush({ amount: 10, msisdn: "254708374149", callbackUrl: "https://example.test/cb" }).catch((e) => e);
      assert.ok(err instanceof DarajaError);
      assert.equal(err.code, "DARAJA_REJECTED", "ResponseCode 1 is not a sent prompt");
      assert.equal(err.details.provider_message, "The initiator information is invalid");

      // The password is in the request we sent, and must not come back out.
      assert.ok(!JSON.stringify(err.details).includes("passkey-fixture"));
      assert.equal(err.details.password, undefined);
    } finally {
      rejected.server.close();
    }
  });

  test("an unreachable host is reported as unreachable, not as a sent prompt", async () => {
    const c = client({ baseUrl: "http://127.0.0.1:1", timeoutMs: 500 });
    const err = await c.stkPush({ amount: 10, msisdn: "254708374149", callbackUrl: "https://example.test/cb" }).catch((e) => e);
    assert.ok(err instanceof DarajaError);
    assert.equal(err.code, "DARAJA_UNREACHABLE");
    assert.equal(err.status, 502);
  });

  test("production selects the production host", () => {
    assert.equal(createDarajaClient({ environment: "production" }).baseUrl, DARAJA_PRODUCTION);
    assert.equal(createDarajaClient({ environment: "sandbox" }).baseUrl, DARAJA_SANDBOX);
  });
});
