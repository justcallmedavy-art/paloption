# Deploying StrategyOption

**One origin is the recommended shape, and it needs no frontend deployment.**
`site/` is in this repository, and `tools/server.mjs` serves it alongside the
API, so a single backend host gives you the whole application:

```
browser ──https──> strategyoption-api.onrender.com   (client + /api/* + /ws)
                       │
                       └──> Postgres
```

Nothing has to be built or uploaded, `ALLOWED_ORIGINS` stays empty, and the
client's API base resolves to same-origin — which is what the service prints at
boot (`api base : same-origin`). Go through §1, §2 and §4, then skip §3 and read
§5 with `WEB` set to your API host. §9 is the push recipe, for whoever is doing
the committing.

The split layout below is the alternative, and it costs you a CORS
configuration plus a frontend rebuild whenever the API moves. The Railway
section in §2 is written for exactly that shape (client on Vercel, API on
Railway), since a WebSocket and a one-second settlement timer cannot run on a
serverless host:

| Piece | Where | What runs |
| --- | --- | --- |
| Frontend | Vercel (`strategyoption.vercel.app`) | the static client; no API routes |
| Backend | Render / Railway / Fly | `tools/server.mjs` — API, `/ws` trading socket, 1s tick engine, cashier |
| Database | Render Postgres / Neon | the ledger |

The backend **must** be a long-lived process. It holds a persistent WebSocket
connection, runs a 1-second timer that settles trades, and keeps bot sessions in
memory. That is exactly what a serverless platform cannot do, which is why the
frontend is on Vercel and the API is not.

```
browser ──https──> strategyoption.vercel.app   (static client)
   │
   └──https/wss──> strategyoption-api.onrender.com ──> Postgres
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
| `ALLOWED_ORIGINS` | only for a split deployment | the frontend origin, e.g. `https://strategyoption.vercel.app` (no trailing slash; comma separate several). **Leave it empty when this service also serves the client** — its requests are same-origin and are accepted with no value at all, which is what the single-origin deployment wants |
| `DARAJA_ENV` | for M-Pesa | `sandbox` until you are live |
| `DARAJA_CONSUMER_KEY` / `DARAJA_CONSUMER_SECRET` | for M-Pesa | from your Daraja app |
| `DARAJA_SHORTCODE` / `DARAJA_PASSKEY` | for M-Pesa | the paybill shortcode and its passkey |
| `DARAJA_CALLBACK_TOKEN` | for M-Pesa | long and random: `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"` |
| `DARAJA_CALLBACK_URL` | for M-Pesa | `https://<api-host>/api/auth/mpesa/callback/<token>` |
| `TRON_DEPOSIT_ADDRESS` | before taking deposits | a TRON address **you control**. Left unset, every depositor is shown a wallet hardcoded in the source that is not yours; the boot log warns `WARNING : TRON_DEPOSIT_ADDRESS is not set`. An empty string switches the static wallet off deliberately |
| `PORT` | no | usually set by the host; defaults to 4174 |
| `WS_PING_MS` | no | how often the trading socket is pinged at the protocol level; defaults to 25000. A socket that answers nothing for two intervals is dropped, so a connection that died without a close frame does not sit in the host's connection list forever. `1000` makes the tests fast; nothing else needs to move |

### Render (blueprint included)

