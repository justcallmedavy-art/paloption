# Deploying PalOption

**One origin is the recommended shape, and it needs no frontend deployment.**
`site/` is in this repository, and `tools/server.mjs` serves it alongside the
API, so a single backend host gives you the whole application:

```
browser ──https──> paloption-api.onrender.com   (client + /api/* + /ws)
                       │
                       └──> Postgres
```

Nothing has to be built or uploaded, `ALLOWED_ORIGINS` stays empty, and the
client's API base resolves to same-origin — which is what the service prints at
boot (`api base : same-origin`). Go through §1, §2 and §4, then skip §3 and read
§5 with `WEB` set to your API host.

The split layout below is the alternative, and it costs you a CORS
configuration plus a frontend rebuild whenever the API moves. The Railway
section in §2 is written for exactly that shape (client on Vercel, API on
Railway), since a WebSocket and a one-second settlement timer cannot run on a
serverless host:

| Piece | Where | What runs |
| --- | --- | --- |
| Frontend | Vercel (`paloption.vercel.app`) | the static client; no API routes |
| Backend | Render / Railway / Fly | `tools/server.mjs` — API, `/ws` trading socket, 1s tick engine, cashier |
| Database | Render Postgres / Neon | the ledger |

The backend **must** be a long-lived process. It holds a persistent WebSocket
connection, runs a 1-second timer that settles trades, and keeps bot sessions in
memory. That is exactly what a serverless platform cannot do, which is why the
frontend is on Vercel and the API is not.

```
browser ──https──> paloption.vercel.app   (static client)
   │
   └──https/wss──> paloption-api.onrender.com ──> Postgres
                   /api/*  and  /ws
```

---

## 1. Database

Any Postgres works. The schema is applied automatically at boot and by
`npm run migrate`, and every statement is idempotent.

Create the database and copy its connection string (it must include TLS, e.g.
`?sslmode=require`):

```bash
DATABASE_URL='postgresql://user:pass@host:5432/db?sslmode=require' npm run migrate
```

Expected output — ten tables, and the two unique indexes that make settlement
exactly-once:

```
schema applied to postgresql://user:***@host:5432/db?sslmode=require
  tables  : deposits, idempotency_keys, mpesa_callbacks, pending_2fa, positions,
            sessions, transactions, trc20_addresses, users, withdrawals
  unique  : transactions_deposit_reference_unique, deposits_provider_reference_unique
```

## 2. Backend

Set these environment variables on the host:

| Variable | Required | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | the Postgres connection string above |
| `NODE_ENV` | yes | `production` — refuses to boot without `DATABASE_URL` |
| `ALLOWED_ORIGINS` | only for a split deployment | the frontend origin, e.g. `https://paloption.vercel.app` (no trailing slash; comma separate several). **Leave it empty when this service also serves the client** — its requests are same-origin and are accepted with no value at all, which is what the single-origin deployment wants |
| `DARAJA_ENV` | for M-Pesa | `sandbox` until you are live |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` | for M-Pesa | from your Daraja app |
| `DARAJA_SHORTCODE` / `DARAJA_PASSKEY` | for M-Pesa | the paybill shortcode and its passkey |
| `DARAJA_CALLBACK_TOKEN` | for M-Pesa | long and random: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `DARAJA_CALLBACK_URL` | for M-Pesa | `https://<api-host>/api/auth/mpesa/callback/<token>` |
| `TRON_DEPOSIT_ADDRESS` | before taking deposits | a TRON address **you control**. Left unset, every depositor is shown a wallet hardcoded in the source that is not yours; the boot log warns `WARNING : TRON_DEPOSIT_ADDRESS is not set`. An empty string switches the static wallet off deliberately |
| `PORT` | no | usually set by the host; defaults to 4174 |

### Render (blueprint included)

