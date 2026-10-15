# PalOption mirror (`site/`)

A byte-for-byte local copy of `https://paloptions.com`, produced by
[tools/mirror.mjs](tools/mirror.mjs). Every file keeps its original URL path, so
absolute references such as `/_next/static/chunks/*.js` resolve unchanged.

## Run it

```bash
npm run serve:mirror     # http://127.0.0.1:4174
```

[tools/server.mjs](tools/server.mjs) serves `site/` as its document root (so
`/_next/...` resolves) **and** implements the API the client expects. It has no
dependencies. State lives in `.data/db.json`; passwords are scrypt-hashed.

## Re-mirror

```bash
node tools/mirror.mjs
```

The crawler starts from every route listed in `ROUTES`, saves each to a directory
index, then follows every same-origin `href`/`src`/`url(...)`/`/_next/...`
reference it finds — including the chunk graph inside the RSC payload. Assets
discovered on one page pull in the chunks needed by others, so a single pass
converges on the full build.

Current result: **17 routes, 59 files, ~2.0 MB**.

## Routes

| Route | Renders | Notes |
| --- | --- | --- |
| `/` | yes | marketing landing page (server-rendered) |
| `/register` | yes | 4 fields, password strength meter, terms checkbox |
| `/login` | yes | credentials + 6-digit 2FA step |
| `/forgot-password` | yes | "Enter your email to receive a verification code" |
| `/download` | yes | Android / iOS app page |
| `/responsible-trading` | yes | static guidance page |
| `/admin/login` | yes | admin sign-in ("Authorized personnel only") |
| `/trade` | redirects to `/login` | auth-guarded terminal |
| `/settings`, `/settings/*` | redirects to `/login` | auth-guarded |
| `/cashier` | redirects to `/login` | auth-guarded |
| `/referrals` | redirects to `/login` | auth-guarded |
| `/admin`, `/admin/dashboard` | redirects to `/admin/login` | separate admin guard |

The redirects are not a defect — that is the app's own session guard deciding
there is no valid session, which is the correct behaviour with no backend. Note
the admin routes use a separate guard and return to `/admin/login` instead.

Verified by navigating each route: `/trade`, `/cashier`, `/referrals`,
`/settings`, `/settings/profile` land on `/login`; `/admin` and
`/admin/dashboard` land on `/admin/login`.

## What is deliberately changed

`https://api.paloption.com` is rewritten to `""` in the six chunks that
reference it. The app therefore calls `/api/auth/*` and `/ws` on
`localhost:4174`, where this project's own server answers them.

This is intentional: without it, the local copy would send whatever you typed in
the login form to PalOption's **live production API**. Seven references were
neutralised across six files. To point it back at a real backend, edit
`REWRITES` in [tools/mirror.mjs](tools/mirror.mjs) and re-run.

## Brand re-colour

The site ships a violet brand (`#7C3AED`) with a pink accent (`#EC4899`). This
copy is served with a warm **ember** (`#ff4d2e`) primary and a deep **blue**
(`#2563eb`) secondary, so the two-tone gradient runs ember → blue instead of
violet → pink.

The swap is applied **on the way out**, not on disk. `site/` is still exactly
what upstream ships, and `npm run mirror` still reproduces it; a re-mirror that
restores the original violet is re-coloured again automatically. That also means
the fork survives a re-crawl, which a disk edit would not.

Three things carry the palette, and all three are handled:

| Carrier | How |
| --- | --- |
| Stylesheets, markup, chunks | text pass over `#rrggbb`, `rgb()`/`rgba()` — see [tools/palette.mjs](tools/palette.mjs) |
| The two raster marks (`favicon.ico`, `icon.png`, `apple-icon.png`, `icons/*`) | pixel pass — see [tools/icon-recolor.mjs](tools/icon-recolor.mjs) |
| Near-black surfaces (`#141021`, `#1f1936`, …) | included in the text pass |

