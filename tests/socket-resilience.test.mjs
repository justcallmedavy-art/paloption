/**
 * The trading socket's resilience: a heartbeat, a watchdog and a backoff.
 *
 * Two halves, and both are needed for the claim to mean anything:
 *
 *   1. the client patch — that the mirrored bundle really is edited in the two
 *      handlers that own the socket, that the edit is skipped loudly rather than
 *      silently when its anchor moves, and that the reconnect delay it injects
 *      is the arithmetic this suite tests (the patch writes the function into
 *      the browser through its own source text, so the tested function and the
 *      running one cannot drift apart);
 *   2. the server — that a protocol ping goes out, that a silent socket is
 *      reaped, and that a socket which answers survives; plus the application
 *      heartbeat the patched client sends and the pong it waits for.
 *
 * The reaping test drives the interval through WS_PING_MS, so it takes seconds
 * rather than a minute of real waiting. Everything here runs against a spawned
 * server on the in-memory store: no database and no provider is involved.
 *
 * Run: npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  patchSocketResilience,
  patchClientChunk,
  wsRetryDelay,
} from "../tools/client-patches.mjs";

const FRONTEND = "https://paloption.vercel.app";
const CHUNK = "site/_next/static/chunks/219b97e8e5e970d5.js";

/* ------------------------------------------------------------------ *
 * 1. The client patch, against the real bundle
 * ------------------------------------------------------------------ */

