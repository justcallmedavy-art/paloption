/**
 * Local server for the mirrored PalOption client.
 *
 * Serves site/ as static files and implements the API the client expects, so
 * signup/login/2FA/trading actually complete instead of failing on a 405 HTML
 * body (which is what produced "Unexpected end of JSON input").
 *
 * Endpoints (recovered from the client bundle):
 *   POST /api/auth/register            {email,password,username,referralCode} -> {token,user}
 *   POST /api/auth/login               {email,password}  -> {token,user} | {requires2FA,tempToken}
 *   POST /api/auth/login/verify-2fa    {tempToken,code}  -> {token,user}
 *   POST /api/auth/demo                {}                -> {token,user}
 *   GET  /api/auth/me                  Bearer            -> {user}
 *   POST /api/auth/switch-account      {mode}            -> {user,token}
 *   POST /api/auth/reset-demo          Bearer            -> {user}
 *   GET  /ws  (WebSocket)              see the protocol note below
 *
 * Every /api/* response is JSON, including errors, so the client can always
 * parse it. Storage is a single JSON file; passwords are scrypt-hashed.
 *
 * WebSocket contract, read out of the client's own onmessage handler:
 *
 *   client -> server   auth{token}, subscribe{asset}, manual_trade{config},
 *                      auto_trading_start{config}, auto_trading_stop,
 *                      auto_trading_status
 *   server -> client   price{data}, balance_update{data},
 *                      position_update{action:"add"|"close", data},
 *                      transaction_update{data}, auth_success{data},
 *                      auth_error{data}, auto_trading_update{data},
 *                      auto_trading_response{session}
 *
 * Two details are easy to get wrong and are load-bearing:
 *   - it is `position_update`, and `action` sits at the message ROOT, not
 *     inside `data`. There is no `positions` message type in the client.
 *   - `auto_trading_response` carries `session` at the ROOT, not in `data`.
 * The client also ignores any position whose is_demo does not match the mode
 * the user is currently in, so both fields have to agree.
 *
 * Trades settle here, not in the client: one tick per second for `ticks`
 * seconds, +95% on a win. `auto_trading_start` runs a real martingale bot on
 * that same code path, so manual and bot trades cannot drift apart. See
 * MIRROR.md for the bot's stop conditions.
 *
 * Usage: node tools/server.mjs [port]
 */
import http from "node:http";
import crypto from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, basename } from "node:path";
import {
  ApiError,
  createPaymentRoutes,
  config as paymentConfig,
  DEFAULT_TRON_DEPOSIT_ADDRESS,
} from "./payments.mjs";
import {
  patchApiBase,
  patchClientChunk,
  apiBaseFromEnv,
  fixUnparseableErrorMessages,
  isPatchableChunk,
  isRecolorable,
  isRecolorableImage,
} from "./client-patches.mjs";
import { recolor } from "./palette.mjs";
import { recolorIcon } from "./icon-recolor.mjs";
import { createStore, round2 } from "./store.mjs";

// Port precedence: an explicit argument (which the tests use, PORT=0 to let the
// OS choose), then the host's PORT variable, then the local default. Hosting
// platforms assign PORT and expect it to be honoured.
const PORT = Number(process.argv[2] || process.env.PORT || 4174);
// Containers must accept connections from outside their own namespace, so bind
// all interfaces by default rather than only loopback.
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = "site";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".apk": "application/vnd.android.package-archive",
};

/* ----------------------------- storage ----------------------------- */
/**
 * The ledger is PostgreSQL (see tools/store.mjs). There is no local file any
 * more: balances, positions, deposits, sessions and second-factor challenges all
 * live in the database, so replacing an instance cannot lose a trade and two
 * instances cannot disagree about a balance.
 *
 * Assigned during boot, before the server accepts a connection.
 */
let store = null;

const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString("hex");
const token = () => crypto.randomBytes(24).toString("hex");
const id = (p) => p + "_" + crypto.randomBytes(6).toString("hex");

function publicUser(u) {
  const balance = u.is_demo ? u.demo_balance : u.real_balance;
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    is_demo: u.is_demo,
    two_factor_enabled: !!u.two_factor_enabled,
    balance,
    demo_balance: u.demo_balance,
    real_balance: u.real_balance,
    referral_code: u.referral_code,
    created_at: u.created_at,
  };
}

function newUser({ email, username, password, is_demo = true, demo_balance = 10000, real_balance = 0 }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: id("u"),
    email: String(email || "").trim().toLowerCase(),
    username: String(username || "Trader").trim(),
    salt,
    password_hash: hash(password || crypto.randomBytes(8).toString("hex"), salt),
    is_demo,
    demo_balance,
    real_balance,
    two_factor_enabled: false,
    referral_code: crypto.randomBytes(3).toString("hex").toUpperCase(),
    created_at: new Date().toISOString(),
  };
}

async function authorised(req) {
  const header = req.headers.authorization || "";
  const t = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!t) return null;
  const userId = await store.userIdForToken(t);
  return userId ? store.findUserById(userId) : null;
}

/* ----------------------------- helpers ----------------------------- */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Reads credentials from .env.local (git-ignored) so provider secrets never sit
 * in this file, in a shell history, or in a chat transcript.
 *
 * A variable that is already present in the environment always wins — including
 * one explicitly set to empty, which is how a test or a throwaway shell keeps a
 * provider deliberately unconfigured even on a machine that has credentials.
 */