`render.yaml` provisions the service **and** its Postgres together. It requests
the **free** plans, and a free instance is not merely smaller: the web service
spins down after 15 minutes idle — which drops the trading socket and stops the
tick engine, and loses a running bot session with the process — and the free
database expires 30 days after creation, with a 14-day grace period before
deletion ([render.com/docs/free](https://render.com/docs/free)). Open positions
survive the sleep; they settle on a guard inside the SQL statement rather than on
a timer a sleeping process holds.

Note that this file does not decide where your frontend lives. Step 3 does, and
the two possible answers need opposite `ALLOWED_ORIGINS`.

The steps:

1. Push this repository to GitHub.
2. Render → **New → Blueprint** → pick the repository.
3. Render reads `render.yaml` and asks for the `sync: false` values:

   - **`ALLOWED_ORIGINS`** — this depends on which shape you are deploying, and
     getting it wrong is the failure that looks like a broken login:
     - **Client stays on Vercel** (the split shape, and what the Railway section
       describes): set it to the frontend's origin exactly,
       `https://strategyoption.vercel.app` — no trailing slash. Without it every
       browser request to this API is `403 ORIGIN_NOT_ALLOWED`, sign-in
       included.
     - **This service serves the client too** (one origin): leave it **empty**.
       A same-origin request is accepted with no value at all, and setting a
       wrong one here would refuse the requests the app makes to itself.
   - **`TRON_DEPOSIT_ADDRESS`** — a wallet you control, because this one moves
     money. Set it to an empty string only if you do not want to offer USDT
     deposits at all; leaving it **unset** shows depositors a wallet built into
     the source that is not yours.
   - **`DEDICATED_ACCOUNT_EMAIL`** and **`DEDICATED_ACCOUNT_PASSWORD`** — the
     one account this deployment creates for itself. A free plan has no shell,
     so `node tools/provision-account.mjs` has nowhere to run, and the database
     Render just created contains no rows: the server reads these at boot and
     creates the account through the ordinary scrypt path, with $10,000 demo and
     $9.00 real. An account that already exists is reported and left alone, so a
     redeploy cannot reset a balance. Leave both blank and nothing is created.
   - **`DARAJA_*`** — fill in what you have, or leave blank. Anything left blank
     makes the cashier answer `503 PAYMENT_PROVIDER_NOT_CONFIGURED`, which is
     the honest state. The callback URL cannot be set yet — see §4.

   Confirm what the instance decided at boot: the log prints
   `WARNING : TRON_DEPOSIT_ADDRESS is not set …` whenever the built-in wallet is
   in play, and `providers : daraja=… card=… tron=…` says which cashiers are
   live.
4. Deploy. The health check polls `/healthz`, which reports which storage is in
   use, so a deployment that lost its database shows as unhealthy rather than
   quietly serving from memory.
5. Depending on which shape you chose:
   - **Client on Vercel:** that URL is the API, not the app. Rebuild the
     frontend against it (§3) and redeploy, or the site keeps calling itself and
     every sign-in fails. The boot log should read
     `api base : same-origin` either way — the *client* is what gets pointed at
     the API host, not the server.
   - **One origin:** that URL is the whole app. Open it and stop here; the
     trading socket follows the same origin.

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
| `ALLOWED_ORIGINS` | `https://strategyoption.vercel.app` — the client is on another host here, so without it every request is `403 ORIGIN_NOT_ALLOWED` |

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
docker build -t strategyoption-api .
docker run -p 8080:8080 \
  -e DATABASE_URL='postgresql://...' \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS='https://strategyoption.vercel.app' \
  strategyoption-api
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
> `strategyoption.vercel.app` calling an API on another host is refused with
> `403 ORIGIN_NOT_ALLOWED` until that host is listed *and* the frontend is
> rebuilt against it.

```bash
STRATEGYOPTION_API_URL=https://<api-host> npm run deploy:snapshot   # writes deploy/strategyoption
npm run deploy:prod                                            # builds + uploads to Vercel
```

`deploy:snapshot` runs `npm run build` first, because the landing page embeds
`dist/styles.css` and `dist/` is gitignored — without that step the command
fails on a fresh clone with `landing source is missing: dist/styles.css`.

`VITE_API_URL` is accepted as an alias for `STRATEGYOPTION_API_URL`. Use the bare
origin — no trailing slash, no `/api` suffix. An `https` value produces a
`wss://` socket automatically; on an https page a value that would produce a
plain `ws://` to a public host is upgraded to `wss://` rather than sending the
session token in the clear.

The page can also be re-pointed at runtime without a rebuild, which is useful
when the backend moves:

```html
<script>globalThis.__STRATEGYOPTION_API_URL__ = "https://api.example"</script>
```

The page still returns 200 when that value is wrong or missing, and the only
symptom is a sign-in that cannot work, so check what the bundle actually
resolves once the deployment is up:

```bash
npm run verify:frontend -- --url https://strategyoption.vercel.app \
                          --expect-api https://<api-host>
```

It reads the API base out of the deployed chunks rather than searching for
"localhost" — the client's own wss-upgrade guard contains that string in a
comparison, so a substring search reports a problem in a correct deployment —
and it fails on a base that is empty (so the client calls its own host), a
loopback or rehearsal address, a plain `http://` origin, a bundle that predates
the `wss://` upgrade, or an API whose `/healthz` is not answering with Postgres.

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

The socket half of that is worth knowing when the numbers look frozen rather
than broken. The client sends `{"type":"ping"}` every 20s and the server answers
`{"type":"pong"}`; a client that hears nothing at all for 45s closes the socket
and reconnects, because a half-open connection reports `readyState: OPEN` while
no price moves. Reconnects back off — 1s, 2s, 4s, 8s, 16s, then 30s, each with up
to a second of jitter — and the server pings at the protocol level too, so a
client built before that heartbeat existed is still kept warm and still reaped
when it dies.

`tools/verify-frontend.mjs` is its counterpart for the *client*, and needs the
API host to judge against — see §3. It answers the one question the backend
checker cannot: which host the deployed bundles actually call.

```bash
npm run verify:frontend -- --url https://strategyoption.vercel.app --expect-api https://<api-host>
```

CI runs both halves without being asked. The `frontend` job builds the snapshot
on every push and judges the built bundles — no live backend needed, so it can
run before you have deployed anything. The `frontend-live` job judges this
deployed pair and stays skipped until two repository variables exist
(Settings → Secrets and variables → Actions → Variables):
`PRODUCTION_FRONTEND_URL` and `PRODUCTION_API_URL`. Set them after the first
deploy and it runs on every push to `main`, failing on a bundle that was never
redeployed or an API that is not answering — which is the difference between a
site that is up and a site that works.

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

- **The hosted deployment has not been exercised yet.** The Postgres path now
  runs against a real server rather than an in-memory stand-in — thirty-two
  tests across `npm run test:postgres` and `npm run test:postgres:stress`, in CI
  on every push and locally via `node tools/pg-local.mjs url` — but every number
  so far comes from one machine on loopback. A live host adds what no local run
  can: a managed database, TLS, a real certificate, a proxy, and the cold start
  a free instance performs. Run `npm run verify:deploy -- --url https://<host>`
  and the §5 checklist against the real pair; that is what closes this gap.
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
- **Restart persistence is demonstrated locally, and still owed on the host.**
  Against the local PostgreSQL: register, trade, let the tick engine settle,
  kill the process, start a new one — signing in again returns the same settled
  balance, the same position row by id, and the same ledger rows. What is *not*
  yet shown is the same sequence across a Render redeploy, which is the step in
  §5 that needs the host.

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

---

## 9. Pushing changes (Windows)

Nothing in this repository needs a GitHub credential except the push itself: CI
authenticates with the `GITHUB_TOKEN` its runner provides, and a deploy is done
from the host's dashboard. So this section is only about getting a commit onto
`origin/main` from a Windows machine — and about what each rejection means.

### Where the credential lives

The remote is HTTPS and Git Credential Manager is the configured helper, so the
token is in neither the remote URL nor any file here:

```bash
git remote -v                          # origin -> github.com/justcallmedavy-art/strategyoption.git
git config --get credential.helper     # manager
```

The credential itself is a **Windows Credential Manager** entry, target
`git:https://github.com`, owned by `justcallmedavy-art` — the repository owner,
and the username a push authenticates as. Look at it without printing the
secret:

```bash
cmd //c "cmdkey /list"      # Git Bash; MSYS rewrites a bare /list into a path
```

or in the GUI: **Control Panel → User account → Credential Manager → Windows
Credentials → `git:https://github.com`**.

Storing a replacement is one command, and erasing an entry is the other:

```bash
# store it, without echoing it and without it reaching the history
read -rsp "Paste the token: " NEW_TOKEN && echo
printf 'protocol=https\nhost=github.com\nusername=justcallmedavy-art\npassword=%s\n\n' "$NEW_TOKEN" | git credential approve
unset NEW_TOKEN

# forget the stored credential — only when the entry belongs to another
# account, or you want the store empty before storing one at all
printf 'protocol=https\nhost=github.com\nusername=justcallmedavy-art\n\n' | git credential reject
```

`read -s` keeps the paste off the screen, and because the token only ever appears
as `$NEW_TOKEN` the shell's history holds the command rather than the secret. It
does not belong in a tracked file, a script, `deploy/`, or an environment
variable the app reads — no part of this application consumes it.

The target is `git:https://github.com` whatever the username, so `approve`
replaces the entry rather than adding a second one, and a second `approve` for
the same host simply wins. That ordering is deliberate: store the replacement
first, check it with the probe below, and only then throw anything away — a bad
paste is then one more paste, instead of a working credential that is already
gone.

### The token: two permissions, and why the second one is needed here

A classic token with the single `repo` scope covers every push except one, and
this repository is the case that needs the exception: `.github/workflows/` is
tracked, so a push whose commits touch a workflow file is refused unless the
credential may edit workflows. For a classic token that is the `workflow`
**scope**; for a fine-grained token it is the **Workflows** repository
*permission* — there is no `workflow` scope on a fine-grained token, and looking
for one is the usual dead end. (A write-enabled deploy key gets past it too,
being a different kind of credential, but a fine-grained token is the one to
reach for and the one this project stores.)

What the refusal looks like is worth recognising on sight, because it reads like
a network or access problem rather than a permission one. Measured on this
repository on 2026-10-16, pushing a throwaway branch from a classic `repo`-only
credential — verbatim, and one long line:

```
 ! [remote rejected] workflow-push-probe -> workflow-push-probe (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)
error: failed to push some refs to 'https://github.com/justcallmedavy-art/strategyoption.git'
```

It is about the *content* of the commits, not the ref, so pushing to a branch and
merging is no way round it — a throwaway branch is refused exactly as `main` is.
Nothing is created when it refuses (the branch was a 404 afterwards), which is
what makes it safe to repeat whenever the credential changes.

### Checking it in one command

```bash
npm run verify:credential                    # both probes
npm run verify:credential -- --no-workflow   # skip the branch-creating one
npm run verify:credential -- --remote upstream
```

`tools/verify-credential.mjs` answers five questions in one report: is a
credential stored for this remote, which kind is it, does GitHub accept it for
this repository, does it have write access, and is it close enough to its date to
matter — fourteen days' notice, because a credential that lapses mid-task is
indistinguishable from a broken remote. Then it runs the two probes, which are
writes for the reason below (a read proves nothing here):

- the **auth probe** is `git push --dry-run`, which negotiates with GitHub — a
  refused or bogus token fails there, with exit 128 — and creates no ref. It
  pushes the remote's *own* commit rather than local work, so a workflow edit
  waiting in this checkout cannot turn it into a false failure;
- the **workflow probe** really pushes a commit whose only difference from `HEAD`
  is a comment line inside `.github/workflows/`, then deletes the branch it
  created. That commit is built through a temporary index, so the working tree,
  `HEAD` and the current branch are never touched — and the report checks that for
  itself rather than asking you to trust it. `ci.yml` triggers on `main` and on
  pull requests only, so that branch starts no run of its own; if a trigger ever
  widens to every branch, expect a run for it.

Exit 0 means every check that ran passed, 1 means one did not, 2 is a usage error.
A skipped check is printed as `SKIP` with its reason and never as a pass, and a
`FAIL` on the workflow probe is the refusal quoted above, with what to do about
it. The token itself is never printed: the report names its kind, its scopes, the
account it belongs to and its expiry, and nothing else.

Create it at **Profile → Settings → Developer settings → Personal access tokens
→ Fine-grained tokens → Generate new token**:

| Field | Value |
| --- | --- |
| Resource owner | `justcallmedavy-art` — the account that owns the repository |
| Repository access | **Only select repositories** → `strategyoption` |
| Repository permissions → Contents | **Read and write** — the push itself |
| Repository permissions → Workflows | **Read and write** — committing under `.github/workflows/` |
| Expiration | the shortest you will keep re-picking; the classic token this replaced expired a month after it was made, and a credential that expires mid-task is indistinguishable from a broken remote |

Nothing else belongs on it: the app's remaining GitHub needs are either public
or supplied by the runner, so no `Administration`, no `Secrets`, no organisation
access. The username stays `justcallmedavy-art` — over HTTPS the account name is
not what authenticates, so a fine-grained token replaces a classic one
one-for-one with no remote change.

The creation page takes query parameters, so the form can be prefilled instead of
assembled by hand — and assembling it by hand across sixty permissions is how a
token ends up without `workflows` ([changelog](https://github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats-and-updated-permissions-ui/)):

```
https://github.com/settings/personal-access-tokens/new?name=strategyoption-push
  &target_name=justcallmedavy-art&expires_in=90
  &contents=write&workflows=write
```

(one line, without the breaks) `target_name` is the resource owner, `expires_in`
is a number of days from 1 to 366 or `none`, and each permission is a parameter
whose value is `read`, `write` or `admin` — except `workflows`, which accepts only
`write`. What the parameters do **not** cover is repository selection:
**Repository access → Only select repositories → `strategyoption`** is still yours to
pick in the form, and it is half of what keeps the token narrow. Leave
`expires_in` off and the default is 30 days, which is the trap the current token
fell into.

To read the stored token's scopes and expiry without printing it:

```bash
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
printf 'header = "Authorization: Bearer %s"\nurl = "https://api.github.com/user"\n' "$TOKEN" \
  | curl -sS -K - -D - -o /dev/null | grep -iE '^x-oauth-scopes|github-authentication-token-expiration'
unset TOKEN
```

`curl -K -` takes the request, token and all, from the pipe rather than from the
command line, so it stays out of the process list. A classic token answers
`X-OAuth-Scopes: repo`; a fine-grained one reports permissions instead, and in
either case the expiry date, when the token has one, is in
`github-authentication-token-expiration`.

### The push guard: what may leave, and what it says no to

`.github/workflows/` is the one directory here whose contents run on GitHub's
machines, and the one the credential needs a second permission for. So a push is
judged on the *content* of its outgoing commits, locally, before anything is
sent:

```bash
npm run guard:push        # what the guard would say about this branch — pushes nothing
npm run guard:install     # make this checkout run it as a pre-push hook
npm run guard:status      # is the hook active in this checkout?
npm run guard:audit       # read the authorisation trail — writes nothing
npm run guard:uninstall   # stop running it
```

`tools/guard-push.mjs` reads git's own ref updates — the four fields a pre-push
hook gets on stdin — establishes which commits are actually new, and looks at the
paths those commits change. New is measured against the remote's current value
for that ref when the checkout has it, and otherwise against the refs tracked
under `refs/remotes/<remote>`. An ordinary push passes and says nothing. A push
whose outgoing commits touch a `.github/workflows/` path is refused, with the
file named and the remedy printed.

| What the guard refuses | Why | How to proceed |
| --- | --- | --- |
| an outgoing commit that changes something under `.github/workflows/` | a workflow file is executable configuration for the runner, and an edit nobody meant to ship is a change to what CI does on the next push | give a reason (below), if the change is intended |
| a hook line it cannot read, a commit it cannot open, a tree it cannot read | the question could not be answered, and an unanswerable question is not a yes | `git fetch origin` then retry; or `git push --no-verify`, deliberately |
| a workflow change on a ref the remote **has**, whose value this checkout never fetched | "does this push change CI?" is answerable — `git fetch` answers it — so the answer is not "go ahead" | `git fetch origin`, then push again; or give a reason |

One case is allowed rather than refused, and it is the one that looks most like a
workflow change: a push whose destination ref the remote **does not have at all**
— the first push of an existing history to a new remote, a fork, or a mirror.
Every commit reachable from it would be new there, so nothing local can say
whether the push *changes* CI: the workflow file it carries is this repository's
own committed file, part of the history being sent, rather than an edit made for
the push. Refusing it would block the ordinary case, so it is reported and
allowed, with what governs it named. On GitHub the credential's own Workflows
permission is the gate — measured above, and it applies to a throwaway branch
exactly as it does to `main` — and `npm run verify:credential` is what measures
it. What that gives up is worth stating plainly: a workflow edit pushed as a
*new* ref to a remote this checkout has never fetched, with a credential that may
write workflows, is not caught here.

The reason is the whole authorisation, and it has to be at least twelve
characters so that it still means something when read back:

```bash
STRATEGYOPTION_WORKFLOW_PUSH_REASON="add a job that runs the push guard suite" git push
```

It is printed in the report and appended to `.git/strategyoption-push-guard.log` —
inside the git directory, so the audit line can never be committed or pushed.
`--allow-workflow "<reason>"` does the same for one invocation without setting a
variable. A reason that is empty or too short is not consent: it is reported as
*not authorised*, with its length, rather than accepted.

The record holds the instant, the kind of event, the destination, the refs, how
many commits, which `.github/workflows/` paths, where the reason came from, and
the reason. The destination is written with any userinfo removed —
`https://user:token@host/o/r.git` becomes `https://<redacted>@host/o/r.git` —
and that is load-bearing rather than tidy: `git push https://…` hands the hook
the URL *as* the remote's name, so an unredacted value would be a credential
sitting in a file that outlives the push.

### Reading the trail: `npm run guard:audit`

```bash
npm run guard:audit                        # the last 20 records, newest first
npm run guard:audit -- --limit all         # every one of them
npm run guard:audit -- --limit 5           # the newest five
npm run guard:audit -- --outcome refused   # one outcome; the totals still cover the file
npm run guard:audit -- --check             # verify every record; exit 1 if one cannot be read
```

It reads that one file and nothing else. It never writes, truncates or rotates
the trail, never runs a push, and reads no credential — the tests assert the
bytes, the size and the modification time are identical after `--audit`, `--check`,
`--limit` and `--outcome` have each run. `STRATEGYOPTION_PUSH_GUARD_LOG` names the file
outright, which is what lets it read a copy from outside a checkout at all; with
no such file and no repository it refuses rather than guessing.

**What a record claims, and what it cannot.** A record says the hook let an
authorised workflow change *proceed*. It does not say GitHub accepted the push,
and it cannot: a pre-push hook runs before anything is sent, and the credential's
refusal or a non-fast-forward rejection arrives afterwards. It is not a
signature either — the file is inside `.git`, which anyone who can push can also
edit or delete. Read it as a durable note of who authorised what, and why, which
is exactly what it is; it is not evidence that a push succeeded.

**Two gaps it states out loud.** Refusals are not recorded — they are reported to
whoever is pushing, at the moment of refusal, and a line per attempt would fill a
trail whose purpose is the authorisation — so `refused 0` in the totals does not
mean nothing was ever refused. And a trail is per checkout: a clone, or another
machine, has its own `.git` and its own file, so `authorised 0` here says nothing
about a push made somewhere else. If the trail is not wanted at all, delete it
(`rm .git/strategyoption-push-guard.log`): nothing reads it to decide anything, and it
can never be committed.

`--check` fails on four things: a line that cannot be read as a record at all, a
record missing one of its fields or cut short mid-write, a remote value carrying
userinfo (where a credential would be), and a recorded path that is not under
`.github/workflows/`. It examines every record in the file, not only the ones
listed, and says so. A missing or empty file passes — nothing recorded is nothing
to verify — and what it does *not* check is whether any push was accepted, and
refusals, for the two reasons above.

Records written before the `kind=` field existed have no kind and are read as
authorisations, printed as `(legacy record)` with that stated rather than assumed
— which is every record already on disk, including the `guardprobe` one from
proving this guard end to end. A value can never forge an entry: it is
JSON-quoted when written, and escaped again when printed, so a reason containing
a newline stays one record and one line. Two pushes in the same instant hold no
lock between them and can be appended in either order; the reader reports
timestamps that go backwards and does not fail on them.

Three things the guard deliberately does **not** do:

- **It does not probe the remote to decide.** A `git push --dry-run` succeeding
  says the credential can push at all; it says nothing about whether a change to
  CI was intended, so authorising on it would be the mistake this exists to
  prevent. The credential question is the other, server-side gate —
  `npm run verify:credential` above — and the two are reported separately.
- **It does not install itself.** Git looks at `.git/hooks` unless
  `core.hooksPath` says otherwise, and that setting is local rather than
  committed: a fresh clone has no guard until `npm run guard:install` is run in
  it. `--install` refuses to overwrite a `core.hooksPath` pointing somewhere
  else, because two hook paths cannot both be active — that one is yours to
  reconcile.
- **It does not touch the credential store.** The only git commands it runs are
  reads, and every mention of the destination — in the report and in the record —
  has any userinfo redacted, so a token pasted into a push URL cannot end up in
  the output or in the trail.

What protects a workflow push independently of the hook:

- **GitHub itself**, which refuses a workflow change from a credential that may
  not edit workflows. That is the server-side gate, it holds no matter what the
  local guard says, and `npm run verify:credential` is what measures whether the
  stored credential passes it.
- **CI**, which runs the guard's own suite as part of `npm test` on every push.
  That keeps the rules tested — and it is not authorisation: a CI job cannot tell
  an intended workflow edit from an unintended one.
- **A repository ruleset**, if you want the protection that survives
  `git push --no-verify` and a clone that never ran `guard:install`. Require
  review for `.github/workflows/**` (Settings → Rules → Rulesets → New branch
  ruleset → Require a pull request), with a `CODEOWNERS` line naming a reviewer
  for that path. Neither is part of this repository — a ruleset lives in
  GitHub's settings, not in a file here — which is why it is written down here
  instead of implemented.

Recovery, in the order worth trying: read the refusal, which names the file and
the reason the guard wants; if the change is intended, give the reason and push
again; if the guard is refusing something it should not, `git push --no-verify`
(it is git's own escape hatch and it is visible in the command you ran); if the
hook itself is unwanted in this checkout, `npm run guard:uninstall`. One refusal
is not about content at all: if the audit line cannot be written — a read-only
`.git`, or `STRATEGYOPTION_PUSH_GUARD_LOG` pointing at something unwritable — the push
is refused, because an authorisation that cannot be recorded is not one. And when
the question is what has been authorised here before, `npm run guard:audit`
answers it without touching the trail.

### Before pushing

```bash
git status                             # what is modified, and what is untracked
git fetch origin                       # what the remote has that you do not
git rev-parse --abbrev-ref HEAD        # main
git rev-parse HEAD origin/main         # two identical SHAs means nothing to pull first
git remote -v                          # origin -> github.com/justcallmedavy-art/strategyoption.git
npm run guard:push                     # would this push carry a workflow change?
```

Then the two checks CI runs on every push. `npm test` needs nothing but Node:

```bash
npm test
```

The frontend gate judges an artifact, so build the snapshot the way a deploy
does, serve it, and read the API base back out of the served bundles:

```bash
STRATEGYOPTION_API_URL=https://<api-host> npm run deploy:snapshot
npx http-server deploy/strategyoption -p 4181 -c-1 --silent &
SRV=$!
npm run verify:frontend -- --url http://127.0.0.1:4181 \
  --expect-api https://<api-host> --no-api-health --expect-build deploy/strategyoption
STATUS=$?
kill $SRV
echo "frontend gate exit=$STATUS"
```

`--no-api-health` is deliberate: this is judging the artifact, and the API host
may not exist yet. Withhold it (and pass a reachable `--expect-api`) when the
question is whether the *deployed* pair is connected — that is §5, and it is what
the `frontend-live` job runs with nothing withheld.

The PostgreSQL suites are CI's other half and are not needed for a change that
touches no ledger code; run them the way CI does when a push does (README,
"Running the same checks locally").

### Commit, then push

Read the diff before staging, and stage the paths you changed rather than
everything:

```bash
git diff
git add DEPLOY.md
git commit -m "…"
git push origin main
```

### Troubleshooting

| What you see | What it means | What to do |
| --- | --- | --- |
| `remote: Invalid username or token. Password authentication is not supported for Git operations.` then `fatal: Authentication failed` | The store handed back a token GitHub no longer accepts — expired or revoked | rotate: the `reject` / `approve` pair above |
| `remote: Permission to justcallmedavy-art/strategyoption.git denied to <user>` | The token is real but cannot write here: wrong repository selected, or read-only | check **Repository access** and **Contents: Read and write** on the token |
| `fatal: could not read Username for 'https://github.com'` | No credential stored, and nothing can prompt for one | store one as above |
| `! [remote rejected] main -> main (refusing to allow a Personal Access Token to create or update workflow .github/workflows/ci.yml without workflow scope)` | The push reached GitHub and was refused because the commit touches `.github/workflows/`, and the credential may not edit workflows | use the fine-grained token with **Workflows: Read and write**, or add the `workflow` scope to a classic one |
| `! [rejected] main -> main (fetch first)` or `(non-fast-forward)` | The remote moved — another machine, or a merge done in the web UI | `git fetch origin`, re-apply the work on top of `origin/main`, push again |
| `remote: error: GH013: Repository rule violations found` / `protected branch` | Branch protection wants a pull request | push a branch and open a PR; do not weaken the rule to make one push land |
| `refused, nothing was pushed` and `the push changes .github/workflows/…` | The outgoing commits change a workflow file and no reason was given | `STRATEGYOPTION_WORKFLOW_PUSH_REASON="<why>" git push`; see "The push guard" above |
| `the push guard could not decide` | A question the guard needs answered failed — a hook line it could not read, a commit it could not open — so nothing was checked and nothing was allowed | run `git fetch origin` and retry; `git push --no-verify` if you mean to skip it |
| `npm run guard:audit` lists a record as *malformed* or *incomplete* | A line in `.git/strategyoption-push-guard.log` is not one the writer produces: edited, truncated, or a write that stopped mid-line | read the line `--audit` prints verbatim; `--check` exits 1 until it is dealt with, and removing that line (or the whole file) is safe — nothing reads the trail to decide anything |
| `guard:audit` reports *the remote value carries userinfo* | A record was written before the writer redacted the destination, so it holds what may be a credential | `--check` fails on it and prints the value redacted; remove that line. The reader reports a credential in the trail, it does not scrub one |
| `guard:audit` shows `records: none` although a push was refused | Expected: a refusal is printed when it happens and is not written to the trail | nothing to fix; the trail records authorisations, not attempts |
| `guard:audit` shows `authorised 0` where you expect records | The trail is per checkout — a clone or another machine has its own `.git` and its own file | read the trail in the checkout that pushed, or point `STRATEGYOPTION_PUSH_GUARD_LOG` at a copy of that file |
| CI red where the same commands passed locally | The runner starts from a clone and the lockfile: no `dist/`, no `.data/`, no `deploy/`, nothing already built | read the failing step's output — the usual cause is a command that only works where something was built before it |
| `frontend-live` reports *skipped* | Working as intended: the two production variables are unset | set `PRODUCTION_FRONTEND_URL` and `PRODUCTION_API_URL` once a deployment exists (§5) |

One thing to know before blaming a credential: on this repository a *read*
proves nothing, because it is public — `git ls-remote origin` succeeds with no
credential at all. The write probe that does answer the question creates nothing:

```bash
git push --dry-run origin HEAD:refs/heads/strategyoption-credential-check
# * [new branch]      HEAD -> strategyoption-credential-check
```

`--dry-run` negotiates with GitHub, so a refused or bogus token fails right there
with exit 128, yet the ref is never created —
`https://github.com/justcallmedavy-art/strategyoption/branches` stays unchanged. It is
the cheapest way to tell a stale credential from a stale remote.

## 11. Running the split deployment from this machine (temporary)

This is the shape the live site is in today, and it is the one that broke on
2026-10-18: the Vercel frontend was pointed at a Cloudflare *quick* tunnel whose
hostname had died, so every sign-in answered `Failed to fetch` — which reads like
a wrong password, and was reported as a lost account. It was neither. The accounts
were in Postgres the whole time.

A quick tunnel is fine for a demo and wrong for anything you expect to survive the
night. Use the Railway or Render routes in §2, with a real `DATABASE_URL`, for
anything that has to stay up.

```bash
# 1. the ledger — a real database, not the in-process Map. Without DATABASE_URL
#    the API still serves, and every account is gone after the next restart.
node tools/pg-local.mjs start
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/strategyoption_test"
npm run migrate

# 2. the API, with the frontend's origin allowed to call it
set -a && . ./.env.local && set +a
export ALLOWED_ORIGINS="https://strategyoption.vercel.app"
nohup node tools/server.mjs 4174 > .logs/api.log 2>&1 &

# 3. expose it. The hostname changes on every start, which is why step 4 exists.
./.tools/cloudflared.exe tunnel --url http://127.0.0.1:4174 --no-autoupdate \
  > .logs/tunnel.log 2>&1 &
grep -o "https://[a-z0-9-]*\.trycloudflare\.com" .logs/tunnel.log | head -1

# 4. rebuild the frontend against that hostname and publish it
STRATEGYOPTION_API_URL="https://<the-tunnel-host>" \
STRATEGYOPTION_PAYMENTS_ENV=sandbox \
  npm run deploy:prod
```

Then check the three things that decide whether sign-in can work at all:

```bash
curl -s "$API/healthz"                                  # {"ok":true,"storage":"postgres"}
curl -s -o /dev/null -w '%{http_code}\n' "$API/api/auth/login" -X POST \
  -H 'Content-Type: application/json' -d '{}'           # 401, i.e. reachable
curl -s "$API/api/auth/login" -X POST -H 'Origin: https://strategyoption.vercel.app' \
  -H 'Content-Type: application/json' -d '{}' -D - -o /dev/null | grep -i allow-origin
```

`"storage":"memory"` in the first answer means step 1 was skipped: accounts will
look fine until the API restarts and then be gone. A 000 or a hang on the second
means the tunnel (step 3) is down, or the hostname baked into the frontend in
step 4 is not the one the tunnel is actually serving.

The sign-in page now says which of those it is. An unreachable API reports itself
and states that nothing was changed, instead of the browser's "Failed to fetch";
the address used last is remembered and pre-filled after a sign-out. Neither
touches the account, which no endpoint can delete — signing out removes a token
from localStorage and nothing else.

`DARAJA_CALLBACK_URL` in `.env.local` carries the tunnel hostname too, so it has
to be updated with it (§4) or sandbox callbacks stop arriving.
