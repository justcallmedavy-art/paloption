# PalOption

Two things live here:

- **The application** — a trading platform (`site/`, a mirror of the original
  Next.js client) with a Node service behind it: accounts, a `/ws` price feed,
  server-side trade settlement, an auto-trading bot, and a cashier wired to real
  M-Pesa and TRON endpoints. The ledger is **PostgreSQL**. See
  [MIRROR.md](MIRROR.md) for what is real and what is a mirror, and the
  [deployment guide](DEPLOY.md) for the split frontend/backend setup.
- **The landing page** — a static, offline-capable rebuild of
  `https://paloptions.com/`, served at `/landing`.

## Run it locally

```bash
npm install
npm run serve:mirror     # http://127.0.0.1:4174 — API, socket and client
npm test                 # 148 tests, no database or provider needed
```

No `DATABASE_URL`? The ledger runs in memory, which is what the tests use and
what a local session wants. Production refuses to start that way on purpose.

```bash
cp .env.local.example .env.local      # provider credentials, DATABASE_URL
npm run migrate                       # apply tools/schema.sql
npm start                             # PORT=8080 NODE_ENV=production
```

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs three suites on every
push to `main` and every pull request. None of them needs a credential:

| Suite | Command | Needs |
| --- | --- | --- |
| Regression | `npm test` | nothing — in-memory, every provider response is a fixture |
| Settlement and reconciliation | `npm run test:postgres` | the job's disposable `postgres:16` service |
| Contention and concurrency | `npm run test:postgres:stress` | the same service, at load |

The database job starts a throwaway PostgreSQL, applies the real schema with
`npm run migrate`, and only then runs the two database suites against
`PG_TEST_DATABASE_URL`. `DATABASE_URL` is set for the migration step alone: the
stress suite refuses to run when it points at the same database as the test URL,
so the two can never be conflated by accident. No test contacts Safaricom, a
card processor or a TRON custodian, and the suites clear provider credentials
themselves — which is why CI behaves the same as a machine that has real keys.

None of these jobs can pass without a database. The PostgreSQL suites have no
in-memory fallback: without `PG_TEST_DATABASE_URL` they exit non-zero, and
pointed at an unreachable server they fail with the connection error rather than
skipping to a green tick.

A missing suite file is caught too. `node --test` exits 0 when its glob matches
nothing, so each test command runs `tools/check-suites.mjs` first and refuses if
a suite is absent. Without that, a suite that was written but never committed
would produce a green pipeline that ran none of it — CI only ever sees committed
files.

### Running the same three suites locally

```bash
npm test                        # no database needed

node tools/pg-local.mjs url     # Windows: a disposable server, and its URL
PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)" npm run test:postgres
PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)" npm run test:postgres:stress
```

`tools/pg-local.mjs` installs the official PostgreSQL binaries for Windows and
needs no administrator rights (see "A PostgreSQL for the suites" in
[PAYMENTS.md](PAYMENTS.md)). It is Windows-only and says so; on Linux or macOS
use a container instead —
`docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16` — and
point `PG_TEST_DATABASE_URL` at it. What each suite proves, and the knobs for the
contention run (`PG_STRESS_*`), are documented in PAYMENTS.md with the rest of
the payments work.

## Architecture, in one paragraph

The client asks one module where the server is (`getApiUrl`), and everything
follows from it: `/api/*` over https, `/ws` over wss. Left unset, that is
same-origin — the single-host case. Set `PALOPTION_API_URL` and the frontend can
live on Vercel while the API runs wherever a long-lived Node process belongs.
The API accepts browser calls only from origins in `ALLOWED_ORIGINS`, and the
same list gates the WebSocket, which CORS would otherwise not cover. Balances,
positions, deposits and sessions are rows in Postgres; a deposit and a position
are each settled exactly once, enforced by the database rather than by a lock in
one process.

---

## The landing page

A static, offline-capable rebuild of the `https://paloptions.com/` landing page
(originally a Next.js + Tailwind app). No framework, no runtime dependencies —
just hand-written HTML plus a compiled Tailwind stylesheet.

## Run it

```bash
npm install       # Tailwind CLI + a static server
npm run build     # compiles src/input.css -> dist/styles.css
npm run serve     # http://127.0.0.1:4173
```

While styling, keep Tailwind rebuilding on save:

```bash
npm run dev
```

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | The whole page: nav, hero, price ticker, trading preview, features, steps, stats, reviews, CTA, app banner, footer |
| `src/input.css` | Tailwind entry point plus the light-theme overrides |
| `tailwind.config.js` | Scans `index.html`, defines the `marquee` keyframes |
| `js/main.js` | Theme toggle, simulated live BTC/USD ticker + chart, live-trades feed |
| `dist/styles.css` | Build output (generated — edit `src/input.css`, not this) |
| `icons/`, `favicon.ico`, `icon.png`, `apple-icon.png`, `manifest.json` | PWA icons and manifest from the original site, re-coloured |
| `tools/recolor.mjs` | Re-applies the brand palette to the files above (`npm run recolor`) |

## Notes on fidelity

* Markup, copy, colours, spacing and the inline SVG line icons match the
  original's server-rendered output. The **palette does not**: the original is
  violet (`#7C3AED`) on pink (`#EC4899`), and this copy is served in ember
  (`#ff4d2e`) and blue (`#2563eb`). See "Brand re-colour" in
  [MIRROR.md](MIRROR.md) — the same palette is applied to the mirror, where the
  swap happens at serve time instead of on disk.
* The raster marks are images, so they take a pixel pass rather than a colour
  substitution. Run `npm run recolor` after adding a page by hand; it is
  idempotent and exits non-zero under `--check` if anything still carries the
  old palette.
* The original shipped `animate-[marquee_...]` without ever defining a
  `marquee` keyframe, so its ticker never actually moved. This clone defines
  the keyframes, so the ticker scrolls.
* The original's light/dark toggle had no light palette in its stylesheet; this
  clone implements a working light theme.
* Prices, the chart and the trade feed are client-side simulation only — there
  is no backend and no real market data.

## Not included

The original is a multi-page app; only the landing page is cloned. Links to
`/login`, `/register`, `/trade` and `/download` are inert (`#`).