async function loadEnvFile(path = ".env.local") {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rest] = match;
    if (name in process.env) continue;
    let value = rest.trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
    loaded += 1;
  }
  return loaded;
}

/* -------------------------- cors and origins -------------------------- */
/**
 * Which browser origins may call this API and open a WebSocket.
 *
 * The frontend and this service are separate deployments now, so the browser
 * sends an Origin header that has to be recognised. Three cases are allowed:
 *
 *   - no Origin at all — a non-browser client (curl, the test suite, or the
 *     mirrored client this process serves itself); CORS does not apply;
 *   - the origin's host matches the Host the request arrived on (same origin);
 *   - the origin is listed in ALLOWED_ORIGINS.
 *
 * ALLOWED_ORIGINS is what lets a site on another host talk to a deployment, and
 * it gates the socket as well as the API: a WebSocket handshake is exempt from
 * CORS, so without this check any page could open one to this server.
 *
 * Read per request, deliberately: .env.local is loaded during boot, which is
 * after this module's top level has already run.
 */
const allowedOrigins = () =>
  (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const sameOrigin = (origin, req) => {
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
};

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function originAllowed(origin, req) {
  if (!origin) return true;
  const clean = origin.replace(/\/+$/, "");
  if (allowedOrigins().includes(clean)) return true;
  if (sameOrigin(clean, req)) return true;
  // Local development, and only when nothing has been configured.
  if (!allowedOrigins().length && LOOPBACK.test(clean)) return true;
  return false;
}

/* ----------------------------- api ----------------------------- */
async function api(req, res, pathname) {
  const route = `${req.method} ${pathname}`;
  const body = await readBody(req);

  // Parameterised routes first: /api/auth/deposits/:reference
  const depositRef = /^GET \/api\/auth\/deposits\/([^/]+)$/.exec(route);
  if (depositRef) {
    return sendJson(res, 200, await payments.depositStatus({ req, body, params: { reference: decodeURIComponent(depositRef[1]) } }));
  }

  // Safaricom cannot present a Bearer token, so the callback carries its secret
  // in the path. It is still a normal JSON route: every response is JSON.
  const mpesaCallback = /^POST \/api\/auth\/mpesa\/callback\/([^/]+)$/.exec(route);
  if (mpesaCallback) {
    return sendJson(res, 200, await payments.mpesaCallback({ req, body, params: { token: decodeURIComponent(mpesaCallback[1]) } }));
  }

  switch (route) {
    case "POST /api/auth/register": {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return sendJson(res, 400, { error: "Invalid email address" });
      if (!body.password || body.password.length < 6) return sendJson(res, 400, { error: "Password must be at least 6 characters" });
      if (await store.findUserByEmail(email)) return sendJson(res, 400, { error: "An account with this email already exists" });

      let user;
      try {
        user = await store.createUser(newUser({ email, username: body.username || email.split("@")[0], password: body.password }));
      } catch (err) {
        // The unique index on email is the real guard: two simultaneous
        // registrations can both pass the check above, and only one can insert.
        if (err.code === "EMAIL_TAKEN" || err.code === "23505") {
          return sendJson(res, 400, { error: "An account with this email already exists" });
        }
        throw err;
      }
      const t = token();
      await store.createSession(t, user.id);
      console.log(`[register] ${user.email}`);
      return sendJson(res, 200, { token: t, user: publicUser(user) });
    }

    case "POST /api/auth/login": {
      const email = String(body.email || "").trim().toLowerCase();
      const user = await store.findUserByEmail(email);
      if (!user || user.password_hash !== hash(body.password || "", user.salt)) {
        return sendJson(res, 401, { error: "Invalid email or password" });
      }
      if (user.two_factor_enabled) {
        const tempToken = id("tmp");
        const code = String(crypto.randomInt(100000, 999999));
        await store.savePending2fa(tempToken, { userId: user.id, code });
        console.log(`[2fa] code for ${user.email}: ${code}`);
        return sendJson(res, 200, { requires2FA: true, tempToken, devCode: code });
      }
      const t = token();
      await store.createSession(t, user.id);
      user.is_demo = true;
      await store.updateUser(user.id, { is_demo: true });
      return sendJson(res, 200, { token: t, user: publicUser(user) });
    }

    case "POST /api/auth/login/verify-2fa": {
      // Read first, consume only on a correct code: a mistyped code must not
      // throw away the challenge, but a correct one is spent immediately.
      const pending = await store.findPending2fa(body.tempToken);
      if (!pending) return sendJson(res, 401, { error: "Session expired, please sign in again" });
      if (String(body.code) !== pending.code) return sendJson(res, 401, { error: "Invalid verification code" });
      const user = await store.findUserById(pending.userId);
      await store.takePending2fa(body.tempToken);
      if (!user) return sendJson(res, 401, { error: "Session expired, please sign in again" });
      const t = token();
      await store.createSession(t, user.id);
      return sendJson(res, 200, { token: t, user: publicUser(user) });
    }

    case "POST /api/auth/demo": {
      const user = await store.createUser(newUser({ email: `demo+${Date.now().toString(36)}@example.com`, username: "Demo Trader" }));
      const t = token();
      await store.createSession(t, user.id);
      return sendJson(res, 200, { token: t, user: publicUser(user) });
    }

    case "GET /api/auth/me": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      return sendJson(res, 200, { user: publicUser(user) });
    }

    case "POST /api/auth/switch-account": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      const isDemo = body.mode !== "real";
      await store.updateUser(user.id, { is_demo: isDemo });
      user.is_demo = isDemo;
      return sendJson(res, 200, { user: publicUser(user) });
    }

    case "POST /api/auth/reset-demo": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      await store.updateUser(user.id, { demo_balance: 10000, is_demo: true });
      user.demo_balance = 10000;
      user.is_demo = true;
      return sendJson(res, 200, { user: publicUser(user) });
    }

    case "GET /api/trade/positions": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      const positions = await store.listPositionsByUser(user.id);
      return sendJson(res, 200, { positions });
    }

    case "GET /api/transactions": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      const transactions = await store.listTransactionsByUser(user.id);
      return sendJson(res, 200, { transactions });
    }

    case "GET /api/auto-trading/status": {
      const user = await authorised(req);
      if (!user) return sendJson(res, 401, { error: "Not authorised" });
      return sendJson(res, 200, { session: publicSession(botSessions.get(user.id)) ?? null });
    }

    /* ---------------- cashier / deposits ---------------- */
    case "GET /api/auth/exchange-rate":
      return sendJson(res, 200, await payments.exchangeRate({ req, body }));
    case "POST /api/auth/mpesa/stk-push":
      return sendJson(res, 200, await payments.mpesaStkPush({ req, body }));
    case "POST /api/auth/card/deposit":
      return sendJson(res, 200, await payments.cardDeposit({ req, body }));
    case "GET /api/auth/trc20/my-address":
      return sendJson(res, 200, await payments.trc20Address({ req, body }));
    case "GET /api/auth/deposits":
      return sendJson(res, 200, await payments.listDeposits({ req, body }));

    default:
      // Never return HTML here — that is what breaks the client's JSON.parse.
      return sendJson(res, 404, { error: `No such endpoint: ${route}`, code: "UNKNOWN_ROUTE" });
  }
}

