#!/usr/bin/env node
/**
 * The §5 checklist in DEPLOY.md, as one command.
 *
 *   node tools/verify-deploy.mjs --url https://paloption-api.onrender.com
 *   node tools/verify-deploy.mjs --url https://<host> --register
 *
 * A deployment is easy to declare healthy on the strength of one 200, so this
 * checks the things that actually distinguish a working pair from a broken one:
 *
 *   - the ledger is Postgres, not the in-memory store a lost DATABASE_URL leaves
 *     behind (this is the failure that silently discards every trade on restart);
 *   - the client is really served here, which is what makes the one-origin
 *     deployment one origin;
 *   - a same-origin request is accepted AND a foreign origin is refused — both
 *     halves matter, and the second is what stops any page opening a socket to
 *     this server;
 *   - an unknown /api path answers JSON rather than the HTML 404 that used to
 *     break the client's JSON.parse, and a refused login is JSON too;
 *   - the socket accepts this origin's handshake and refuses another's.
 *
 * Read-only by default. `--register` creates one throwaway account (and signs it
 * in) because that is the only way to prove registration end to end; it writes
 * one user row to the deployment's ledger.
 *
 * Cashier checks are NOT here: they move money or need provider credentials.
 * Use `npm run verify:cashier -- --sandbox --api <host>` for those, which is
 * documented in DEPLOY.md §5.
 *
 * Exit code 0 only when every check passes. Skips never fail the run.
 *
 * Requests are made with node:http(s) rather than fetch on purpose: a browser
 * forbids setting `Origin`, and Origin gating is half of what is under test.
 */
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";

/* ------------------------------- arguments ------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);

if (flag("help") || !argv.length) {
  console.log("usage: node tools/verify-deploy.mjs --url https://<host> [--register] [--json]");
  process.exit(argv.length ? 0 : 1);
}

const urlIndex = argv.indexOf("--url");
const target = urlIndex === -1 ? null : argv[urlIndex + 1];
if (!target || !/^https?:\/\//.test(target)) {
  console.error("--url must be an http(s) origin, e.g. --url https://paloption-api.onrender.com");
  process.exit(1);
}

/** No trailing slash, so origin comparisons are string-comparable. */
const BASE = target.replace(/\/+$/, "");
const FOREIGN = "https://evil.example";
const TIMEOUT_MS = 20_000;

/* -------------------------------- transport ------------------------------ */

/**
 * One request, with an arbitrary header set. Resolves for any HTTP status — a
 * 403 is a result, not an error — and only rejects when the host cannot be
 * reached at all, which is itself worth reporting.
 */
