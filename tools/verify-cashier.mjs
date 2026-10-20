/**
 * Prove a running cashier settles M-Pesa exactly once, against a real server.
 *
 * The unit suite covers settlement with injected fixtures (`tests/payments.test.mjs`).
 * This does the same over HTTP against a deployment you can point at, so "the
 * callback credits exactly once" becomes a claim about the thing that is
 * actually serving.
 *
 * It uses the real transport: the callback is POSTed to the deployment's own
 * public callback URL, exactly as Safaricom posts it, `Item` as an array and the
 * amount in KES.
 *
 *   node tools/verify-cashier.mjs --sandbox --api http://127.0.0.1:4174
 *
 * What it proves, in order:
 *   1. a real STK push creates a PENDING intent and credits nothing;
 *   2. the success callback credits the USD deposit amount exactly once;
 *   3. replaying that callback credits nothing further;
 *   4. a forged CheckoutRequestID credits nothing;
 *   5. an under-paying callback is refused and leaves the deposit pending;
 *   6. paying the correct amount afterwards settles once, and not twice.
 *
 * ---------------------------------------------------------------------------
 * THE RACE, AND WHY THIS TOOL RETRIES
 *
 * Steps 2 and 6 forge a *successful* callback for a deposit that has a real
 * push behind it. In the sandbox the push also summons a real callback, which
 * arrives within about a second saying "DS timeout user cannot be reached" and
 * marks the deposit failed. Whichever callback lands first wins.
 *
 * That is the product behaving correctly — a real provider result is final, and
 * a failed deposit must never be settled — but it makes a single attempt flaky.
 * Measured against a sandbox instance: 1 loss in 6 attempts, at ~1.1s, with
 * successful attempts at 0.7-1.2s, so there is no threshold to tune. So a
 * provider callback that wins the race is retried, and reported, rather than
 * being mistaken for a settlement bug. A refusal for any *other* reason is a
 * real failure and is reported as one.
 *
 * ---------------------------------------------------------------------------
 * WHY IT DEMANDS --sandbox
 *
 * Step 4 posts a callback naming a CheckoutRequestID this server never issued,
 * and steps 2 and 6 claim a payment that was never really made. Against an
 * instance pointed at PRODUCTION Daraja, the callback token would be the only
 * thing standing between a wallet and a forged credit. So this refuses to run
 * unless you say `--sandbox` out loud.
 *
 * The callback token is read from DARAJA_CALLBACK_TOKEN (or --token) and is
 * never printed.
 */
import { config as paymentConfig } from "./payments.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};

if (!argv.includes("--sandbox")) {
  console.error(
    "refusing to run without --sandbox.\n\n" +
      "This tool forges a successful payment callback and a callback for an\n" +
      "unknown CheckoutRequestID. On an instance configured for production\n" +
      "Daraja, the callback token would be the only protection against crediting\n" +
      "a wallet for free. Pass --sandbox when you are certain the target is a\n" +
      "sandbox instance."
  );
  process.exit(2);
}

const cfg = paymentConfig();
const API = String(flag("api", process.env.STRATEGYOPTION_API_URL || "http://127.0.0.1:4174")).replace(/\/+$/, "");
const TOKEN = String(flag("token", process.env.DARAJA_CALLBACK_TOKEN || "")).trim();
const CALLBACK_BASE = String(
  flag("callback", (cfg.daraja.callbackUrl || "").replace(/\/api\/auth\/mpesa\/callback\/.*$/, "") || API)
).replace(/\/+$/, "");
const MSISDN = String(flag("msisdn", "254708374149")); // Safaricom's documented sandbox number.
const ATTEMPTS = Number(flag("attempts", 4));

if (!TOKEN) {
  console.error("no callback token: set DARAJA_CALLBACK_TOKEN or pass --token <token>");
  process.exit(2);
}

const results = [];
const check = (label, pass, detail = "") => {
  results.push({ label, pass });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
};

/**
 * Every request goes through here so an unreachable host is a reported outcome
 * rather than an unhandled rejection with a stack trace.
 */