/* ----------------------------- static ----------------------------- */

/**
 * Files this server rewrites on the way out. Two independent transforms, both
 * defined in client-patches.mjs: the brand re-colour (violet/pink -> ember/blue)
 * and the mirrored bundle's deposit-flow fixes. Doing them at serve time keeps
 * `site/` a faithful copy of what upstream ships, and means a future
 * `npm run mirror` that restores the original palette is re-coloured again
 * without a second edit. Transformed bytes are memoised per file.
 */
const transformedFiles = new Map();

async function servedBytes(file) {
  const name = basename(file);
  const ext = extname(file);
  const patchable = isPatchableChunk(name);
  const recolorable = isRecolorable(ext);
  const image = isRecolorableImage(ext);
  if (!patchable && !recolorable && !image) return readFile(file);

  const cached = transformedFiles.get(file);
  if (cached) return cached;

  // Raster brand marks take a pixel pass instead of the text pass.
  if (image) {
    const { buffer, changed, note } = recolorIcon(await readFile(file));
    if (!changed) return readFile(file);
    console.log(`[recolor] ${name}: ${changed} px repainted (${note})`);
    transformedFiles.set(file, buffer);
    return buffer;
  }

  let source = await readFile(file, "utf8");
  let edits = 0;

  if (recolorable) {
    const result = recolor(source);
    source = result.text;
    edits = result.edits;
    if (edits) console.log(`[recolor] ${name}: ${edits} colour value(s) remapped`);
  }

  if (patchable) {
    const { source: patched, applied, skipped } = patchClientChunk(name, source);
    source = patched;
    for (const note of skipped) console.warn(`[client-patch] SKIPPED ${name}: ${note}`);
    if (applied.length) console.log(`[client-patch] ${name}: ${applied.length} edit(s) applied`);
  }

  // Every chunk that carries the client's URL module gets its API/WebSocket base,
  // so this client can be served from one host while the API lives on another.
  let apiEdits = 0;
  let errorEdits = 0;
  if (ext === ".js") {
    const applied = patchApiBase(source, apiBaseFromEnv());
    source = applied.source;
    apiEdits = applied.count;
    if (apiEdits) console.log(`[client-patch] ${name}: API base -> ${apiBaseFromEnv() || "same-origin"}`);

    // Without this, a frontend with no API behind it answers every failed
    // sign-in and sign-up with "Unexpected token 'T', "The page c"... is not
    // valid JSON" — the browser's parser complaint instead of a sentence.
    const messages = fixUnparseableErrorMessages(source, name);
    source = messages.source;
    errorEdits = messages.count;
    for (const note of messages.skipped) console.warn(`[client-patch] SKIPPED ${name}: ${note}`);
    if (errorEdits) console.log(`[client-patch] ${name}: ${errorEdits} unreachable error message(s) made reachable`);
  }

  // Nothing changed — hand back the file exactly as it sits on disk.
  if (!edits && !patchable && !apiEdits && !errorEdits) return readFile(file);

  const bytes = Buffer.from(source);
  transformedFiles.set(file, bytes);
  return bytes;
}

async function staticFile(req, res, pathname) {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const candidates = [join(ROOT, clean)];
  if (clean.endsWith("/")) candidates.push(join(ROOT, clean, "index.html"));
  else {
    candidates.push(join(ROOT, clean + "/index.html"));
    if (!extname(clean)) candidates.push(join(ROOT, clean + ".html"));
  }

  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      const data = await servedBytes(candidate);
      res.writeHead(200, {
        "Content-Type": MIME[extname(candidate)] || "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
      });
      return res.end(data);
    } catch {
      /* try the next candidate */
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

/* ----------------------------- websocket ----------------------------- */
const sockets = new Set();
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

function wsFrame(payload) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function wsSend(socket, obj) {
  if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(obj)));
}