`render.yaml` provisions the service **and** its Postgres together:

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → pick the repository.
3. Render reads `render.yaml` and asks for the `sync: false` values: leave
   `ALLOWED_ORIGINS` **empty** (this service serves the client, so its requests
   are same-origin), set `TRON_DEPOSIT_ADDRESS` to a wallet you control (or leave
   it empty only if you do not want to offer USDT deposits at all — unset means
   depositors are shown a built-in wallet that is not yours), and fill in the
   `DARAJA_*` credentials you have. The rest of the M-Pesa set can stay blank
   and be filled in later — see §4, the callback URL does not exist until the
   service does.

   Confirm what the instance decided at boot: the log prints
   `WARNING : TRON_DEPOSIT_ADDRESS is not set …` whenever the built-in wallet is
   in play, and `providers : daraja=… card=… tron=…` says which cashiers are
   live.
4. Deploy. The health check polls `/healthz`, which reports which storage is in
   use, so a deployment that lost its database shows as unhealthy rather than
   quietly serving from memory.
5. That URL is now the whole app. Open it and stop here unless you are keeping a
   frontend on another host — the server's boot log says
   `api base : same-origin`, and the trading socket follows it.

### Railway (the split deployment: client on Vercel, API here)

`Procfile` and `railway.json` are already in the repository, so nothing about
*how* the service runs needs configuring:

| Setting | Value | Defined by |
| --- | --- | --- |
| builder | Nixpacks | `railway.json` |
| build command | `npm ci --omit=dev` | `railway.json` |
| start command | `node tools/server.mjs` | `railway.json`, and `Procfile` as the fallback |
| health check | `/healthz` | `railway.json` |

The server reads `PORT` (Railway sets it), binds `0.0.0.0`, and stops on
`SIGTERM` — which is what a Railway redeploy sends. The trading tick, the
socket and the database pool are all closed before it exits, and `/healthz`
answers `503` if the database cannot be reached, so a host health-checking that
path stops routing to an instance that could take a stake it cannot record.

1. Railway → **New Project → Deploy from GitHub repo** → pick this repository.
2. **Create → Database → PostgreSQL** in the same project.
3. On the **service** (not the database), set the variables below. Reference the
   database by name rather than copying its password:
   `DATABASE_URL = ${{<database-service>.DATABASE_URL}}`.
4. **Settings → Networking → Generate Domain.** That host is the API's origin.
5. Set `ALLOWED_ORIGINS` to the frontend's origin *before* anyone signs in.
6. Deploy the frontend against that host (§3), then verify (§5).

#### Environment variables

Required:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` — with no `DATABASE_URL` this is a boot error, deliberately |
| `DATABASE_URL` | `${{<database-service>.DATABASE_URL}}` |
| `ALLOWED_ORIGINS` | `https://paloption.vercel.app` — the client is on another host here, so without it every request is `403 ORIGIN_NOT_ALLOWED` |

Worth knowing:

- **There is no session secret to set.** Sessions are 24 random bytes stored
  server-side and each password is salted and hashed per user, so there is no
  signing key to configure, rotate, or leak.
- `PORT` is provided by Railway. `HOST` is unnecessary — the default already is
  `0.0.0.0`.
- TLS is inferred from the connection string: Railway's internal
  `*.railway.internal` address is used as-is, while a public `*.proxy.rlwy.net`
  address turns TLS on (`needsSsl` in `tools/store.mjs`). Use the internal one
  for a service in the same project.

Cashier variables, only when you want payments (§4, and PAYMENTS.md):
`TRON_DEPOSIT_ADDRESS` — **money, and a wallet you control** — plus, for M-Pesa,
`DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET`, `DARAJA_SHORTCODE`,
`DARAJA_PASSKEY`, `DARAJA_CALLBACK_TOKEN`, `DARAJA_CALLBACK_URL`,
`DARAJA_ENV=sandbox`, `DARAJA_TRANSACTION_TYPE=paybill`, and
`DARAJA_ALLOW_PRODUCTION=1` **only** when you mean to take real money. Card
deposits need `CARD_PROVIDER` and `CARD_SECRET_KEY`.