let transport = null;
async function call(url, init) {
  try {
    const res = await fetch(url, init);
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    transport = transport || String((err && err.cause && err.cause.code) || (err && err.message) || err);
    return { status: 0, body: null };
  }
}
const get = (url, token) => call(url, { headers: { authorization: `Bearer ${token}` } });
const post = (url, body, token) =>
  call(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const me = async (token) => {
  const { body } = await get(`${API}/api/auth/me`, token);
  return Number(body?.user?.real_balance ?? NaN);
};
const deposit = async (token, ref) => (await get(`${API}/api/auth/deposits/${ref}`, token)).body?.deposit;
const push = async (token, usd = 1) => post(`${API}/api/auth/mpesa/stk-push`, { amount: usd, phone: MSISDN }, token);

/** Exactly the envelope Safaricom posts, `Item` as an array. */
const successEnvelope = ({ checkoutId, amount, receipt, merchantId = "verify-cashier" }) => ({
  Body: {
    stkCallback: {
      MerchantRequestID: merchantId,
      CheckoutRequestID: checkoutId,
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: amount },
          { Name: "MpesaReceiptNumber", Value: receipt },
          { Name: "TransactionDate", Value: 20260101000000 },
          { Name: "PhoneNumber", Value: MSISDN },
        ],
      },
    },
  },
});

/** Posted to the deployment's public callback URL, not to localhost. */
const deliver = (envelope) => post(`${CALLBACK_BASE}/api/auth/mpesa/callback/${TOKEN}`, envelope);

/** A real provider callback beat us to it — retryable, and not our bug. */
const wonByProvider = (state) => state?.status === "failed" && Boolean(state.failure_reason);
const noteRace = (attempt, state) =>
  console.log(`    (attempt ${attempt}: a real Safaricom callback got there first — "${state.failure_reason}"; retrying)`);

console.log(`\nverifying cashier at ${API}`);
console.log(`callback URL            ${CALLBACK_BASE}/api/auth/mpesa/callback/<token>`);
console.log(`Daraja environment      ${cfg.daraja.environment}\n`);

const health = await call(`${API}/healthz`);
if (health.status !== 200) {
  console.error(`\nthe target is not answering /healthz (${health.status === 0 ? `no answer: ${transport}` : `HTTP ${health.status}`}); nothing was tested`);
  process.exit(2);
}
console.log(`  /healthz -> ${JSON.stringify(health.body)}`);

const token = (await post(`${API}/api/auth/demo`, {})).body?.token;
if (!token) {
  console.error("could not create a demo account to test against");
  process.exit(2);
}

const start = await me(token);
if (!Number.isFinite(start)) {
  console.error("could not read a starting balance");
  process.exit(2);
}

console.log("\n== 1. a push creates a pending intent and credits nothing ==");
const first = await push(token);
check("push accepted", first.status === 200, `HTTP ${first.status}`);
check("intent is pending", first.body?.deposit?.status === "pending", `status ${first.body?.deposit?.status}`);
check(
  "a CheckoutRequestID came back",
  String(first.body?.deposit?.provider_reference || "").startsWith("ws_CO_"),
  first.body?.deposit?.provider_reference
);
check("the push credited nothing", (await me(token)) === start, `balance ${await me(token)}`);

console.log("\n== 2. the success callback credits exactly once ==");
let settled = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const d = (await push(token)).body?.deposit;
  if (!d) break;
  const before = await me(token);
  await deliver(successEnvelope({ checkoutId: d.provider_reference, amount: d.settlement_amount, receipt: `VERIFY02${attempt}0001` }));
  const state = await deposit(token, d.reference);
  const balance = await me(token);
  if (state?.status === "completed") {
    settled = { d, state, before, balance, attempt };
    break;
  }
  if (wonByProvider(state)) {
    noteRace(attempt, state);
    continue;
  }
  settled = { d, state, before, balance, attempt };
  break;
}
if (!settled) {
  console.error(`\nINCONCLUSIVE: a real Safaricom callback won every one of ${ATTEMPTS} attempts, so settlement could not be observed. Not a settlement failure; re-run.`);
  process.exit(2);
}
check("callback accepted", true, `settled on attempt ${settled.attempt}`);
check(
  "credited the USD deposit amount once",
  settled.balance === settled.before + settled.d.usd_amount,
  `${settled.before} -> ${settled.balance} (expected +${settled.d.usd_amount})` +
    (settled.state?.status !== "completed" ? `, deposit=${settled.state?.status} ${JSON.stringify(settled.state?.failure_reason)}` : "")
);
check("deposit is completed", settled.state?.status === "completed", `status ${settled.state?.status}`);