function wsParse(buffer) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    const masked = (buffer[offset + 1] & 0x80) !== 0;
    let len = buffer[offset + 1] & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      len = Number(buffer.readBigUInt64BE(p));
      p += 8;
    }
    const mask = masked ? buffer.subarray(p, p + 4) : null;
    if (masked) p += 4;
    if (p + len > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    if (opcode === 0x8) messages.push({ close: true });
    else if (opcode === 0x1) messages.push({ text: payload.toString("utf8") });
    offset = p + len;
  }
  return messages;
}

/* The platform trades Deriv-style synthetic volatility indices — not the
   crypto/forex ticker shown on the landing page. Asset ids are the ones the
   client subscribes to. */
const INDEX_IDS = [
  "volatility_10", "volatility_25", "volatility_50", "volatility_75", "volatility_100",
  "volatility_10_1s", "volatility_15_1s", "volatility_25_1s", "volatility_30_1s",
  "volatility_50_1s", "volatility_75_1s", "volatility_90_1s", "volatility_100_1s",
];

const PRICES = INDEX_IDS.map((asset, i) => {
  const pct = Number(asset.match(/volatility_(\d+)/)[1]);
  const base = 500 + pct * 37 + (i * 613) % 900;
  return {
    asset,
    base,
    vol: base * (pct / 100) * 0.02,
    price: base,
    open: base,
    tick: 0,
    digits: [],
  };
});

// Contract duration when the client does not name one. The client sends no
// duration at any point — it renders whatever `ticks` this server reports — so
// this value is an assumption of this implementation, not a recovered fact.
const DEFAULT_TICKS = 5;

const pip = 2;
function lastDigit(price) {
  return Number(price.toFixed(pip).replace(".", "").slice(-1));
}

function digitStats(index) {
  const window = index.digits.slice(-100);
  const out = {};
  for (let d = 0; d < 10; d++) {
    const count = window.filter((x) => x === d).length;
    out[d] = { percentage: (window.length ? (count / window.length) * 100 : 10).toFixed(1) };
  }
  return out;
}

/* ---------------------- open position settlement ---------------------- */
/**
 * Settles every position that reached its final tick.
 *
 * The tick is advanced in one statement for every open position, then each due
 * position is claimed and paid in its own transaction. The claim is
 * `WHERE settled_at IS NULL` inside the settling UPDATE, so a restart or an
 * overlapping tick cannot pay a trade twice — the guard is in the row, not in a
 * variable that a crash could lose.
 */
async function settlePositions() {
  const now = Date.now();
  const changed = [];

  const open = await store.openPositions();
  if (!open.length) return changed;

  const bumped = await store.bumpTicks(open.map((p) => p.id));
  const current = new Map(bumped.map((p) => [p.id, p]));

  for (const position of open) {
    const due = current.get(position.id);
    if (!due || due.status !== "open") continue;
    if (due.current_tick < due.ticks) continue;

    const index = PRICES.find((p) => p.asset === due.asset);
    const exitDigit = index ? lastDigit(index.price) : 0;
    const exitPrice = index ? Number(index.price.toFixed(pip)) : due.entry_price;
    let won = false;

    switch (due.trade_type) {
      case "even_odd":
        won = due.direction === (exitDigit % 2 === 0 ? "even" : "odd");
        break;
      case "over_under":
        won = due.direction === "over" ? exitDigit > due.target_digit : exitDigit < due.target_digit;
        break;
      case "match_differ":
        won = due.direction === "match" ? exitDigit === due.target_digit : exitDigit !== due.target_digit;
        break;
      default: // rise_fall
        won = due.direction === "rise" ? exitPrice > due.entry_price : exitPrice < due.entry_price;
    }

    const closedAt = new Date(now).toISOString();
    const profitLoss = won ? round2(due.potential_payout - due.stake) : -due.stake;

    const settled = await store.tx((t) =>
      t.settlePosition({
        positionId: due.id,
        userId: due.user_id,
        balanceKey: due.is_demo ? "demo_balance" : "real_balance",
        // A loss pays nothing: the stake was already debited when the trade
        // opened, so the payout is the only credit that ever happens here.
        credit: won ? due.potential_payout : 0,
        position: {
          status: won ? "won" : "lost",
          exit_price: exitPrice,
          exit_digit: exitDigit,
          profit_loss: profitLoss,
          closed_at: closedAt,
          settled_at: now,
        },
        transaction: {
          id: id("tx"),
          user_id: due.user_id,
          type: won ? "trade_win" : "trade_loss",
          amount: profitLoss,
          is_demo: due.is_demo,
          status: "completed",
          created_at: closedAt,
        },
      })
    );

    // Claimed by another tick, or already settled before this process started.
    if (!settled.settled) continue;
    changed.push(settled.position);
  }
  return changed;
}

/* ---------------------- contracts and payouts ---------------------- */
/**
 * The client sends no contract type. It sends `direction` plus, for the
 * digit-based contracts, `selectedDigit` — so the type is derived here.
 */
const CONTRACT_FOR_DIRECTION = {
  even: "even_odd", odd: "even_odd",
  over: "over_under", under: "over_under",
  match: "match_differ", differ: "match_differ",
  rise: "rise_fall", fall: "rise_fall",
};