Leave them unset and the cashier answers `503 PAYMENT_PROVIDER_NOT_CONFIGURED`
rather than pretending: no wallet is credited without a verified settlement.

### Fly / any container host

```bash
docker build -t paloption-api .
docker run -p 8080:8080 \
  -e DATABASE_URL='postgresql://...' \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS='https://paloption.vercel.app' \
  paloption-api
```

Confirm the service is up before touching the frontend:

```bash
curl -s https://<api-host>/healthz
# {"ok":true,"storage":"postgres","uptime":12}
```

`"storage":"memory"` means `DATABASE_URL` did not reach the process — fix that
before going further, because an in-memory ledger loses every trade on restart.

## 3. Frontend (only when it is on another host)

**Skip this section for the single-origin deployment.** The service serves
`site/` already, so there is nothing to build, upload, or point anywhere.

For a frontend on its own host, the client reads its API host from a value baked
into the bundle. Build the snapshot with the API origin set, then upload it:

> Whichever shape you pick, `ALLOWED_ORIGINS` must match it. A client on
> `paloption.vercel.app` calling an API on another host is refused with
> `403 ORIGIN_NOT_ALLOWED` until that host is listed *and* the frontend is
> rebuilt against it.

```bash
PALOPTION_API_URL=https://<api-host> npm run deploy:snapshot   # writes deploy/paloption
npm run deploy:prod                                            # builds + uploads to Vercel
```

`VITE_API_URL` is accepted as an alias for `PALOPTION_API_URL`. Use the bare
origin — no trailing slash, no `/api` suffix. An `https` value produces a
`wss://` socket automatically; on an https page a value that would produce a
plain `ws://` to a public host is upgraded to `wss://` rather than sending the
session token in the clear.

The page can also be re-pointed at runtime without a rebuild, which is useful
when the backend moves:

```html
<script>globalThis.__PALOPTION_API_URL__ = "https://api.example"</script>
```

## 4. The M-Pesa callback

Safaricom cannot reach localhost, so this only works on a public HTTPS host:

1. Set `DARAJA_CALLBACK_TOKEN` (generated above) and
   `DARAJA_CALLBACK_URL=https://<api-host>/api/auth/mpesa/callback/<token>`.
2. The path carries the secret because Safaricom sends no Bearer token. The
   comparison is constant-time, and the `CheckoutRequestID` must match a deposit
   this server created — a callback naming an unknown id creates nothing.
3. A non-zero `ResultCode` fails the intent and credits nothing; a zero one is
   still verified against the deposit's currency and amount before crediting.

### Order of operations (easy to get wrong)

The callback URL contains the API host, and the API host does not exist until the
service has been created. So:

1. Deploy the service with `DARAJA_CALLBACK_TOKEN` set and `DARAJA_CALLBACK_URL`
   empty. The cashier refuses with `503 PAYMENT_PROVIDER_NOT_CONFIGURED`, which
   is the correct state — it cannot take a payment it could not resolve.
2. Note the service URL Render gives you, then set
   `DARAJA_CALLBACK_URL=https://<that-host>/api/auth/mpesa/callback/<token>` with
   the same token, and redeploy.

### Live M-Pesa (`DARAJA_ENV=production`)

This is the setting that moves real money, so it reads plainly here:

- The instance charges your **real** shortcode. Anyone who reaches the frontend
  can be sent a real STK prompt, approve it with their real M-Pesa PIN, and pay
  real money into the operator wallet.
- The customer's handset shows the shortcode's registered name. If that name is
  not the brand this site presents itself as, you are collecting payments under
  someone else's name.
- **`DARAJA_ALLOW_PRODUCTION` must also be `1`.** Production Daraja is ignored
  without it, deliberately: this repository is a clone, and a copied
  configuration should not be able to start taking real payments on its own. If
  you set `DARAJA_ENV=production` and forget this, the cashier returns 503 and
  the boot log says which switch is missing.