function request(path, { method = "GET", headers = {}, body = null, upgrade = false } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(BASE + path);
    const client = parsed.protocol === "https:" ? https : http;
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));

    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          ...headers,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );

    // A 101 is a result too: it means this origin's socket handshake was accepted.
    if (upgrade) req.on("upgrade", (res) => resolve({ status: res.statusCode ?? 101, headers: res.headers, text: "" }));
    req.on("timeout", () => req.destroy(new Error(`no response within ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** A WebSocket handshake's shape, so the server's upgrade path is exercised. */
const handshake = (origin) => ({
  Connection: "Upgrade",
  Upgrade: "websocket",
  "Sec-WebSocket-Key": Buffer.from(randomBytes(16)).toString("base64"),
  "Sec-WebSocket-Version": "13",
  Origin: origin,
});

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const looksHtml = (res) => /\btext\/html\b/i.test(String(res.headers["content-type"] || ""));

/** Details sit on one line: a raw body here is a wall of HTML, not a report. */
const brief = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, 110);

/* ------------------------------- websocket ------------------------------- */

/**
 * A client frame. Clients MUST mask, so the checker masks: sending an unmasked
 * frame would test a protocol no browser speaks.
 */
function wsClientFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj));
  const mask = randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];

  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, 0x80 | data.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

/**
 * One frame off the front of a buffer, or null while it is still incomplete —
 * a frame can arrive split across TCP segments, so the reader must not assume
 * a whole message is there yet.
 */
function takeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let at = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(at);
    at += 2;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(at));
    at += 8;
  }
  const mask = masked ? buffer.subarray(at, at + 4) : null;
  if (masked) at += 4;
  if (buffer.length < at + length) return null;

  const payload = Buffer.from(buffer.subarray(at, at + length));
  if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return { size: at + length, opcode, payload, text: payload.toString("utf8") };
}

/** A connected socket, remembering every JSON message it has been sent. */
class SocketSession {
  constructor(socket) {
    this.socket = socket;
    this.pending = Buffer.alloc(0);
    this.messages = [];
    this.closeCode = null;
    socket.on("data", (chunk) => {
      this.pending = Buffer.concat([this.pending, chunk]);
      for (;;) {
        const frame = takeFrame(this.pending);
        if (!frame) break;
        this.pending = this.pending.subarray(frame.size);
        // A close frame carries a two-byte status code in its payload.
        if (frame.opcode === 0x8) this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        if (frame.opcode !== 0x1) continue;
        try {
          this.messages.push(JSON.parse(frame.text));
        } catch {
          /* not a message this client sent, or not JSON */
        }
      }
    });
    socket.on("error", () => {});
  }

  send(obj) {
    this.socket.write(wsClientFrame(obj));
  }

  /** Waits for a message matching a predicate, so nothing races the server. */
  waitFor(predicate, ms = 8_000) {
    return new Promise((resolve) => {
      const found = () => this.messages.find(predicate);
      const already = found();
      if (already) return resolve(already);
      const timer = setTimeout(() => {
        this.socket.off("data", check);
        resolve(null);
      }, ms);
      const check = () => {
        const hit = found();
        if (!hit) return;
        clearTimeout(timer);
        this.socket.off("data", check);
        resolve(hit);
      };
      this.socket.on("data", check);
    });
  }

  ofType(type) {
    return this.messages.filter((m) => m.type === type);
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

/** Opens a socket to /ws as this origin, resolving once it is upgraded. */
function openSocket(origin) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(BASE);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: "/ws",
      headers: handshake(origin),
      timeout: TIMEOUT_MS,
    });
    req.on("upgrade", (_res, socket, head) => {
      const session = new SocketSession(socket);
      if (head?.length) socket.emit("data", head);
      resolve(session);
    });
    req.on("response", (res) => reject(new Error(`the handshake was refused with ${res.statusCode}`)));
    req.on("timeout", () => req.destroy(new Error("the handshake timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** The asset the engine actually serves; PRICES[0] in tools/server.mjs. */
const ASSET = "volatility_10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- checks -------------------------------- */

const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : "SKIP";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Runs a check, turning an unreachable host into a FAIL with the real reason. */
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    record(name, "fail", error?.message || String(error));
  }
}

/** Whether /healthz identified this service, which some checks need to mean anything. */
let serviceAlive = false;

await check("the service answers at all", async () => {
  let res;
  try {
    res = await request("/healthz");
  } catch (error) {
    throw new Error(`${BASE} did not answer (${error.message}) — is the deployment up, and is this the right host?`);
  }
  // A host that answers is not the same as this service running on it: Render
  // serves a 404 for any hostname nobody has claimed, and a stray static host
  // answers with its own HTML. Only /healthz identifies the service.
  const body = json(res.text);
  if (res.status !== 200 || !body?.ok) {
    return record(
      "the service answers at all",
      "fail",
      `${BASE}/healthz returned ${res.status} ${brief(res.text)} — this is not the PalOption service, or it has not deployed`
    );
  }
  serviceAlive = true;
  record("the service answers at all", "pass", BASE);
});

// Every remaining check runs even when one above failed: "the client is served
// but the API is absent" is a far more useful report than a single line.
{
  // The account created by --register, which the socket checks trade with.
  let session = null;

  await check("health reports a Postgres ledger", async () => {
    const res = await request("/healthz");
    const body = json(res.text);
    if (res.status !== 200 || !body?.ok) {
      return record("health reports a Postgres ledger", "fail", `/healthz returned ${res.status} ${brief(res.text)}`);
    }
    if (body.storage !== "postgres") {
      return record(
        "health reports a Postgres ledger",
        "fail",
        `storage=${body.storage} — DATABASE_URL did not reach the process, so every trade is lost on restart`
      );
    }
    record("health reports a Postgres ledger", "pass", `storage=postgres, uptime=${body.uptime}s`);
  });

  await check("the client is served from this origin", async () => {
    for (const page of ["/", "/register", "/login"]) {
      const res = await request(page);
      if (res.status !== 200 || !looksHtml(res)) {
        return record("the client is served from this origin", "fail", `${page} returned ${res.status}, content-type ${res.headers["content-type"] || "none"}`);
      }
    }
    record("the client is served from this origin", "pass", "/, /register and /login are all HTML 200");
  });

  await check("a same-origin request is accepted", async () => {
    const res = await request("/api/auth/exchange-rate", { headers: { Origin: BASE } });
    if (res.status !== 200) {
      return record("a same-origin request is accepted", "fail", `Origin: ${BASE} was answered ${res.status} — this is what breaks every login`);
    }
    const granted = res.headers["access-control-allow-origin"];
    record("a same-origin request is accepted", granted ? "pass" : "pass", granted ? `CORS grant echoed for ${granted}` : "200 with no Origin echo (fine: same-origin needs no grant)");
  });

  await check("a foreign origin is refused", async () => {
    const res = await request("/api/auth/exchange-rate", { headers: { Origin: FOREIGN } });
    const body = json(res.text);
    if (res.status !== 403 || body?.code !== "ORIGIN_NOT_ALLOWED") {
      return record("a foreign origin is refused", "fail", `${FOREIGN} was answered ${res.status} ${brief(res.text)} — any page could reach this API`);
    }
    record("a foreign origin is refused", "pass", `403 ORIGIN_NOT_ALLOWED for ${FOREIGN}`);
  });

  await check("the socket accepts this origin and refuses another", async () => {
    const accepted = await request("/ws", { headers: handshake(BASE), upgrade: true });
    if (accepted.status !== 101) {
      return record("the socket accepts this origin and refuses another", "fail", `the handshake from ${BASE} returned ${accepted.status}, not 101`);
    }
    const refused = await request("/ws", { headers: handshake(FOREIGN), upgrade: true });
    if (refused.status !== 403) {
      return record("the socket accepts this origin and refuses another", "fail", `the handshake from ${FOREIGN} returned ${refused.status}, not 403`);
    }
    record("the socket accepts this origin and refuses another", "pass", "101 from this origin, 403 from a foreign one");
  });

  await check("an unknown API path answers JSON, not an HTML page", async () => {
    const res = await request("/api/definitely-not-a-route");
    if (res.status !== 404) {
      return record("an unknown API path answers JSON, not an HTML page", "fail", `returned ${res.status}`);
    }
    if (!json(res.text) || looksHtml(res)) {
      return record("an unknown API path answers JSON, not an HTML page", "fail", `404 body was not JSON (content-type ${res.headers["content-type"]}) — this is the shape that produced "Unexpected token 'T'"`);
    }
    record("an unknown API path answers JSON, not an HTML page", "pass", "404 application/json");
  });

  await check("a refused login is a JSON error, not a parser crash", async () => {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { Origin: BASE },
      body: { email: `nobody-${randomBytes(4).toString("hex")}@example.invalid`, password: "definitely-not-the-password" },
    });
    const body = json(res.text);
    if (res.status !== 401 || !body?.error) {
      return record("a refused login is a JSON error, not a parser crash", "fail", `returned ${res.status}: ${brief(res.text)}`);
    }
    if (/Unexpected token/.test(body.error)) {
      return record("a refused login is a JSON error, not a parser crash", "fail", `the message is the browser's parser complaint: ${body.error}`);
    }
    record("a refused login is a JSON error, not a parser crash", "pass", `401 "${body.error}"`);
  });

  if (flag("register")) {
    await check("registration, login and the session they return work end to end", async () => {
      const email = `verify.deploy.${randomBytes(4).toString("hex")}@example.invalid`;
      const password = `Verify-${randomBytes(6).toString("hex")}`;
      const created = await request("/api/auth/register", {
        method: "POST",
        headers: { Origin: BASE },
        body: { name: "Deploy Verification", email, password },
      });
      const account = json(created.text);
      if (created.status !== 200 || !account?.token || account.user?.email !== email) {
        return record("registration, login and the session they return work end to end", "fail", `register returned ${created.status}: ${brief(created.text)}`);
      }

      // Registration alone does not prove the login path: sign the same account
      // back in and use the token that comes from *that*, not from creation.
      const login = await request("/api/auth/login", { method: "POST", headers: { Origin: BASE }, body: { email, password } });
      const signedIn = json(login.text);
      if (login.status !== 200 || !signedIn?.token) {
        return record("registration, login and the session they return work end to end", "fail", `login returned ${login.status}: ${brief(login.text)}`);
      }

      // The route answers `{user}`, not the user itself (DEPLOY.md §8).
      const me = await request("/api/auth/me", { headers: { Origin: BASE, Authorization: `Bearer ${signedIn.token}` } });
      const who = json(me.text)?.user;
      if (me.status !== 200 || who?.email !== email) {
        return record(
          "registration, login and the session they return work end to end",
          "fail",
          `/api/auth/me returned ${me.status} and identified ${who?.email ?? "nobody"} for the token just issued`
        );
      }

      session = { email, token: signedIn.token, balance: Number(who.demo_balance ?? who.balance) };
      record("registration, login and the session they return work end to end", "pass", `registered, signed in and re-read ${email}`);
    });
  } else {
    record("registration, login and the session they return work end to end", "skip", "pass --register to create one throwaway account");
  }

  await check("protected routes reject an unauthenticated caller", async () => {
    const anonymous = await request("/api/trade/positions", { headers: { Origin: BASE } });
    if (anonymous.status !== 401) {
      return record("protected routes reject an unauthenticated caller", "fail", `/api/trade/positions without a token returned ${anonymous.status} — positions would be readable by anyone`);
    }
    const forged = await request("/api/trade/positions", { headers: { Origin: BASE, Authorization: "Bearer not-a-real-token" } });
    if (forged.status !== 401 || json(forged.text)?.code !== "UNAUTHENTICATED") {
      return record("protected routes reject an unauthenticated caller", "fail", `a forged token returned ${forged.status}: ${brief(forged.text)}`);
    }
    record("protected routes reject an unauthenticated caller", "pass", "401 for both no token and a forged one");
  });

  await check("the cashier refuses unauthenticated and malformed requests", async () => {
    const anonymous = await request("/api/auth/mpesa/stk-push", {
      method: "POST",
      headers: { Origin: BASE },
      body: { amount: 1, phone: "0712345678" },
    });
    if (anonymous.status !== 401) {
      return record("the cashier refuses unauthenticated and malformed requests", "fail", `an anonymous STK push returned ${anonymous.status} — anyone could prompt a payment`);
    }

    // An amount of zero is refused by validation, which runs before the provider
    // is consulted — so this cannot raise a real prompt on anyone's handset.
    // A 200 here would mean a push was actually sent.
    if (!session) {
      return record(
        "the cashier refuses unauthenticated and malformed requests",
        "pass",
        "an anonymous STK push is 401; the amount check needs --register to reach"
      );
    }
    const malformed = await request("/api/auth/mpesa/stk-push", {
      method: "POST",
      headers: { Origin: BASE, Authorization: `Bearer ${session.token}` },
      body: { amount: 0, phone: "0712345678" },
    });
    if (malformed.status === 200) {
      return record("the cashier refuses unauthenticated and malformed requests", "fail", "a $0 deposit was accepted");
    }
    if (malformed.status !== 400 && malformed.status !== 503) {
      return record("the cashier refuses unauthenticated and malformed requests", "fail", `a $0 deposit returned ${malformed.status}: ${brief(malformed.text)}`);
    }
    record(
      "the cashier refuses unauthenticated and malformed requests",
      "pass",
      `anonymous 401; a $0 deposit ${malformed.status} ${brief(malformed.text)} (no prompt raised)`
    );
  });

  await check("the socket speaks the protocol the client expects", async () => {
    const socket = await openSocket(BASE);
    try {
      socket.send({ type: "subscribe", asset: ASSET });
      const price = await socket.waitFor((m) => m.type === "price");
      if (!price) {
        return record("the socket speaks the protocol the client expects", "fail", `no price frame followed a subscribe for ${ASSET}`);
      }
      const data = price.data || {};
      if (typeof data.price !== "number" || data.asset !== ASSET || typeof data.sequence !== "number") {
        return record("the socket speaks the protocol the client expects", "fail", `unexpected price frame: ${brief(JSON.stringify(price))}`);
      }
      record("the socket speaks the protocol the client expects", "pass", `subscribe -> price ${data.price} on ${data.asset} (sequence ${data.sequence})`);
    } finally {
      socket.close();
    }
  });

  await check("the trading engine ticks without a client asking", async () => {
    const socket = await openSocket(BASE);
    try {
      socket.send({ type: "subscribe", asset: ASSET });
      await sleep(3_200);
      const ticks = socket.ofType("price");
      const sequences = ticks.map((m) => m.data?.sequence).filter((n) => typeof n === "number");
      if (sequences.length < 2 || Math.max(...sequences) === Math.min(...sequences)) {
        return record(
          "the trading engine ticks without a client asking",
          "fail",
          `${sequences.length} price frame(s) in 3.2s (${sequences.join(", ")}) — the 1s tick engine is not running`
        );
      }
      record(
        "the trading engine ticks without a client asking",
        "pass",
        `${sequences.length} frames in 3.2s, sequence ${Math.min(...sequences)} -> ${Math.max(...sequences)}`
      );
    } finally {
      socket.close();
    }
  });

  await check("a session token authenticates the socket", async () => {
    if (!session) {
      return record("a session token authenticates the socket", "skip", "pass --register to obtain a session token");
    }
    const socket = await openSocket(BASE);
    try {
      socket.send({ type: "auth", token: session.token });
      const ok = await socket.waitFor((m) => m.type === "auth_success" || m.type === "auth_error");
      if (ok?.type !== "auth_success") {
        return record("a session token authenticates the socket", "fail", `the socket answered ${ok?.type ?? "nothing"} to a valid token`);
      }
      record("a session token authenticates the socket", "pass", `auth_success for ${ok.data?.email ?? session.email}`);
    } finally {
      socket.close();
    }
  });

  await check("an anonymous socket cannot trade", async () => {
    const socket = await openSocket(BASE);
    try {
      socket.send({ type: "manual_trade", config: { asset: ASSET, stake: 10 } });
      const refused = await socket.waitFor((m) => m.type === "trade_error");
      if (!refused) {
        return record("an anonymous socket cannot trade", "fail", "a trade was accepted from a socket that never authenticated");
      }
      record("an anonymous socket cannot trade", "pass", `refused: ${refused.data?.message || "not authorised"}`);
    } finally {
      socket.close();
    }
  });

  await check("a client cannot set its own stake beyond its balance", async () => {
    if (!session) {
      return record("a client cannot set its own stake beyond its balance", "skip", "pass --register to trade with a real account");
    }
    const socket = await openSocket(BASE);
    try {
      socket.send({ type: "auth", token: session.token });
      const authed = await socket.waitFor((m) => m.type === "auth_success");
      if (!authed) {
        return record("a client cannot set its own stake beyond its balance", "fail", "the socket never authenticated, so nothing could be tested");
      }
      const before = Number(authed.data?.demo_balance ?? authed.data?.balance ?? session.balance);

      // A stake far beyond the balance, and a negative one: both are what a
      // tampered client would send, and neither may move a cent.
      socket.send({ type: "manual_trade", config: { asset: ASSET, stake: 1_000_000_000 } });
      const oversized = await socket.waitFor((m) => m.type === "trade_error");
      socket.send({ type: "manual_trade", config: { asset: ASSET, stake: -50 } });
      const negative = await socket.waitFor((m) => m.type === "trade_error" && m !== oversized);

      if (!oversized || !negative) {
        return record(
          "a client cannot set its own stake beyond its balance",
          "fail",
          `an oversized stake ${oversized ? "was" : "was not"} refused and a negative one ${negative ? "was" : "was not"}`
        );
      }

      // Positive control: a legitimate stake must be accepted, and must debit
      // exactly that stake — a refusal-only test would pass on a dead engine.
      socket.send({ type: "manual_trade", config: { asset: ASSET, stake: 1 } });
      const opened = await socket.waitFor((m) => m.type === "position_update");
      const balanced = await socket.waitFor((m) => m.type === "balance_update");
      if (!opened || !balanced) {
        return record("a client cannot set its own stake beyond its balance", "fail", "a legitimate $1 stake was not accepted, so the refusals above prove nothing");
      }
      const after = Number(balanced.data?.demo_balance ?? balanced.data?.balance);
      if (!(after < before)) {
        return record("a client cannot set its own stake beyond its balance", "fail", `the balance did not fall after a $1 stake: ${before} -> ${after}`);
      }
      record(
        "a client cannot set its own stake beyond its balance",
        "pass",
        `oversized (${oversized.data?.code}) and negative (${negative.data?.code}) refused; a $1 stake debited ${before} -> ${after}`
      );
    } finally {
      socket.close();
    }
  });

  await check("no response echoes a credential", async () => {
    // A host that is not this service cannot pass this. A CDN's 404 page
    // trivially contains no connection string, and reporting PASS would credit a
    // deployment that does not exist with a property it never demonstrated.
    if (!serviceAlive) {
      return record("no response echoes a credential", "skip", "the service was not identified, so there was nothing to scan");
    }
    // A heuristic, and reported as one: it looks for the shapes a leaked
    // connection string or API key takes, not for every possible secret.
    const probes = [
      await request("/healthz"),
      await request("/api/definitely-not-a-route"),
      await request("/api/auth/exchange-rate", { headers: { Origin: FOREIGN } }),
      await request("/api/auth/login", { method: "POST", headers: { Origin: BASE }, body: { email: "nobody@example.invalid", password: "wrong" } }),
    ];
    const shapes = [/postgres(ql)?:\/\/\S+/i, /sk_(live|test)_[A-Za-z0-9]+/, /Bearer\s+[A-Za-z0-9._-]{20,}/];
    for (const res of probes) {
      for (const shape of shapes) {
        const hit = res.text.match(shape);
        if (hit) {
          return record("no response echoes a credential", "fail", `a response matched ${shape}: ${brief(hit[0])}`);
        }
      }
    }
    record("no response echoes a credential", "pass", "health, 404, 403 and a failed login carry no connection string or key");
  });

  record("records survive a restart", "skip", "needs a redeploy of the host, which cannot be triggered from outside; the ledger check above is the proxy for it");

  record("the cashier settles real payments", "skip", "needs provider credentials — see DEPLOY.md §5, npm run verify:cashier");
}

/* --------------------------------- report -------------------------------- */

const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass");
const skipped = results.filter((r) => r.status === "skip");

if (flag("json")) console.log(JSON.stringify({ base: BASE, results }, null, 2));

console.log(
  `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped against ${BASE}`
);
if (failed.length) {
  console.log("A deployment is not verified while any check above says FAIL.");
}
process.exit(failed.length ? 1 : 0);