/**
 * Payout multipliers, read out of the client's own bundle so that the figure the
 * panel advertises is the figure settlement credits:
 *
 *   even_odd      flat 1.9522 (the "Even"/"Odd" buttons hardcode 95.22%)
 *   over_under    10 / (number of winning digits) * 0.95, so "over 5" really
 *                 pays 2.375x and "under 5" 1.9x, exactly as the buttons show
 *   match_differ  9.5x for match (850%), 10/9 * 0.95 for differ
 *   rise_fall     1.95 — not offered by the client's UI, kept for completeness
 */
function payoutMultiple(tradeType, direction, targetDigit) {
  if (tradeType === "over_under") {
    const winningDigits = direction === "over" ? 9 - Number(targetDigit) : Number(targetDigit);
    return winningDigits > 0 ? (10 / winningDigits) * 0.95 : 0;
  }
  if (tradeType === "match_differ") return direction === "match" ? 9.5 : (10 / 9) * 0.95;
  if (tradeType === "rise_fall") return 1.95;
  return 1.9522;
}

/**
 * Validates a client trade config and resolves it to the fields the engine
 * settles on. Throws `.code` on anything the client could not legitimately send.
 */
function readContract(config = {}) {
  const direction = config.direction || "even";
  const tradeType = config.trade_type || config.tradeType || CONTRACT_FOR_DIRECTION[direction] || "even_odd";
  const digitBased = tradeType === "over_under" || tradeType === "match_differ";
  // A missing digit must stay missing: Number(null) is 0, which would quietly
  // turn "match" with no digit into "match on 0".
  const raw = config.selectedDigit ?? config.target_digit ?? config.targetDigit ?? config.digit ?? null;
  const digit = raw === null ? null : Number(raw);

  if (digitBased) {
    if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
      throw Object.assign(new Error(`A ${tradeType.replace("_", "/")} contract needs a digit from 0 to 9`), { code: "INVALID_TARGET_DIGIT" });
    }
    if (payoutMultiple(tradeType, direction, digit) <= 0) {
      // No digit can win this side, so it could only ever be a guaranteed loss.
      // The client blocks it too ("Cannot bet Over 9 - no digits above 9").
      throw Object.assign(new Error(`Cannot bet ${direction} ${digit} — no winning digits`), { code: "IMPOSSIBLE_SIDE" });
    }
  }
  return { direction, tradeType, targetDigit: digitBased ? digit : null };
}

/**
 * Turns a contract into everything derived from it, so the same maths is used
 * whether the trade came from the panel or the bot.
 */
function priceContract(config) {
  const contract = readContract(config);
  const multiple = payoutMultiple(contract.tradeType, contract.direction, contract.targetDigit);
  return { ...contract, multiple };
}

/**
 * Opens one position. Shared by manual trading and the auto-trading bot so both
 * go through the same validation, balance debit, ledger entry and persistence.
 *
 * Throws an Error carrying `.code` on refusal: UNKNOWN_ASSET, INVALID_STAKE,
 * INSUFFICIENT_BALANCE. Callers turn those into trade_error frames.
 */
async function openPosition(user, config = {}) {
  const asset = config.asset || PRICES[0].asset;
  const index = PRICES.find((p) => p.asset === asset);
  if (!index) throw Object.assign(new Error(`Unknown asset: ${asset}`), { code: "UNKNOWN_ASSET" });

  const { direction, tradeType, targetDigit, multiple } = priceContract(config);

  const stake = Number(config.stake) || 10;
  if (!(stake > 0)) throw Object.assign(new Error("Stake must be greater than zero"), { code: "INVALID_STAKE" });

  // The balance check and the debit happen together, inside the statement that
  // writes the position (store.debitAndOpenPosition), so two concurrent trades
  // cannot both pass a check and overdraw the account.
  const key = user.is_demo ? "demo_balance" : "real_balance";

  const position = {
    id: id("pos"),
    user_id: user.id,
    asset,
    trade_type: tradeType,
    direction,
    target_digit: targetDigit,
    stake,
    potential_payout: Number((stake * multiple).toFixed(2)),
    entry_price: Number(index.price.toFixed(pip)),
    entry_digit: lastDigit(index.price),
    ticks: Number(config.ticks) || DEFAULT_TICKS,
    current_tick: 0,
    status: "open",
    is_demo: !!user.is_demo,
    auto: !!config.auto,
    created_at: new Date().toISOString(),
  };

  const opened = await store.debitAndOpenPosition({
    userId: user.id,
    balanceKey: key,
    stake,
    position,
    transaction: {
      id: id("tx"),
      user_id: user.id,
      type: "trade_open",
      amount: -stake,
      is_demo: !!user.is_demo,
      status: "completed",
      created_at: position.created_at,
    },
  });
  // Keep the caller's copy in step, so the balance it broadcasts is the one the
  // database now holds.
  user[key] = opened.balance;
  return position;
}

/* ---------------------- auto-trading bot ---------------------- */
// One session per user, in memory only. Trades land in db.positions like any
// other, so the ledger stays the single source of truth; the session is just
// the running totals the client panel renders.
const botSessions = new Map();
const BOT_DEFAULTS = { mode: "auto", direction: "even", ticks: DEFAULT_TICKS, baseStake: 10, targetProfit: 200, targetLoss: 999, lossMultiple: 2 };

const botsFor = (userId) => [...sockets].filter((c) => c.userId === userId);
const publicSession = (s) => (s ? Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith("_"))) : null);

function pushBot(userId, session) {
  const data = publicSession(session);
  for (const c of botsFor(userId)) wsSend(c.socket, { type: "auto_trading_update", data });
  return data;
}