- The boot log prints `WARNING : Daraja is LIVE` once it is active, so a hosting
  dashboard shows which instance is taking payments.
- Test with the smallest deposit the platform allows on a handset you control,
  and confirm the callback credits exactly once, before telling anyone the
  cashier works.

## 5. Verify the deployment

One command runs the machine-checkable half of this section — the ledger is
really Postgres, the client is served here, a same-origin request is accepted
while a foreign origin is refused, an unknown `/api` path answers JSON rather
than HTML, a refused login is a JSON error, and the socket takes this origin's
handshake but not another's:

```bash
npm run verify:deploy -- --url https://<api-host>
```

It is read-only and exits non-zero if any check fails, so it can gate a release.
Add `--register` to also create one throwaway account and prove registration and
the session it returns work; that is the only variant that writes anything. The
cashier is deliberately out of scope — it moves money, and its own tool is at the
end of this section.

The same checks by hand, against the deployed pair rather than locally:

```bash
API=https://<api-host>
WEB=$API                     # single origin; use the Vercel host if you kept one

curl -s $API/healthz                                    # {"ok":true,"storage":"postgres"}
curl -s $WEB -o /dev/null -w '%{http_code}\n'           # 200 — the client is served here
curl -s -H "Origin: $API" $API/api/auth/exchange-rate    # 200, same-origin accepted
curl -s -H "Origin: $WEB" $API/api/auth/exchange-rate    # CORS grant present
curl -s -H "Origin: https://evil.example" $API/api/auth/exchange-rate   # 403 ORIGIN_NOT_ALLOWED
```

Then, in a browser on the deployed frontend:

- [ ] Sign up / sign in completes, and the socket authenticates (`auth_success`).
- [ ] The price feed ticks once a second and digit statistics move.
- [ ] A manual trade opens, settles, and the balance changes by the payout.
- [ ] The auto-trading bot starts, opens trades, and stops on target or on stop.
- [ ] Switch between demo and real mode and see the right balances.
- [ ] **Restart the backend**, then reload: the balance, position history and
      deposit list survive. This is the check that proves the ledger is in
      Postgres and not in the process.
- [ ] The cashier returns a real quote on `/api/auth/exchange-rate`, and an
      M-Pesa push returns `pending` (never a credit) before the callback lands.

### The cashier, proved against a running server

```bash
npm run verify:cashier -- --sandbox --api https://<api-host>
```

`tools/verify-cashier.mjs` drives the deployed HTTP surface and posts callbacks
to the deployment's OWN public callback URL, exactly as Safaricom posts them:
a push settles nothing; the success callback credits once; a replay credits
nothing further; a forged `CheckoutRequestID` credits nothing; an under-payment
is refused and left pending; and finally every credited dollar must match a
completed deposit. That last check is the one that catches a ledger and a
deposit record disagreeing.

`--sandbox` is mandatory and not a formality: the tool forges a *successful*

callback, so it must never be pointed at an instance configured for production
Daraja, where the callback token would be the only thing between a wallet and a
free credit. It reads `DARAJA_CALLBACK_TOKEN` and never prints it.

## 6. Security notes

- **Origins.** `ALLOWED_ORIGINS` gates both the API and the trading socket. A
  WebSocket handshake is exempt from CORS, so the socket is refused at upgrade
  time (`403`) for any other origin.
- **No cookies.** The client authenticates with a Bearer token, and no
  `Access-Control-Allow-Credentials` is sent, so a browser cannot be tricked
  into attaching a session to a cross-site request.
- **Ownership.** Deposit and position reads are scoped by `user_id` in SQL; a
  reference belonging to another account is a `403`, not a hint.
- **Money.** Amounts are `numeric(14,2)`, never floats. A deposit settles once
  (unique index on its ledger reference) and a position settles once
  (`WHERE settled_at IS NULL` in the settling statement), whatever the process
  believes.