The surface greys matter: they are near-black with a violet cast, so changing
only the accents would have left the whole dark theme looking purple.

`RECOLOR=0` serves the original violet/pink palette untouched. It is separate
from `PATCH_CLIENT=0`, which only disables the behaviour fixes below.

### Why the icons are not a hue rotation

The mark is a violet → magenta gradient badge. The two brand anchors sit at 262°
and 330°, the new ones at 13° and 221°, and no path between 13° and 221° avoids
either green (up through 120°) or purple (down through 300°). A straight hue
stretch measured **60% green pixels** and looked nothing like the brand.

Instead each pixel is repainted by its position in the gradient through three
stops — ember → orange → deep blue — keeping its own luminance so the badge's
shading and the white glyph survive. Measured over the raster: 63% warm, 14%
blue, 0% green, with a muted rose only in the transition sliver.

Two consequences worth knowing:

* The pixel pass is **not** a fixed point — it reads a pixel's colour to decide
  what it becomes, so running it on its own output walks the transition pixels
  further along. [tools/recolor.mjs](tools/recolor.mjs) therefore always
  regenerates the rebuild's marks from the pristine copy in `site/`, which makes
  the result byte-identical on every run.
* `#9945ff` is deliberately **not** remapped: it is Solana's own brand mark (the
  SOL ticker badge and the SOL chart colour), not the site's theme.

## Local API

Without this the client failed on every call with *"Unexpected end of JSON
input"* — the static server answered POSTs with a 405 and an empty body.

Implemented in [tools/server.mjs](tools/server.mjs):

| Endpoint | Purpose |
| --- | --- |
| `POST /api/auth/register` | creates the account, returns `{token,user}` |
| `POST /api/auth/login` | returns `{token,user}`, or `{requires2FA,tempToken}` |
| `POST /api/auth/login/verify-2fa` | completes the 2FA step |
| `POST /api/auth/demo` | one-tap demo account |
| `GET /api/auth/me` | session lookup via `Bearer` token |
| `POST /api/auth/switch-account` | demo ⇄ real toggle |
| `POST /api/auth/reset-demo` | resets the demo balance to $10,000 |
| `GET /api/trade/positions` | `{positions}` |
| `GET /api/transactions` | `{transactions}` |
| `GET /api/auto-trading/status` | `{session}` |
| `GET /api/auth/exchange-rate` | live USD/KES rate — public, cached, never fabricated |
| `POST /api/auth/mpesa/stk-push` | records a deposit intent, then sends a real STK Push; `503` until Daraja is configured |
| `POST /api/auth/mpesa/callback/:token` | Daraja's result; settles the deposit exactly once |
| `POST /api/auth/card/deposit` | records a deposit intent; `503` until a processor is configured |
| `GET /api/auth/trc20/my-address` | the operator's deposit wallet (`200`), or `503`; never invented |
| `GET /api/auth/deposits` | the caller's deposits (the client polls this) |
| `GET /api/auth/deposits/:reference` | one deposit, ownership enforced |
| `GET /ws` | price feed + trade placement |

Every `/api/*` response is JSON including errors, so the client can always parse it.

The cashier endpoints are real handlers with real validation, but **no payment
provider is integrated** — they refuse rather than fake a success. See
[PAYMENTS.md](PAYMENTS.md) for what is live, the environment variables each one
needs, and the two client-side defects fixed at serve time.

### WebSocket protocol

Recovered from the bundle, and the reason the frames look asymmetric. Client
sends `auth`, `subscribe`, `manual_trade`, `auto_trading_start`,
`auto_trading_stop`, `auto_trading_status`. Server sends `price`,
`balance_update`, `position_update` (with an `add`/`close` action),
`transaction_update`, `trade_error`, `auto_trading_response` (carrying `session`
at the **root**) and `auto_trading_update` (carrying it in `data`).

### The trading engine