function startBot(user, config = {}) {
  const num = (v, fallback) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
  // Resolved up front so a contract that could never win is refused at start
  // rather than becoming a bot that opens a guaranteed loss every tick.
  const contract = readContract(config);
  const session = {
    active: true,
    mode: config.mode || BOT_DEFAULTS.mode,
    asset: config.asset || PRICES[0].asset,
    direction: contract.direction,
    tradeType: contract.tradeType,
    selectedDigit: contract.targetDigit,
    ticks: num(config.ticks, BOT_DEFAULTS.ticks),
    baseStake: num(config.stake, BOT_DEFAULTS.baseStake),
    currentStake: num(config.stake, BOT_DEFAULTS.baseStake),
    targetProfit: num(config.targetProfit ?? config.target_profit, BOT_DEFAULTS.targetProfit),
    targetLoss: num(config.targetLoss ?? config.target_loss, BOT_DEFAULTS.targetLoss),
    lossMultiple: num(config.lossMultiple ?? config.loss_multiple, BOT_DEFAULTS.lossMultiple),
    sessionPL: 0,
    tradesCount: 0,
    winsCount: 0,
    lossesCount: 0,
    stopReason: null,
    lastResult: null,
    startedAt: new Date().toISOString(),
    _openPositionId: null,
  };
  botSessions.set(user.id, session);
  return session;
}

async function stopBot(userId, reason) {
  const session = botSessions.get(userId);
  if (!session) return null;
  session.active = false;
  session.stopReason = session.stopReason || reason;
  pushBot(userId, session);
  return session;
}

/**
 * Advances every running bot by one tick: book any position that just settled,
 * resize the stake by the martingale rule, stop on a target, else open the next
 * trade. Called from the same 1s loop that settles positions.
 */
async function advanceBots(settled) {
  for (const [userId, session] of [...botSessions]) {
    const user = await store.findUserById(userId);
    if (!user) { botSessions.delete(userId); continue; }

    // Only the settlement of the position THIS session opened counts towards it.
    // A session started while an earlier session's trade was still in flight
    // used to inherit that trade's result — which could credit a fresh session
    // with a large win and stop it on `target_profit_reached` before it had
    // opened anything. The money is unaffected either way: settlement already
    // paid the balance; this is only which session's totals it belongs to.
    const result = settled.find((p) => p.user_id === userId && p.auto && p.id === session._openPositionId);
    if (result) {
      session._openPositionId = null;
      session.sessionPL = Number((session.sessionPL + result.profit_loss).toFixed(2));
      session.tradesCount += 1;
      session.lastResult = { id: result.id, status: result.status, profitLoss: result.profit_loss };

      if (result.status === "won") {
        session.winsCount += 1;
        session.currentStake = session.baseStake; // martingale resets after a win
      } else {
        session.lossesCount += 1;
        session.currentStake = Number((session.currentStake * session.lossMultiple).toFixed(2));
      }

      if (session.sessionPL >= session.targetProfit) {
        session.active = false;
        session.stopReason = "target_profit_reached";
      } else if (session.sessionPL <= -session.targetLoss) {
        session.active = false;
        session.stopReason = "target_loss_reached";
      }
      pushBot(userId, session);
      console.log(`[bot] ${user.email} ${result.status} ${result.profit_loss >= 0 ? "+" : ""}${result.profit_loss} -> session $${session.sessionPL} (${session.tradesCount} trades)`);
    }

    if (!session.active || session._openPositionId) continue;

    try {
      const position = await openPosition(user, {
        asset: session.asset,
        trade_type: session.tradeType,
        direction: session.direction,
        selectedDigit: session.selectedDigit,
        stake: session.currentStake,
        ticks: session.ticks,
        auto: true,
      });
      session._openPositionId = position.id;
      for (const c of botsFor(userId)) {
        wsSend(c.socket, { type: "position_update", action: "add", data: position });
        wsSend(c.socket, { type: "balance_update", data: publicUser(user) });
      }
    } catch (err) {
      // Can't fund the next step (usually martingale outrunning the balance).
      // Stop with a reason the panel can show instead of retrying forever.
      session.active = false;
      session.stopReason = err.code === "INSUFFICIENT_BALANCE" ? "insufficient_balance" : "error";
      pushBot(userId, session);
      // The reason alone is not diagnosable; the message says which contract or
      // which store call refused the trade.
      console.log(`[bot] ${user.email} stopped: ${session.stopReason} — ${(err && err.message) || err}`);
    }
  }
}

setInterval(async () => {
  for (const p of PRICES) {
    p.price = Math.max(0.01, p.price + (Math.random() - 0.5) * p.vol + (p.base - p.price) * 0.01);
    p.tick += 1;
    p.digits.push(lastDigit(p.price));
    if (p.digits.length > 200) p.digits.shift();
  }
  // Settlement writes through to the database as it goes; there is no separate
  // save step to forget.
  const settled = await settlePositions();
  await advanceBots(settled);

  for (const client of sockets) {
    for (const p of PRICES) {
      if (client.asset && client.asset !== p.asset) continue;
      wsSend(client.socket, {
        type: "price",
        data: {
          asset: p.asset,
          price: Number(p.price.toFixed(pip)),
          lastDigit: lastDigit(p.price),
          sequence: p.tick,
          timestamp: Date.now(),
          digitStats: digitStats(p),
        },
      });
    }

    const user = client.userId ? await store.findUserById(client.userId) : null;
    if (!user) continue;

    wsSend(client.socket, { type: "balance_update", data: publicUser(user) });

    if (settled.some((p) => p.user_id === user.id)) {
      for (const position of settled.filter((p) => p.user_id === user.id)) {
        wsSend(client.socket, { type: "position_update", action: "close", data: position });
      }
      wsSend(client.socket, { type: "transaction_update", data: await store.latestTransactionByUser(user.id) });
    }
  }
}, 1000);