describe("trading socket patch", () => {
  let pristine;

  before(async () => {
    pristine = await readFile(CHUNK, "utf8");
  });

  test("the mirrored chunk still carries the socket this patch edits", () => {
    assert.match(pristine, /new WebSocket\(\(0,\w+\.getWsUrl\)\(\)\)/, "the chunk opens a socket");
  });

  test("all three anchors apply, and none is skipped", () => {
    const result = patchSocketResilience(pristine, "219b97e8e5e970d5.js");
    assert.deepEqual(result.skipped, [], "no anchor went missing");
    assert.equal(result.count, 3, "open, message and close were each edited");
    assert.equal(result.applied.length, 3);
  });

  test("the patched socket heartbeats, watches for silence and stops using the fixed retry", () => {
    const { source } = patchSocketResilience(pristine, "219b97e8e5e970d5.js");

    // The heartbeat itself, and the watchdog that closes a socket that hears
    // nothing for 45s — both longer than the 20s interval, so two answers may
    // be missed before a live connection is dropped.
    assert.match(source, /setInterval\(\(\)=>\{try\{if\(Date\.now\(\)-\(globalThis\.__palOptionWsSeen\|\|0\)>45e3\)/, "watchdog");
    assert.match(source, /s\.send\(JSON\.stringify\(\{type:"ping"\}\)\)/, "heartbeat send");
    assert.match(source, /\},2e4\)/, "every 20s");

    // Liveness is recorded from received frames only, and clears the backoff.
    assert.match(source, /s\.onmessage=e=>\{globalThis\.__palOptionWsSeen=Date\.now\(\),globalThis\.__palOptionWsAttempt=0;/, "activity is recorded on receipt");

    // The heartbeat is stopped when the socket closes, before the retry.
    assert.match(source, /s\.__palOptionBeat&&clearInterval\(s\.__palOptionBeat\)/, "the interval does not outlive the socket");

    // The upstream fixed delay is gone, replaced by the tested arithmetic.
    assert.equal(source.includes("setTimeout(()=>{b()},3e3)"), false, "the fixed 3s retry is gone");
    assert.ok(source.includes(wsRetryDelay.toString()), "the injected delay is this suite's function, verbatim");
  });

  test("a moved anchor is reported, not silently skipped", () => {
    // The realistic upstream change: the retry is rewritten. The other two
    // anchors must still apply, and the missing one must say so.
    const moved = pristine.replace('setTimeout(()=>{b()},3e3)', 'setTimeout(()=>{b()},5000)');
    const result = patchSocketResilience(moved, "219b97e8e5e970d5.js");
    assert.equal(result.count, 2, "the two intact anchors still apply");
    assert.equal(result.skipped.length, 1, "and the third is reported");
    assert.match(result.skipped[0], /backoff/, "with the edit it belonged to named");
  });

  test("a bundle with none of the anchors says so for the chunk that carries it", () => {
    // Guard against the worst case: a re-mirror that rewrites the handlers
    // would otherwise leave the app with no heartbeat and nothing in the log to
    // say why. The chunk that carries the socket must never pass over this
    // silently; a chunk that does not carry it must stay quiet.
    const result = patchSocketResilience("var x = 1;", "219b97e8e5e970d5.js");
    assert.equal(result.count, 0);
    assert.equal(result.skipped.length, 4, "three anchors plus the chunk-level note");
    assert.ok(
      result.skipped.some((note) => note.includes("none of its anchors were found")),
      `the chunk-level note is there (got ${JSON.stringify(result.skipped)})`
    );
    assert.equal(result.source, "var x = 1;", "and nothing was written to it");

    const elsewhere = patchSocketResilience("var x = 1;", "31fae89f7d7805b5.js");
    assert.deepEqual(elsewhere.skipped, [], "a chunk without the socket is not our business");
    assert.equal(elsewhere.source, "var x = 1;", "and is returned untouched");
  });

  test("patchClientChunk composes it with the other passes", () => {
    const result = patchClientChunk("219b97e8e5e970d5.js", pristine);
    assert.ok(
      result.applied.some((note) => note.includes("heartbeat")),
      `the socket edits are part of the composed pass (got ${result.applied.length} edits)`
    );
  });

  test("the reconnect delay backs off, caps, and jitters", () => {
    const fixed = () => 0; // the floor of the jitter window, so the arithmetic is visible
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7, 99].map((attempt) => wsRetryDelay(attempt, fixed)),
      [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
      "1s doubling to a 30s ceiling"
    );

    // Jitter is bounded, and a fleet of tabs does not return in lockstep.
    for (const attempt of [1, 4, 6]) {
      for (const roll of [0, 0.5, 0.999999]) {
        const base = wsRetryDelay(attempt, () => 0);
        const delay = wsRetryDelay(attempt, () => roll);
        assert.ok(delay >= base && delay < base + 1000, `attempt ${attempt} roll ${roll} -> ${delay}`);
      }
    }
    const spread = new Set(Array.from({ length: 50 }, () => wsRetryDelay(6)));
    assert.ok(spread.size > 25, `50 rolls give ${spread.size} distinct delays`);

    // A caller that has not counted anything, or counted nonsense, still gets a
    // usable delay rather than 0 or NaN.
    for (const attempt of [0, -3, undefined, null, NaN]) {
      const delay = wsRetryDelay(attempt, fixed);
      assert.equal(delay, 1000, `attempt ${String(attempt)} behaves as the first retry`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. The server's half: ping, pong, and reaping what has gone quiet
 * ------------------------------------------------------------------ */

const PING_MS = 1000;

function env(extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    NODE_ENV: "",
    REQUIRE_DATABASE_URL: "",
    ALLOWED_ORIGINS: FRONTEND,
    WS_PING_MS: String(PING_MS),
    ...extra,
  };
}

async function startServer(childEnv) {
  const child = spawn(process.execPath, ["tools/server.mjs", "0"], { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
  let errors = "";
  child.stderr.on("data", (b) => (errors += b.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server never reported a port")), 15_000);
    let out = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString();
      const match = out.match(/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
  });
  return { child, port, errors: () => errors };
}

/** A client-side frame, which RFC 6455 requires to be masked. */
function clientFrame(opcode, payload = "") {
  const data = Buffer.from(payload);
  assert.ok(data.length < 126, "these tests only send short frames");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | data.length]), mask, masked]);
}

/**
 * Server frames are never masked, so only the length needs decoding — including
 * the extended forms, because an unsubscribed socket still receives all thirteen
 * price frames a second and those are past 125 bytes.
 */
function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const opcode = buffer[offset] & 0x0f;
    let len = buffer[offset + 1] & 0x7f;
    let p = offset + 2;
    if (len === 126) {
      if (p + 2 > buffer.length) break;
      len = buffer.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (p + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(p));
      p += 8;
    }
    if (p + len > buffer.length) break;
    frames.push({ opcode, text: buffer.subarray(p, p + len).toString("utf8") });
    offset = p + len;
  }
  return { frames, rest: buffer.subarray(offset) };
}

/**
 * A raw socket we can drive: it records every frame the server sends, and can
 * answer a ping or refuse to, which is the whole difference between the two
 * tests below.
 */
function openSocket(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const req = http.request({
      port,
      host: "127.0.0.1",
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        Origin: FRONTEND,
      },
    });
    req.on("upgrade", (res, socket) => {
      let buffer = Buffer.alloc(0);
      const received = [];
      const waiters = [];
      socket.on("data", (chunk) => {
        const parsed = parseFrames(Buffer.concat([buffer, chunk]));
        buffer = parsed.rest;
        for (const frame of parsed.frames) {
          received.push(frame);
          for (const waiter of waiters.splice(0)) waiter();
        }
      });
      const closed = new Promise((done) => socket.on("close", () => done("closed")));
      socket.on("error", () => {});
      resolve({
        socket,
        received,
        status: res.statusCode,
        send: (obj) => socket.write(clientFrame(0x1, JSON.stringify(obj))),
        pong: () => socket.write(clientFrame(0xa, "")),
        closed,
        /** Waits until `check` is true of what has arrived, and reports whether it ever was. */
        async waitUntil(check, ms = 5000) {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (check()) return true;
            await Promise.race([
              new Promise((done) => waiters.push(done)),
              new Promise((done) => setTimeout(done, 100)),
            ]);
          }
          return check();
        },
        pings: () => received.filter((f) => f.opcode === 0x9).length,
        closes: () => received.filter((f) => f.opcode === 0x8).length,
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("server socket heartbeat", () => {
  let server;
  let port;

  before(async () => {
    server = await startServer(env());
    port = server.port;
  });

  after(() => {
    server.child.kill("SIGTERM");
  });

  test("the server pings a socket that is doing nothing, at the protocol level", async () => {
    const client = await openSocket(port);
    const pinged = await client.waitUntil(() => client.pings() >= 1, 4000);
    assert.ok(pinged, `a protocol ping arrived (frames so far: ${JSON.stringify(client.received)})`);

    // A socket that answers is not reaped: the browser answers by itself, with
    // no page JavaScript involved, so any client built before this change is
    // kept too.
    client.pong();
    const pingedAgain = await client.waitUntil(() => client.pings() >= 2, 4000);
    assert.ok(pingedAgain, "it keeps being pinged after answering");
    client.pong();
    const outcome = await Promise.race([
      client.closed,
      new Promise((done) => setTimeout(() => done("alive"), PING_MS + 500)),
    ]);
    assert.equal(outcome, "alive", "an answered socket stays up");
    client.socket.destroy();
  });

  test("a socket that never answers is dropped", async () => {
    const client = await openSocket(port);
    await client.waitUntil(() => client.pings() >= 1, 4000);
    // Two intervals of silence: the reaper closes it, and a close frame (0x8)
    // is sent first so the client is told rather than cut off.
    const outcome = await Promise.race([
      client.closed,
      new Promise((done) => setTimeout(() => done("still-open"), PING_MS * 4)),
    ]);
    assert.equal(outcome, "closed", "a silent socket is reaped");
    assert.equal(client.closes(), 1, "with a close frame, not just a reset");
  });

  test("the application heartbeat is answered, which is what the client watches for", async () => {
    const client = await openSocket(port);
    client.send({ type: "ping" });
    const answered = await client.waitUntil(
      () => client.received.some((f) => f.text && f.text.includes('"type":"pong"')),
      4000
    );
    assert.ok(answered, "ping -> pong");
    client.socket.destroy();
  });

  test("the ping is what keeps a client that predates the patch alive", async () => {
    // Nothing but protocol pongs: no auth, no subscribe, no application
    // heartbeat — i.e. exactly what the bundle deployed before this change
    // does. It must not be reaped.
    const client = await openSocket(port);
    const interval = setInterval(() => client.pong(), 200);
    try {
      await client.waitUntil(() => client.pings() >= 1, 4000);
      const outcome = await Promise.race([
        client.closed,
        new Promise((done) => setTimeout(() => done("alive"), 3000)),
      ]);
      assert.equal(outcome, "alive", "a client that only answers pings is kept");
    } finally {
      clearInterval(interval);
      client.socket.destroy();
    }
  });
});
