# Deposits — what is real, what is not

This documents the money paths behind the cashier in the mirrored client. Read
the first table before assuming anything works.

## The honest summary

| Capability | State |
| --- | --- |
| Request validation (amount bounds, Kenyan MSISDN, card shape) | **real** |
| Deposit state machine + auditable ledger | **real** |
| Idempotency and settle-exactly-once | **real**, concurrency tested |
| Per-user ownership checks | **real** |
| USD amount vs KES settlement separation | **real** |
| USD/KES exchange rate | **real**, live provider, cached |
| Daraja STK Push | **implemented** — real OAuth, STK Push and STK Query; sandbox or production by config |
| The M-Pesa result callback | **implemented** — token-authenticated, settles through `settleDeposit`, idempotent |
| Card processing | **not integrated** — 503 without credentials, 501 with them |
| TRC20 custody / address allocation | **static operator wallet** — a real address is served; no custodian is contacted |
| Crediting a wallet | **never** without a verified settlement (see below) |

No test contacts a live provider: every provider is either a fixture or, for
Daraja, pointed at a stand-in server that speaks the documented shapes.

Daraja is the one integration that is actually implemented. Nothing here proves
a card processor or a TRON custodian works — those still refuse rather than
pretend — and no live sandbox payment has been completed yet, so treat the
M-Pesa path as **ready to test, not as proven**. See the end of the Daraja
section.

## Why credentials alone are not enough

Each provider is represented by exactly one injectable transport in
[tools/payments.mjs](tools/payments.mjs):

```
providers.darajaStkPush          providers.cardCharge          providers.tronDepositAddress
```

`darajaStkPush` is implemented for real — see the next section. The other two
deliberately **refuse**, so for those there are two distinct outcomes, and they
are not interchangeable:

| Situation | Response |
| --- | --- |
| No credentials | `503 PAYMENT_PROVIDER_NOT_CONFIGURED` (+ `required_env`) |
| Credentials, no integration | `501 PROVIDER_INTEGRATION_MISSING` |

Injecting a transport is also what makes the intent flow testable, so the parts
that *are* real are covered by tests rather than asserted in a comment.

## M-Pesa (Daraja) — implemented

The transport is real: OAuth, STK Push and STK Query live in
[tools/daraja.mjs](tools/daraja.mjs) and are wrapped by
`defaultProviders().darajaStkPush`. Nothing on the way out is stubbed.

### Credentials