- **Secrets.** Provider credentials belong in the host's environment, never in a
  tracked file. `.env.local` is git-ignored and only for local runs.

## 7. Known limitations

- **The Postgres path has not been exercised against a live database in this
  working copy** — the environment has no Docker or local Postgres, so the suite
  covers the store interface through its in-memory implementation. Run
  `npm run migrate` against the real database and repeat the checklist in §5;
  that is what closes this gap.
- Bot sessions live in memory: a restart stops a running bot. The trades it had
  already opened are unaffected, and the panel shows the last session.
- **The sandbox never approves the documented test number.** Measured against a
  live sandbox push to `254708374149`: the request is *accepted* — a real
  `CheckoutRequestID` comes back — and the callback then reports a non-zero
  result. Observed verbatim as "DS timeout user cannot be reached.", "No response
  from user." and "Request Cancelled by user." across 17 pushes, with **no
  approval ever**. A sandbox run therefore proves the wiring, never a credit;
  only a handset you can answer proves the money path.
- **Sandbox callbacks are slow, unordered, and sometimes absent.** Arrivals were
  measured between t+1s and t+26s, and several pushes received no result at all
  within 120s. Nothing may assume a callback is coming — and, because a result
  can land *after* a deposit has already been settled, a non-zero result must
  never be allowed to overwrite a settled deposit. That last case is a real
  defect this deployment had: `mpesaCallback` failed the deposit with an
  unguarded write, so a late timeout could flip a credited deposit to `failed`
  while the money stayed in the wallet. The guard now lives in the statement
  (`failDepositIfUnsettled`, `AND status = 'pending'`), and the contradictory
  delivery is recorded as `ignored_after_settlement` instead.
- **Restart persistence is only meaningful against Postgres** and has not been
  demonstrated end to end: the local suite runs the in-memory store, where a
  restart is expected to lose state. The step in §5 is what proves it.

---

## 8. API surface

The service exposes exactly these routes. Anything else under `/api/` returns a
JSON `404`, rather than the HTML body that used to break the client's
`JSON.parse`.

| Method | Route | Access |
| --- | --- | --- |
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public; returns `requires2FA` + `tempToken` when 2FA is on |
| POST | `/api/auth/login/verify-2fa` | public; `tempToken` + `code`, single use |
| POST | `/api/auth/demo` | public; creates a demo account |
| GET | `/api/auth/me` | Bearer |
| POST | `/api/auth/switch-account` | Bearer; demo/real mode |
| POST | `/api/auth/reset-demo` | Bearer |
| GET | `/api/trade/positions` | Bearer; own positions only |
| GET | `/api/transactions` | Bearer; own ledger only |
| GET | `/api/auto-trading/status` | Bearer |
| GET | `/api/auth/exchange-rate` | public, deliberately: the client sends no `Authorization` header for it, and a USD/KES reference rate is not user data |
| POST | `/api/auth/mpesa/stk-push` | Bearer |
| POST | `/api/auth/card/deposit` | Bearer |
| GET | `/api/auth/trc20/my-address` | Bearer; one address per account |
| GET | `/api/auth/deposits` | Bearer; own deposits only |
| GET | `/api/auth/deposits/:reference` | Bearer; another account's reference is `403` |
| POST | `/api/auth/mpesa/callback/:token` | no Bearer (Safaricom cannot send one); the path token plus a `CheckoutRequestID` this server issued |
| GET | `/healthz` | public; reports the storage in use |
| WS | `/ws` | Origin-gated at upgrade; the `auth` frame carries the Bearer token |

Request and response shapes for the socket (`price`, `balance_update`,
`position_update`, `transaction_update`, `auto_trading_*`) are documented at the
top of `tools/server.mjs`, which is also where the two easy-to-get-wrong details
live: `action` sits at the message root, not inside `data`, and
`auto_trading_response` carries `session` at the root.