Trades are settled server-side by [tools/server.mjs](tools/server.mjs), one tick
per second. Each position records its `entry_price` and `entry_digit`, then
settles after its `ticks` duration against the live digit. A win credits the
position's `potential_payout`, a loss credits nothing, and the settlement plus
its balance and ledger writes are persisted together — a `settled_at` guard means
a restart mid-trade cannot settle the same position twice.

**The client sends no contract type.** This is the part that is easy to get
wrong. Both `manual_trade` and `auto_trading_start` send only `direction`, plus
`selectedDigit` when the contract needs one — captured verbatim from the panel:

```json
{"type":"manual_trade","config":{"direction":"over","stake":10,"asset":"volatility_10_1s","isDemo":true,"selectedDigit":5}}
```

The contract is therefore *derived from the direction*, and a server that
assumes `even_odd` books every "over 5" as an even/odd trade with no target —
which can never win (its direction is neither `even` nor `odd`) and pays the
wrong amount. The three contracts the UI offers:

| Contract | Directions | Payout per $1 | Rule for a win |
| --- | --- | --- | --- |
| `even_odd` | `even`, `odd` | **1.9522** (the panel's 95.22%) | exit digit even / odd |
| `over_under` | `over`, `under` | **10 / (winning digits) × 0.95** | `exit_digit > d` / `< d` |
| `match_differ` | `match`, `differ` | **9.5** (match), **10/9 × 0.95** (differ) | `exit_digit === d` / `!== d` |

The `over_under` payout is digit-dependent, and the panel's own arithmetic is the
same formula: "Over 5" on a $10 stake shows 137.5% / $23.75, "Under 5" shows
90.0% / $19.00. `match_differ` and `over_under` are refused without a digit, and
sides with no winning digit at all ("over 9", "under 0") are refused rather than
taken as a guaranteed loss — the client blocks both too ("Cannot bet Over 9 - no
digits above 9").

**Duration is the one thing not recovered.** No frame carries it, the panel has no
selector, and the mirror's copy says nothing, so there is nothing to read it from;
the client just renders whatever `ticks` the server reports. This server settles
after **5 ticks** — an assumption of this implementation, overridable per trade
with `ticks`, and printed in the startup banner so it is never mistaken for a
fact. `DEFAULT_TICKS` in [tools/server.mjs](tools/server.mjs) is the one value to
change if the real duration ever turns up.

There are no draw/refund states and no `rise/fall` in the panel; `rise_fall` is
implemented but unreachable, and the client has no handler that would ask for it.

### Auto-trading

`auto_trading_start` runs a **real bot**, not a stub. The client sends
`{asset, direction, isDemo, lossMultiple, stake, targetProfit, targetLoss}` — no
contract type or duration, so the contract is derived from `direction` (as above)
and the duration defaults to 5 ticks. The panel's four fields are the whole
config; a bot in Over/Under mode sends `selectedDigit` with the rest. The session
is held in memory per account and is deliberately not persisted, so a restart
clears it — but it survives a reconnect, and a *stopped* session is retained and
handed back, because the panel renders it as "Last Session".

The bot starts only when the panel is in **AUTO** — it defaults to MANUAL, so a
click on a direction button places one manual trade until AUTO is chosen (see
*Client-side fixes*). Once started, it opens its first contract immediately and
the next one a tick after each settlement, through the same code path as
`manual_trade`:

- the stake follows the martingale rule in the client's own copy — reset to the
  base on a win, multiplied by `lossMultiple` on a loss;
- it stops when session P/L reaches `targetProfit` or `-targetLoss`
  (`target_profit_reached` / `target_loss_reached`), on `auto_trading_stop`
  (`stopped_by_user`), or when the next stake no longer fits the balance
  (`insufficient_balance`) — rather than retrying forever;
- every change is pushed as `auto_trading_update`, and `auth_success` carries
  `autoTrading`, so reconnecting restores the panel instead of losing the
  session;
- stopping stops *opening* trades. A contract already open when the user stops
  still settles and is booked, because its stake was already committed —
  dropping it would understate what the session actually won or lost.

`GET /api/auto-trading/status` returns the same session, or `null`.

### Assets

The terminal trades **Deriv-style synthetic volatility indices**, not the
crypto/forex ticker on the landing page — the client's default is
`volatility_10_1s`. The server publishes all 13 ids it subscribes to
(`volatility_10` … `volatility_100_1s`), each with `lastDigit`, `sequence`,
`history` and `digitStats` (the digit-distribution bar).

### Client-side fixes

Three defects in the mirrored bundle are fixed at serve time by
[tools/client-patches.mjs](tools/client-patches.mjs) so this copy stays faithful
and re-mirroring stays safe. Two break the deposit modal:

- the TRC20 address effect re-ran on its own loading flag, firing **50+ requests
  in 12 seconds** from a single modal open (now 1);
- the exchange-rate fallback was silent, so an unreachable rate left the modal
  rendering a hardcoded conversion as if it were live.

The third is the Even/Odd buttons, which traded on their own until they were
fixed. The panel has two modes and the direction buttons do something different
in each: in `auto` a click posts `auto_trading_start`, so the server runs a
martingale bot on the position; in `manual` the same click posts `manual_trade`
and exactly one position opens. The panel was initialised to `auto`.

Nothing on screen said the first click was a bot start — the buttons are
labelled with a payout ("Even · 95.2% · $19.52 Payout"), which reads as a single
bet, and the mode toggle sits above them unselected by the reader. Measured on
this build, **one click opened ten settled trades** and doubled the stake
(10 → 20 → 40 → 80) before STOP, the MANUAL toggle or a target stopped it. Both
the desktop panel and the mobile panel now initialise to `manual`: one click
places one trade, and AUTO has to be chosen deliberately. Nothing else changes —
the toggle, the STOP state, both modes and the martingale engine are exactly as
they were.

Each edit is anchored on an exact string and skipped, not guessed, if the
upstream bundle changes. `PATCH_CLIENT=0` serves the bundle untouched.

### Not implemented

The client calls roughly 70 endpoints. Not covered: withdrawals, chat, push
notifications, referrals, verification uploads, password reset, and the entire
`/api/admin/*` surface. Those routes still return a JSON 404.

Deposits go further than the rest of the API: the validation, intent, ledger and
settle-once logic are real and tested, and M-Pesa is a **real Daraja
integration** — OAuth, STK Push and the result callback in
[tools/daraja.mjs](tools/daraja.mjs) — that returns `503` only until credentials
are supplied. It is verified against a stand-in for Safaricom, not against
Safaricom. Cards still refuse rather than pretend.

The USDT (TRC20) panel is the one exception: the server ships an operator wallet
(`TRON_DEPOSIT_ADDRESS`, defaulted to the address in
[tools/payments.mjs](tools/payments.mjs)), so it displays a real, fundable
address instead of a spinner. That address is shared by every account, so it
still cannot attribute a deposit — crediting a balance needs an on-chain
confirmation the server verifies, and there is none. **Sending USD₮ there will
not credit a wallet in this mirror.** See [PAYMENTS.md](PAYMENTS.md).

One known simplification: for indices whose pips are not 2 decimals, the digit
derivation may differ from the real feed.

## Two caveats

**Fonts are still external.** `IBM Plex Sans` loads from `fonts.googleapis.com`
/ `fonts.gstatic.com`, exactly as the original does. Mirror those too if you need
fully offline operation.

**This is someone else's site.** The markup, styles, scripts, logos and copy are
PalOption's. Keep `site/` local for development and testing; do not republish or
deploy it as your own.

**This is a simulation.** Balances, prices and settlements are invented locally.
No money moves, and no payment provider is involved. The price feed is a random
walk, so the bot is a real martingale applied to a coin flip: the staking maths
is correct and the edge it implies is not.

Note also that this platform ships an admin endpoint called
`/api/admin/price-engine/manipulate` — a server-side price manipulation control.
Worth knowing what you are cloning.