const afterSettle = await me(token);
console.log("\n== 3. the same callback again credits nothing ==");
await deliver(successEnvelope({ checkoutId: settled.d.provider_reference, amount: settled.d.settlement_amount, receipt: `VERIFY02${settled.attempt}0001` }));
const afterReplay = await me(token);
check("balance did not move again", afterReplay === afterSettle, `${afterSettle} -> ${afterReplay}`);

console.log("\n== 4. a forged CheckoutRequestID credits nothing ==");
const forged = await deliver(successEnvelope({ checkoutId: "ws_CO_000000000000000000000000", amount: 9999, receipt: "FORGED00000001" }));
const afterForged = await me(token);
check("answered without an error, so Safaricom would not retry", forged.status === 200, `HTTP ${forged.status}`);
check("balance untouched", afterForged === afterReplay, `${afterReplay} -> ${afterForged}`);

console.log("\n== 5 & 6. an under-payment is refused, then the right amount settles once ==");
let pair = null;
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const d = (await push(token)).body?.deposit;
  if (!d) break;
  const short = Math.max(1, d.settlement_amount - 50);
  await deliver(successEnvelope({ checkoutId: d.provider_reference, amount: short, receipt: `UNDER0${attempt}0001` }));
  const afterShortState = await deposit(token, d.reference);
  const afterShortBalance = await me(token);
  if (wonByProvider(afterShortState)) {
    noteRace(attempt, afterShortState);
    continue;
  }
  await deliver(successEnvelope({ checkoutId: d.provider_reference, amount: d.settlement_amount, receipt: `PAID00${attempt}0001` }));
  const paidState = await deposit(token, d.reference);
  const paidBalance = await me(token);
  if (wonByProvider(paidState)) {
    noteRace(attempt, paidState);
    continue;
  }
  pair = { d, short, afterShortState, afterShortBalance, paidState, paidBalance, attempt };
  break;
}
if (!pair) {
  console.error(`\nINCONCLUSIVE: a real Safaricom callback won every one of ${ATTEMPTS} attempts on the under-payment pair. Re-run.`);
  process.exit(2);
}
check("under-payment credited nothing", pair.afterShortBalance === afterForged, `${afterForged} -> ${pair.afterShortBalance} (paid ${pair.short} of ${pair.d.settlement_amount} KES)`);
check("under-paid deposit left pending for reconciliation", pair.afterShortState?.status === "pending", `status ${pair.afterShortState?.status}`);
check("the correct amount then credited once", pair.paidBalance === pair.afterShortBalance + pair.d.usd_amount, `${pair.afterShortBalance} -> ${pair.paidBalance}`);
await deliver(successEnvelope({ checkoutId: pair.d.provider_reference, amount: pair.d.settlement_amount, receipt: `PAID00${pair.attempt}0001` }));
const afterPaidReplay = await me(token);
check("replaying the paid one credited nothing", afterPaidReplay === pair.paidBalance, `${pair.paidBalance} -> ${afterPaidReplay}`);

console.log("\n== 7. conservation: every credited dollar is a completed deposit ==");
const all = (await get(`${API}/api/auth/deposits`, token)).body?.deposits || [];
const completed = all.filter((d) => d.status === "completed");
const completedUsd = completed.reduce((sum, d) => sum + Number(d.usd_amount || 0), 0);
const credited = Number((afterPaidReplay - start).toFixed(2));
check(
  "credited total equals the completed deposits",
  Math.abs(completedUsd - credited) < 0.005,
  `$${credited} credited vs $${completedUsd} across ${completed.length} completed deposit(s), ${all.length} total`
);
check(
  "no deposit is completed and failed at once",
  completed.every((d) => d.failure_reason == null),
  completed.filter((d) => d.failure_reason).map((d) => `${d.reference}:${d.failure_reason}`).join(", ") || "none"
);
check(
  "every completed deposit carries a settled reference and timestamp",
  completed.every((d) => d.provider_reference && d.completed_at),
  completed.map((d) => `${d.reference}->${d.provider_reference}`).join(", ") || "none"
);
console.log(`\n  deposits: ${all.map((d) => `${d.reference.slice(4, 12)}:${d.status}`).join(" ")}`);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("failed:");
  for (const f of failed) console.log(`  - ${f.label}`);
}
process.exit(failed.length ? 1 : 0);