Register on the [Safaricom developer portal](https://developer.safaricom.co.ke/),
create an app, and put these in `.env.local` — which is git-ignored and read at
startup by [tools/server.mjs](tools/server.mjs). Never in a tracked file, and
never in the client.

| Variable | Notes |
| --- | --- |
| `DARAJA_CONSUMER_KEY` | app consumer key |
| `DARAJA_CONSUMER_SECRET` | app consumer secret |
| `DARAJA_SHORTCODE` | the business shortcode (paybill or till) |
| `DARAJA_PASSKEY` | Lipa na M-Pesa passkey |
| `DARAJA_CALLBACK_URL` | **publicly reachable HTTPS** URL for the result |
| `DARAJA_CALLBACK_TOKEN` | secret path segment the callback requires |
| `DARAJA_ENV` | `sandbox` (default) or `production` |
| `DARAJA_TRANSACTION_TYPE` | `buygoods` for a till, otherwise paybill |
| `DARAJA_PARTY_B` | the till number, when it differs from the shortcode |
| `DARAJA_TIMEOUT_MS` | default 15000 |
| `DARAJA_BASE_URL` | override the Safaricom host (tests, dry runs) |

The callback URL must be
`${publicOrigin}/api/auth/mpesa/callback/${DARAJA_CALLBACK_TOKEN}`.

### A till is Buy Goods, and that is the whole difference

One field changes: `TransactionType` is `CustomerBuyGoodsOnline` for a till and
`CustomerPayBillOnline` otherwise, with the till number in `PartyB`. Set
`DARAJA_TRANSACTION_TYPE=buygoods` and `DARAJA_PARTY_B=<till>`, or the request is
accepted-looking and never reaches the merchant.

### Sandbox first, then production

`DARAJA_ENV=sandbox` targets `sandbox.safaricom.co.ke`; `production` targets
`api.safaricom.co.ke`. The sandbox shortcode, passkey and test MSISDN are
sandbox-only — production needs the merchant's own shortcode and passkey, from an
app that has been through go-live.

### The callback is public, and that is the risk

Safaricom has no Bearer token to send, so `POST /api/auth/mpesa/callback/:token`
is authenticated two other ways: an unguessable path token, compared in constant
time, and the `CheckoutRequestID` having to match a deposit **this server**
created. Even then the body is not treated as proof of payment. `settleDeposit`
still enforces the settlement currency and amount and credits exactly once, so a
replayed or forged notification cannot top up a wallet twice. An unknown
`CheckoutRequestID`, a `ResultCode` of 0 with no receipt, and an amount below the
deposit all leave the deposit **pending for reconciliation** rather than
crediting.

Any non-zero `ResultCode` (the user cancelled, the SIM timed out) fails the
intent, and a failed deposit can never later be settled. Every delivery is kept
in `db.mpesa_callbacks` with its outcome, including the duplicates.

### Reconciliation: a deposit whose callback never arrived

A callback that never arrives used to be the end of the story: the intent sat
`pending` forever while the customer's money had already moved. `stkQuery`
existed in `tools/daraja.mjs` and was documented as the fix, but **nothing called
it**. That gap is now closed by `tools/reconcile.mjs`.

**The rule: a query is an investigation, not a payment.** Nothing in the
reconciler credits a wallet. It asks Safaricom what happened to a
`CheckoutRequestID` it issued, and then hands the answer to `settleDeposit` —
the same function, with the same currency and amount validation and the same
exactly-once guarantee, that the callback uses. There is no second way into the
ledger.

#### What a real query does, and does not, tell you

The STK query answers with `ResponseCode`, `MerchantRequestID`,
`CheckoutRequestID`, `ResultCode` and `ResultDesc`:

```json
{ "ResponseCode": "0", "ResultCode": "0",
  "ResultDesc": "The service request is processed successfully." }

{ "errorCode": "500.001.1001", "errorMessage": "The transaction is being processed" }
```

Unlike the callback, it does **not** reliably return `CallbackMetadata`, so it
usually carries no receipt number and no amount. (Safaricom's portal pages for
this endpoint render as shells, so this is corroborated by working integrations
rather than vendor-verified — treat the shape as documented, not promised.)

That single fact drives the whole design, and it is why reconciliation is not
allowed to just credit a `ResultCode: 0`:

| What came back | What happens | Why |
|---|---|---|
| `ResultCode: 0` **with** receipt and amount | Settled, credited once | The same verification a callback gets |
| `ResultCode: 0`, **no** metadata | `recon_outcome='paid_pending_receipt'`, stays `pending`, logged as a warning | The money moved, but there is nothing to verify against — crediting here would pay out on a claim |
| Non-zero `ResultCode` — *except* an in-progress one (below) | Failed through the **guarded** transition, nothing credited | Provider-confirmed no payment |
| `ResultCode: 4999`, "The transaction is still under processing" | Left `pending` and retried | **Not decided yet.** Measured live on 2026-10-17: the sandbox query answers exactly this for a deposit whose callback has not arrived. Reading it as a failure would fail an intent the customer may still be approving — and a failed deposit can never be settled, so their real payment would be refused by `settleDeposit` and never credited. The same state is recognised by its description when the code differs |
| Timeout, network error, `errorCode`, malformed body, mismatched `CheckoutRequestID`, non-zero `ResponseCode` | Left `pending`, retried with backoff | Inconclusive is not failure |
| Settlement refused (wrong amount or currency) | `recon_outcome='needs_review'`, nothing credited | Retrying would not change it; a human should look |

A completed deposit is never claimed at all, so a late `ResultCode` cannot
un-pay money that has already been credited. A failed deposit is never settled.
An M-Pesa receipt that already identifies another deposit is refused: the
application checks it in `settleWithin`, and PostgreSQL's unique index on
`provider_reference` is the backstop under concurrency.

#### Running it

**Off by default.** `MPESA_RECONCILE_ENABLED=1` turns it on in the server, which
then starts an interval that never overlaps itself and is stopped on `SIGTERM`
before the ledger pool closes. It is a separate flag rather than "on whenever
credentials exist" on purpose: a test run or a staging box with keys in
`.env.local` must not start querying Safaricom by accident.

| Variable | Default | Meaning |
|---|---|---|
| `MPESA_RECONCILE_ENABLED` | off | Master switch. `1` starts the worker in the server |
| `MPESA_RECONCILE_AFTER_MS` | `90000` | How long a deposit waits for its callback before being queried |
| `MPESA_RECONCILE_INTERVAL_MS` | `60000` | How often the scan runs |
| `MPESA_RECONCILE_BATCH` | `25` | Deposits considered per pass (max 200) |
| `MPESA_RECONCILE_CONCURRENCY` | `3` | Queries in flight at once (max 10) |
| `MPESA_RECONCILE_MAX_ATTEMPTS` | `6` | Attempts per deposit before it is marked for review (max 50) |
| `MPESA_RECONCILE_BACKOFF_MS` | `30000` | First retry delay; doubles each attempt |
| `MPESA_RECONCILE_MAX_BACKOFF_MS` | `1800000` | Ceiling on the retry delay |
| `MPESA_RECONCILE_TIMEOUT_MS` | `15000` | Bound on one provider call; a timeout is inconclusive |

**Why 90 seconds.** Safaricom gives no published deadline for a callback; 90s is
a safety margin so a query does not race the callback that is still on its way
and come back "still being processed".

**Retry policy.** Attempt 1 happens once the deposit is older than
`AFTER_MS`; then `BACKOFF_MS`, `2×`, `4×` … capped at `MAX_BACKOFF_MS`. After
`MAX_ATTEMPTS` inconclusive answers the deposit is marked `needs_review` and
stops being queried automatically — it is never failed for being unanswerable,
and never credited for being unverified.

**What is recorded.** Attempts and timestamps live in the deposit row
(`recon_attempts`, `last_reconciled_at`, `next_reconcile_at`, `recon_outcome`),
not in the worker's memory, so a redeploy resumes rather than restarting. The
claim is one guarded `UPDATE`, so two workers — separate processes, separate
pools — cannot both take the same deposit. Log lines carry the deposit
reference, the attempt number, the result code and the outcome; never the
request body (it contains the Daraja password) and never a full provider
response.

#### Monitoring and recovery

Watch for `recon_outcome` values that need a person:

```sql
SELECT reference, usd_amount, settlement_amount, recon_attempts, recon_outcome, last_reconciled_at
  FROM deposits
 WHERE recon_outcome IN ('paid_pending_receipt', 'needs_review')
 ORDER BY created_at DESC;
```

- **`paid_pending_receipt`** — the provider confirmed a payment we could not
  verify. Check the receipt in the M-Pesa portal for the shortcode, then settle
  it through the normal path. The deposit is deliberately left `pending`, not
  failed and not credited.
- **`needs_review`** — either the provider never gave a usable answer within the
  attempt limit, or settlement refused the amounts. Both mean a human should
  look; neither has credited anything.

To chase one specific deposit (bypassing the age threshold), or to see what is
due without contacting anyone:

```bash
DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --dry-run
DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --once
DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --reference STO_abc123
DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --watch
```

That CLI is the manual trigger, and it is deliberately **not** an HTTP route: a
public "reconcile now" endpoint would let anyone drive this server into hammering
Safaricom. It refuses to run without `DATABASE_URL`, because reconciling against
a process-local store would be theatre.

#### What is verified here, and what is not

Verified in `tests/reconcile.test.mjs` (19 tests, in-memory store, **mocked
provider**): the scan finds a stuck deposit; a verified success settles once; a
confirmed failure credits nothing; a timeout, a provider error, a malformed body
and a mismatched `CheckoutRequestID` all credit nothing and stay retryable; a
bare `ResultCode: 0` lands in the review state instead of crediting; an
underpayment is refused; a reused receipt cannot credit a second deposit; a
callback and a reconciliation racing settle at most once; a completed deposit is
never even queried; retry limits and backoff behave as documented; one failing
query does not stop the batch; an overlapping run is refused; and a restart
resumes from the persisted attempt count.

The **PostgreSQL** behaviour is verified too, against a real server (PostgreSQL
16): `tests/postgres/pg-settlement.test.mjs` and `tests/postgres/pg-reconcile.test.mjs`
— 19 tests — cover what the in-memory run structurally cannot reach: the row
lock and the partial unique indexes, a claim that only one of two workers can
take, a receipt that cannot settle a second deposit, a database failure that
rolls the credit back with the status, and a fresh pool that resumes from the
persisted attempt count rather than restarting it. `npm run test:postgres`
refuses to run without `PG_TEST_DATABASE_URL` rather than skipping silently.

No live Safaricom query has been issued: every provider response in these tests
is a fixture, and no test initiates a payment.

### What is not verified

The client has only been driven against a stand-in server that speaks Daraja's
documented shapes — including a full run through the real server process, from
prompt to credited wallet. Nothing has touched Safaricom and no live sandbox
payment has completed. Version 3 of the API has no publicly verified rate limit
or documented callback-redelivery policy, so treat both as unknown: that is
exactly why settlement is idempotent and why an unverifiable callback leaves the
deposit pending instead of guessing.

## Enabling cards

Set `CARD_PROVIDER` and `CARD_SECRET_KEY` (and `CARD_RETURN_URL` if the
processor needs one), then implement `providers.cardCharge` against the
processor's server-side API.

Card data never reaches this server's storage or logs: `readCardFields` +
`validateCardFields` reduce a submission to `{brand, last4, expiry}` and discard
the PAN, CVC and cardholder name, and the raw body is never logged. Keep it that
way — for PCI scope, the card should ideally go straight from the browser to the
processor and this server should only see the resulting intent.

**Do not treat card deposits as supported until a real processor is configured
and a charge has been verified end to end.**

## Enabling USDT (TRC20)

There are two ways to give the panel an address, and neither one invents one.

### A static operator wallet (what this mirror ships)

Set `TRON_DEPOSIT_ADDRESS` to a TRON address you control. The mirrored server
defaults it to `DEFAULT_TRON_DEPOSIT_ADDRESS` in
[tools/payments.mjs](tools/payments.mjs) — the wallet baked into this fork — so
the USDT (TRC20) panel shows a real address out of the box. Set the variable to
an empty string to disable the static wallet and fall back to the provider path
below (or to the honest `503` when there is none).

This is a **shared** receiving wallet, not per-account custody. Every account is
shown the same address, so a deposit cannot be attributed by the address it was
sent to. Attribution therefore still requires an on-chain confirmation you
verify yourself, and `settleDeposit` still refuses anything it cannot verify.

Two behaviours worth knowing:

- re-pointing the wallet reaches accounts that already have one — a cached
  address that no longer matches the configured wallet is treated as stale and
  replaced, so nobody is left depositing to a wallet you stopped using;
- a malformed address is refused with `500 TRON_ADDRESS_INVALID` and is never
  cached or echoed back.

### A custody provider

Set `TRON_WALLET_PROVIDER` and `TRON_API_KEY`, then implement
`providers.tronDepositAddress` to allocate (or look up) an address for the
account. The surrounding guarantees are already in place:

- one address per account, cached indefinitely;
- concurrent callers share a single allocation, so a UI that asks twice still
  allocates once;
- a cached address does not consume the rate limit.

The server will never generate a random string and call it a deposit address.
Deposits must settle from an on-chain confirmation you verify yourself — never
from a client-submitted transaction hash or a screenshot.

## Crediting a wallet

`settleDeposit` is the only function that moves money, and it is deliberately
hard to satisfy. It refuses a deposit that is:

- already `completed` → returns `{credited:false, reason:"already_settled"}`
- `failed` or `cancelled` → `409 CONFLICT`
- missing a verified provider reference → `400`
- missing a verified amount → `400`
- verified in a currency that is not the deposit's settlement currency → `400`
- verified for less than the settlement amount → `400`

It is serialised through a mutex, so ten concurrent settlements of one reference
credit exactly once, and it snapshots state and rolls back if the write fails —
a failed settlement can never leave a credited-but-unsaved balance.

Amounts are stored in two currencies on purpose:

```
amount              USD  what the user deposits and what we credit
settlement_currency KES  what the provider actually charges
settlement_amount   1300 for a $10 deposit at 130 USD/KES
settlement_rate     130  the rate used, kept for audit
```

Confusing the two is how a $10 deposit becomes a $1,300 credit. The tests pin
this: a 1300 KES settlement credits 10 USD, and a settlement in the wrong
currency is refused.

## Exchange rate

`GET /api/auth/exchange-rate` is **public**, and that is deliberate: the mirrored
client requests it with no `Authorization` header at all. Requiring auth produced
`401`, the client silently kept its hardcoded `130`, and the modal displayed a
fabricated conversion. A reference rate is not user data.

The rate comes from a cached live feed, and the response names its source and
update time. If the provider cannot be reached the endpoint returns
`503 EXCHANGE_RATE_UNAVAILABLE` (or the last known rate, flagged `stale`) — it
never invents one. A KES charge cannot be issued while the rate is unavailable,
so M-Pesa deposits are blocked rather than converted at a guess.

## Client-side fixes

The mirrored bundle is third-party compiled output. Two defects in it break the
deposit modal, and both are fixed at serve time in
[tools/client-patches.mjs](tools/client-patches.mjs) so `site/` stays a faithful
copy and `npm run mirror` stays re-runnable.

1. **TRC20 request storm.** Each address effect had its own loading flag in its
   dependency array:

   ```js
   "trc20" !== method || address || loading || (async () => {
     setLoading(true);
     try { /* fetch */ } finally { setLoading(false); }
   })();   // deps: [method, address, loading]
   ```

   The flag is both the guard and a dependency. When the request yields no
   address, `loading` flipping true → false re-triggers the effect — forever.
   Measured: **50+ requests in 12 seconds** from one modal open (the network log
   was capped), about 4/second and unbounded. Fixed by dropping the loading flag
   from the dependency array, which brings it to **1 request per open**.

2. **The rate fallback was invisible.** `if (e.ok) { setRate(...) }` with no
   `else`, inside a `try/catch`, and the rate state initialised to a hardcoded
   `130`. A non-OK response took no branch at all, so the modal kept rendering an
   estimate with no indication it was stale. Fixed by adding the missing `else`,
   which reports through the modal's existing error banner.

3. **Address errors were generic.** A failed address lookup discarded the
   response body, so a configuration error read like a network blip. Now the
   API's own message is shown.

Every edit is anchored on an exact string and self-validating: if the upstream
bundle changes and an anchor stops matching, the edit is skipped and logged
rather than guessed at. Set `PATCH_CLIENT=0` to serve the bundle untouched.

### Remaining gap

The TRC20 panel still shows *"Generating your dedicated deposit address…"*
alongside the error banner. That spinner is keyed on the address being absent
(`loading || !address`), not on the request having failed, so removing it means
introducing an explicit unavailable state into the component's render — a change
to minified third-party UI code that was not made blind. The user is never told
anything false: the banner states why the address is unavailable.

A third TRC20 panel variant (in `219b97e8e5e970d5.js`) has no error state at all
to write to — the nearest banner belongs to a component 75 kB away — so it is
left alone and reported here rather than patched speculatively.

## Tests

```bash
npm test                      # the in-memory suites, including reconciliation
npm run test:postgres         # needs PG_TEST_DATABASE_URL; refuses to run without it
npm run test:postgres:stress  # contention at load; needs the same variable
```

Each of those commands runs `tools/check-suites.mjs` first. It refuses when a
glob would match no test files, because `node --test` exits 0 in that case — and
a suite that is absent, or written but not committed, must never read as a pass.

148 tests. They cover the 15 required behaviours: unauthenticated access, invalid
amounts and phone numbers, missing credentials, provider rejection and timeout,
pending status, genuine settlement from a fixture, duplicate replay, ten
concurrent settlements of one reference, failed/cancelled deposits, duplicate
address requests, a missing exchange-rate provider, malformed provider
responses, cross-user access, crediting an unverified deposit, and database
rollback.

The 19 reconciliation tests added on top of those are described in the section
above, and the two PostgreSQL files (`tests/postgres/`) hold the guarantees that
need a real database: the atomic claim, receipt uniqueness under concurrency, a
restart that resumes from the database, and rollback.

### A PostgreSQL for the suites, without installing one

Neither PostgreSQL suite falls back to memory — a skipped test that reports
success would be worse than no test — so they need a server. On a machine with
none, and without administrator rights, `tools/pg-local.mjs` runs the genuine
article from official prebuilt binaries in a git-ignored directory: no
installer, no service registered, nothing in `Program Files`.

```bash
node tools/pg-local.mjs fetch   # once: ~23 MB of official PostgreSQL binaries -> .tools/pg
node tools/pg-local.mjs start   # initdb into .data/pgdata if needed, then serve
node tools/pg-local.mjs url     # creates the test database, prints PG_TEST_DATABASE_URL
node tools/pg-local.mjs stop    # or: reset, to drop and recreate the test database

PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)" npm run test:postgres
```

It binds to `127.0.0.1` and uses `trust` authentication, which is safe only
because it listens on loopback alone — never point it at a routable address,
where reachability would be authorisation.

`start` detaches the server, so it outlives the shell that launched it; stop it
with `pg-local.mjs stop`. One operational note learned the hard way: on Windows a
console close or Ctrl+C is delivered to the server's worker processes too, and a
worker killed mid-statement takes the whole cluster into crash recovery. Start it
from a terminal you are not about to kill, and stop it deliberately.

### Contention and concurrency (`test:postgres:stress`)

The two PostgreSQL files above prove the guarantees with two actors. The stress
suite (`tests/postgres/stress/pg-stress.test.mjs`) does the same at load and
re-checks the ledger-wide invariants after every scenario — credited total equals
the completed deposits, every credit belongs to its deposit's owner, no account
overdrawn, no reference with two ledger entries. Scenarios: 2/10/50/100
simultaneous deliveries of one callback; a callback racing a reconciliation
worker; several workers over one due list; two different receipts for one
deposit; one receipt across many deposits; a success and a failure delivered
together; a timeout followed by a late payment; many accounts at once; an
injected database failure in mid-batch; and a restart. The run prints a
per-scenario evidence table.

```bash
PG_STRESS_CONCURRENCY=24 PG_STRESS_DUPLICATES=2,25,100,200 \
  PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)" npm run test:postgres:stress
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PG_STRESS_SEED` | `20261015` | fixture seed, printed with the run so a failure reproduces |
| `PG_STRESS_DUPLICATES` | `2,10,50,100` | simultaneous copies of one callback |
| `PG_STRESS_CONCURRENCY` | `12` | pools, i.e. genuinely parallel settlements |
| `PG_STRESS_WORKERS` | `4` | reconciliation workers racing for the same claims |
| `PG_STRESS_DEPOSITS` | `24` | deposits per batch scenario |
| `PG_STRESS_ACCOUNTS` | `16` | accounts settling at once |

Start at the defaults and raise one number at a time. The suite refuses to run
if `PG_TEST_DATABASE_URL` is unset, if it names the same database as
`DATABASE_URL`, if the database name does not look disposable (unless
`PG_STRESS_ALLOW_ANY_DB=1`), or if `NODE_ENV=production`. It works in one
randomly named schema and drops it at the end, so nothing else in the database is
read or written.

The provider fixtures are **fixtures**. No test contacts Safaricom, a card
processor or a TRON custodian, and no test result here should be read as
evidence that a real payment works.