/* ----------------------------- server ----------------------------- */
store = await createStore();
// Credentials come from .env.local when the environment does not already carry
// them, so a provider can be configured without editing any tracked file.
const envLoaded = await loadEnvFile();
if (envLoaded) console.log(`  env         : ${envLoaded} variable(s) from .env.local`);

/** Resolves the caller from the Bearer token, or throws a typed 401. */
async function requireUser(ctx) {
  const user = await authorised(ctx.req);
  if (!user) throw new ApiError(401, "UNAUTHENTICATED", "Not authorised");
  return user;
}

/*
 * This mirror ships with an operator wallet configured, so the USDT (TRC20)
 * panel shows a real address instead of a spinner. `undefined` means "nobody
 * decided", so the default applies; an explicit value — including an empty
 * string — is respected, which is how the static wallet is turned off.
 * See PAYMENTS.md.
 *
 * Remembered, because the boot log must not call this "configured": a
 * deployment that never named a wallet is showing depositors the built-in one,
 * which is not the deployer's, and nothing else on screen would say so.
 */
const usingBuiltInTronWallet = process.env.TRON_DEPOSIT_ADDRESS === undefined;
if (usingBuiltInTronWallet) {
  process.env.TRON_DEPOSIT_ADDRESS = DEFAULT_TRON_DEPOSIT_ADDRESS;
}

const payments = createPaymentRoutes({ store, requireUser });

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname.startsWith("/api/")) {
      const origin = req.headers.origin;
      // A recognised origin gets the CORS grant; one that is not recognised is
      // refused outright rather than served without headers, so a misconfigured
      // deployment fails loudly instead of mysteriously in the browser.
      if (!originAllowed(origin, req)) {
        return sendJson(res, 403, { error: "Origin not allowed", code: "ORIGIN_NOT_ALLOWED" });
      }
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin.replace(/\/+$/, ""));
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "600");
      // No Allow-Credentials: the client authenticates with a Bearer token, and
      // not permitting cookies means a browser will not attach them for us
      // either if this is ever called from a hostile page.
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      return await api(req, res, pathname);
    }
    // What a host's health check polls. It reports the storage in use rather
    // than a bare 200, so a deploy that lost its database is visible from
    // outside instead of looking healthy until someone tries to trade.
    if (pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, storage: store.kind, uptime: Math.round(process.uptime()) });
    }
    return await staticFile(req, res, pathname);
  } catch (err) {
    if (err instanceof ApiError) {
      // Expected, typed failure: safe message + machine-readable code.
      return sendJson(res, err.status, { error: err.message, code: err.code, ...err.extra });
    }
    console.error("request failed:", err);
    if (!res.headersSent) sendJson(res, 500, { error: "Internal error", code: "INTERNAL_ERROR" });
  }
});

