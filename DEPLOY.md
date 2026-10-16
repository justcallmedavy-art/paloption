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
§5 with `WEB` set to your API host. §9 is the push recipe, for whoever is doing
the committing.

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
       `https://paloption.vercel.app` — no trailing slash. Without it every
       browser request to this API is `403 ORIGIN_NOT_ALLOWED`, sign-in
       included.
     - **This service serves the client too** (one origin): leave it **empty**.
       A same-origin request is accepted with no value at all, and setting a
       wrong one here would refuse the requests the app makes to itself.
   - **`TRON_DEPOSIT_ADDRESS`** — a wallet you control, because this one moves
     money. Set it to an empty string only if you do not want to offer USDT
     deposits at all; leaving it **unset** shows depositors a wallet built into
     the source that is not yours.
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

`deploy:snapshot` runs `npm run build` first, because the landing page embeds
`dist/styles.css` and `dist/` is gitignored — without that step the command
fails on a fresh clone with `landing source is missing: dist/styles.css`.

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

The page still returns 200 when that value is wrong or missing, and the only
symptom is a sign-in that cannot work, so check what the bundle actually
resolves once the deployment is up:

```bash
npm run verify:frontend -- --url https://paloption.vercel.app \
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
npm run verify:frontend -- --url https://paloption.vercel.app --expect-api https://<api-host>
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
git remote -v                          # origin -> github.com/justcallmedavy-art/paloption.git
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

Two commands are all the store needs — a rotation is this pair, and nothing else
has to change:

```bash
# forget the stored credential, before storing a new one
printf 'protocol=https\nhost=github.com\nusername=justcallmedavy-art\n\n' | git credential reject

# store a new one without echoing it and without it reaching the history
read -rsp "Paste the token: " NEW_TOKEN && echo
printf 'protocol=https\nhost=github.com\nusername=justcallmedavy-art\npassword=%s\n\n' "$NEW_TOKEN" | git credential approve
unset NEW_TOKEN
```

`read -s` keeps the paste off the screen, and because the token only ever appears
as `$NEW_TOKEN` the shell's history holds the command rather than the secret. It
does not belong in a tracked file, a script, `deploy/`, or an environment
variable the app reads — no part of this application consumes it.

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

Create it at **Profile → Settings → Developer settings → Personal access tokens
→ Fine-grained tokens → Generate new token**:

| Field | Value |
| --- | --- |
| Resource owner | `justcallmedavy-art` — the account that owns the repository |
| Repository access | **Only select repositories** → `paloption` |
| Repository permissions → Contents | **Read and write** — the push itself |
| Repository permissions → Workflows | **Read and write** — committing under `.github/workflows/` |
| Expiration | the shortest you will keep re-picking; the classic token this replaced expired a month after it was made, and a credential that expires mid-task is indistinguishable from a broken remote |

Nothing else belongs on it: the app's remaining GitHub needs are either public
or supplied by the runner, so no `Administration`, no `Secrets`, no organisation
access. The username stays `justcallmedavy-art` — over HTTPS the account name is
not what authenticates, so a fine-grained token replaces a classic one
one-for-one with no remote change.

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

### Before pushing

```bash
git status                             # what is modified, and what is untracked
git fetch origin                       # what the remote has that you do not
git rev-parse --abbrev-ref HEAD        # main
git rev-parse HEAD origin/main         # two identical SHAs means nothing to pull first
git remote -v                          # origin -> github.com/justcallmedavy-art/paloption.git
```

Then the two checks CI runs on every push. `npm test` needs nothing but Node:

```bash
npm test
```

The frontend gate judges an artifact, so build the snapshot the way a deploy
does, serve it, and read the API base back out of the served bundles:

```bash
PALOPTION_API_URL=https://<api-host> npm run deploy:snapshot
npx http-server deploy/paloption -p 4181 -c-1 --silent &
SRV=$!
npm run verify:frontend -- --url http://127.0.0.1:4181 \
  --expect-api https://<api-host> --no-api-health --expect-build deploy/paloption
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
| `remote: Permission to justcallmedavy-art/paloption.git denied to <user>` | The token is real but cannot write here: wrong repository selected, or read-only | check **Repository access** and **Contents: Read and write** on the token |
| `fatal: could not read Username for 'https://github.com'` | No credential stored, and nothing can prompt for one | store one as above |
| `! [remote rejected] main -> main (refusing to allow a Personal Access Token to create or update workflow .github/workflows/ci.yml without workflow scope)` | The push reached GitHub and was refused because the commit touches `.github/workflows/`, and the credential may not edit workflows | use the fine-grained token with **Workflows: Read and write**, or add the `workflow` scope to a classic one |
| `! [rejected] main -> main (fetch first)` or `(non-fast-forward)` | The remote moved — another machine, or a merge done in the web UI | `git fetch origin`, re-apply the work on top of `origin/main`, push again |
| `remote: error: GH013: Repository rule violations found` / `protected branch` | Branch protection wants a pull request | push a branch and open a PR; do not weaken the rule to make one push land |
| CI red where the same commands passed locally | The runner starts from a clone and the lockfile: no `dist/`, no `.data/`, no `deploy/`, nothing already built | read the failing step's output — the usual cause is a command that only works where something was built before it |
| `frontend-live` reports *skipped* | Working as intended: the two production variables are unset | set `PRODUCTION_FRONTEND_URL` and `PRODUCTION_API_URL` once a deployment exists (§5) |

One thing to know before blaming a credential: on this repository a *read*
proves nothing, because it is public — `git ls-remote origin` succeeds with no
credential at all. The write probe that does answer the question creates nothing:

```bash
git push --dry-run origin HEAD:refs/heads/paloption-credential-check
# * [new branch]      HEAD -> paloption-credential-check
```

`--dry-run` negotiates with GitHub, so a refused or bogus token fails right there
with exit 128, yet the ref is never created —
`https://github.com/justcallmedavy-art/paloption/branches` stays unchanged. It is
the cheapest way to tell a stale credential from a stale remote.