server.on("upgrade", (req, socket) => {
  // A WebSocket handshake is exempt from CORS, so the origin is checked here —
  // otherwise any page on the internet could open a socket to this API.
  if (!originAllowed(req.headers.origin, req)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return socket.destroy();
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`
  );

  const client = { socket, userId: null, asset: null };
  sockets.add(client);

  // The client sends `subscribe` immediately on open, which triggers its first quote.

  socket.on("data", async (buf) => {
    for (const message of wsParse(buf)) {
      if (message.close) return socket.destroy();
      if (!message.text) continue;
      try {
        const msg = JSON.parse(message.text);

        if (msg.type === "auth") {
          const authedUserId = msg.token ? await store.userIdForToken(msg.token) : null;
          const user = authedUserId ? await store.findUserById(authedUserId) : null;
          client.userId = user ? user.id : null;
          // The client expects this acknowledgement; without it it only ever
          // learns about a failed login.
          // autoTrading carries any bot still running for this user, so a
          // reconnect restores the panel instead of silently losing the session.
          if (user) wsSend(socket, { type: "auth_success", data: { ...publicUser(user), autoTrading: publicSession(botSessions.get(user.id)) ?? null } });
          else wsSend(socket, { type: "auth_error", data: { message: "Not authorised" } });
        }

        if (msg.type === "subscribe" && msg.asset) {
          client.asset = msg.asset;
          // Send a first quote straight away so the UI leaves its loading state.
          const index = PRICES.find((p) => p.asset === msg.asset);
          if (index) {
            wsSend(socket, {
              type: "price",
              data: {
                asset: index.asset,
                price: Number(index.price.toFixed(pip)),
                lastDigit: lastDigit(index.price),
                sequence: index.tick,
                timestamp: Date.now(),
                history: [],
                digitStats: digitStats(index),
              },
            });
          }
        }

        if (msg.type === "manual_trade") {
          const user = client.userId ? await store.findUserById(client.userId) : null;
          const config = msg.config || {};
          if (!user) {
            wsSend(socket, { type: "trade_error", data: { message: "Not authorised" } });
          } else {
            try {
              const position = await openPosition(user, { ...config, asset: config.asset || client.asset });
              wsSend(socket, { type: "position_update", action: "add", data: position });
              wsSend(socket, { type: "balance_update", data: publicUser(user) });
              const target = position.target_digit === null ? "" : " " + position.target_digit;
              console.log(`[trade] ${user.email} ${position.trade_type}/${position.direction}${target} $${position.stake} -> $${position.potential_payout} on ${position.asset}`);
            } catch (err) {
              wsSend(socket, { type: "trade_error", data: { code: err.code || "TRADE_REJECTED", message: err.message } });
              console.log(`[trade] ${user.email} rejected: ${err.code || err.message}`);
            }
          }
        }

        if (msg.type === "auto_trading_start") {
          const user = client.userId ? await store.findUserById(client.userId) : null;
          if (!user) {
            wsSend(socket, { type: "trade_error", data: { message: "Not authorised" } });
          } else {
            try {
              const session = startBot(user, msg.config || {});
              wsSend(socket, { type: "auto_trading_response", session: publicSession(session) });
              pushBot(user.id, session);
              console.log(`[bot] ${user.email} started: ${session.tradeType}/${session.direction}${session.selectedDigit === null ? "" : " " + session.selectedDigit} $${session.baseStake} x${session.lossMultiple} martingale, target +$${session.targetProfit} / -$${session.targetLoss}`);
            } catch (err) {
              wsSend(socket, { type: "trade_error", data: { code: err.code || "INVALID_CONFIG", message: err.message } });
              console.log(`[bot] ${user.email} refused: ${err.code || err.message}`);
            }
          }
        }

        if (msg.type === "auto_trading_stop") {
          const user = client.userId ? await store.findUserById(client.userId) : null;
          if (!user) {
            wsSend(socket, { type: "trade_error", data: { message: "Not authorised" } });
          } else {
            const session = await stopBot(user.id, "stopped_by_user");
            wsSend(socket, { type: "auto_trading_response", session: publicSession(session) });
            if (session) console.log(`[bot] ${user.email} stopped by user at $${session.sessionPL} after ${session.tradesCount} trades`);
          }
        }

        if (msg.type === "auto_trading_status") {
          // `session` belongs at the root here, and the reply type is
          // auto_trading_response — the client has no handler for the request
          // type coming back.
          const user = client.userId ? await store.findUserById(client.userId) : null;
          wsSend(socket, { type: "auto_trading_response", session: publicSession(user && botSessions.get(user.id)) ?? null });
        }
      } catch {
        /* ignore malformed frames */
      }
    }
  });

  const drop = () => sockets.delete(client);
  socket.on("close", drop);
  socket.on("end", drop);
  socket.on("error", drop);
});

server.listen(PORT, HOST, () => {
  // Report the bound port, not the requested one: PORT=0 asks the OS to choose,
  // which is what lets tests (and parallel runs) avoid fixed-port collisions.
  const { port } = server.address();
  console.log(`PalOption mirror + local API on http://127.0.0.1:${port}`);
  console.log(`  static root : ${ROOT}/`);
  console.log(`  api         : /api/auth/{register,login,login/verify-2fa,demo,me,switch-account,reset-demo}`);
  console.log(`  cashier     : /api/auth/{exchange-rate,mpesa/stk-push,card/deposit,trc20/my-address,deposits}`);
  console.log(`  mpesa callbk: POST /api/auth/mpesa/callback/:token`);
  console.log(`  websocket   : /ws`);
  console.log(`  api base    : ${apiBaseFromEnv() || "same-origin"} (baked into the client; override with globalThis.__PALOPTION_API_URL__)`);
  console.log(`  cors        : ${allowedOrigins().length ? allowedOrigins().join(", ") : "same-origin + loopback only"}`);
  // The client never sends a duration: it renders whatever `ticks` we report.
  // 5 is this server's choice, not something recovered from the original.
  console.log(`  trading     : settled server-side, 1 tick/sec, default ${DEFAULT_TICKS} ticks (client sends no duration)`);
  console.log(`  storage     : ${store.kind === "postgres" ? "postgres" : "in-memory — NOT for production"}`);

  // Payment providers are gated on credentials. Say plainly what is live.
  const p = paymentConfig();
  console.log(`  providers   : daraja=${p.daraja.configured ? "configured" : "NOT CONFIGURED"}` +
    ` card=${p.card.configured ? "configured" : "NOT CONFIGURED"}` +
    ` tron=${p.tron.configured ? "configured" : "NOT CONFIGURED"}`);
  if (usingBuiltInTronWallet) {
    console.log(`  WARNING     : TRON_DEPOSIT_ADDRESS is not set, so USDT deposits are shown the built-in wallet ${DEFAULT_TRON_DEPOSIT_ADDRESS} — it is not yours. Set TRON_DEPOSIT_ADDRESS, or set it to an empty string to disable the static wallet.`);
  }
  if (p.daraja.blocked) {
    console.log(`  note        : DARAJA_ENV=production is set but DARAJA_ALLOW_PRODUCTION=1 is not — this instance will not charge a real shortcode.`);
  }
  if (p.daraja.environment === "production" && p.daraja.configured) {
    console.log(`  WARNING     : Daraja is LIVE. This instance collects real payments into the configured shortcode's wallet.`);
  }
  if (!p.daraja.configured || !p.card.configured || !p.tron.configured) {
    console.log(`  note        : unconfigured providers return 503 PAYMENT_PROVIDER_NOT_CONFIGURED; no wallet is ever credited without a verified settlement.`);
  }
});
