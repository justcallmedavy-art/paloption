/**
 * Transport and storage tests for the split deployment.
 *
 * These cover the parts that only exist because the frontend and the API are
 * separate deployments: which browser origins may call the API, which may open a
 * trading socket, and where the client thinks the API is. They also pin the
 * storage guarantees the JSON ledger could not make — a deposit and a position
 * are each settled exactly once, and a balance cannot be overdrawn.
 *
 * Everything here runs against a spawned server using the in-memory store, so no
 * database and no network provider is involved.
 *
 * Run: npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createMemoryStore, round2, needsSsl } from "../tools/store.mjs";
import { patchApiBase, apiBaseFromEnv } from "../tools/client-patches.mjs";

const FRONTEND = "https://strategyoption.vercel.app";

function env(extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    NODE_ENV: "",
    REQUIRE_DATABASE_URL: "",
    ALLOWED_ORIGINS: FRONTEND,
    ...extra,
  };
}

async function startServer(childEnv) {
  const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
  let errors = "";
  child.stderr.on("data", (b) => (errors += b.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the server never reported a port")), 15_000);
    let out = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString();
      const match = out.match(/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.on("error", reject);
  });
  return { child, port, errors: () => errors };
}

/**
 * A raw upgrade request, which is the only way to send a chosen Origin — the
 * WebSocket constructor will not let a page choose one.
 *
 * The socket is torn down as soon as the status is known: a test that only wants
 * the status code must not leave a live socket behind, or the reset arrives
 * after the test has finished and the runner reports an uncaught exception.
 */
function upgrade(port, origin) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port,
      host: "127.0.0.1",
      path: "/ws",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": Buffer.from("0123456789abcdef").toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...(origin ? { Origin: origin } : {}),
      },
    });
    const settle = (status) => {
      try { req.destroy(); } catch { /* already gone */ }
      resolve(status);
    };
    req.on("response", (res) => { res.resume(); settle(res.statusCode); });
    req.on("upgrade", (res) => { try { res.socket?.destroy(); } catch { /* ignore */ } settle(101); });
    // Tearing the client down is expected here, so its reset is not a failure.
    req.on("error", (err) => { if (/ECONNRESET|EPIPE/.test(err?.code || "")) return; reject(err); });
    req.end();
  });
}

describe("origins, CORS and the API base", () => {
  let server;
  before(async () => { server = await startServer(env()); });
  after(() => { if (server) server.child.kill(); });

  const base = () => `http://127.0.0.1:${server.port}`;

  test("a configured origin is granted CORS on the API", async () => {
    const res = await fetch(`${base()}/api/auth/exchange-rate`, { headers: { Origin: FRONTEND } });
    assert.equal(res.headers.get("access-control-allow-origin"), FRONTEND);
    assert.equal(res.headers.get("vary"), "Origin");
    // The client authenticates with a Bearer token, so no cookie may ride along.
    assert.equal(res.headers.get("access-control-allow-credentials"), null, "no credential grants");
  });

  test("an unlisted origin is refused, not merely left without headers", async () => {
    const res = await fetch(`${base()}/api/auth/exchange-rate`, { headers: { Origin: "https://evil.example" } });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, "ORIGIN_NOT_ALLOWED");
  });

  test("a request with no Origin at all is served", async () => {
    // curl, the suite's own client and server-side callers send no Origin.
    const res = await fetch(`${base()}/healthz`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test("a preflight is answered without reaching the route", async () => {
    const res = await fetch(`${base()}/api/auth/mpesa/stk-push`, {
      method: "OPTIONS",
      headers: { Origin: FRONTEND, "Access-Control-Request-Method": "POST" },
    });
    assert.equal(res.status, 204);
    assert.match(res.headers.get("access-control-allow-headers"), /Authorization/i);
    assert.match(res.headers.get("access-control-allow-methods"), /POST/);
  });

  test("the socket refuses an origin the API would refuse", async () => {
    // A WebSocket handshake is exempt from CORS, so this is the only guard.
    assert.equal(await upgrade(server.port, "https://evil.example"), 403);
  });

  test("the socket accepts the configured origin", async () => {
    assert.equal(await upgrade(server.port, FRONTEND), 101);
    // Let the teardown land before the test ends.
    await new Promise((r) => setTimeout(r, 100));
  });

  test("health reports which storage is in use", async () => {
    const body = await (await fetch(`${base()}/healthz`)).json();
    assert.equal(body.storage, "memory");
  });

  test("the client's API base is configurable and derives a secure socket", () => {
    const from = 'let t="";e.s(["getApiUrl",0,()=>t,"getWsUrl",0,()=>{let e=t.replace(/^http/,"ws");return`${e}/ws`}])';
    const chunk = `74728,e=>{"use strict";${from}}`;

    const load = (source, { override, protocol = "https:" }) => {
      const exports = {};
      globalThis.__STRATEGYOPTION_API_URL__ = override;
      const mod = source.replace(/^74728,/, "");
      new Function("e", "location", "globalThis", `return (${mod})(e, {}, {});`)(
        { s: (t) => { for (let i = 0; i < t.length; i += 3) exports[t[i]] = t[i + 2]; } },
        { protocol },
        globalThis
      );
      return { api: exports.getApiUrl(), ws: exports.getWsUrl() };
    };

    const baked = patchApiBase(chunk, "https://api.example").source;
    assert.deepEqual(load(baked, {}), { api: "https://api.example", ws: "wss://api.example/ws" });

    // Unset means same-origin, which is what a single-host deployment wants.
    const plain = patchApiBase(chunk, "").source;
    assert.deepEqual(load(plain, {}), { api: "", ws: "/ws" });

    // A runtime value wins, so a built frontend can still be re-pointed.
    assert.equal(load(baked, { override: "https://other.example" }).api, "https://other.example");

    // A plain ws:// to a public host is upgraded rather than sent in the clear.
    const insecure = patchApiBase(chunk, "http://203.0.113.9:8080").source;
    assert.equal(load(insecure, {}).ws, "wss://203.0.113.9:8080/ws");

    // ...but loopback stays ws, which is what local development needs.
    const loopback = patchApiBase(chunk, "http://127.0.0.1:4174").source;
    assert.equal(load(loopback, {}).ws, "ws://127.0.0.1:4174/ws");

    // A chunk without the module is returned untouched.
    const untouched = patchApiBase("e=>{doNothing()}", "https://api.example");
    assert.equal(untouched.count, 0);
    assert.equal(untouched.source, "e=>{doNothing()}");

    assert.equal(apiBaseFromEnv({ VITE_API_URL: "https://x.test/" }), "https://x.test", "trailing slash dropped");
  });

  test("production without a database refuses to boot", async () => {
    const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: env({ NODE_ENV: "production" }),
    });
    let output = "";
    child.stdout.on("data", (b) => (output += b.toString()));
    child.stderr.on("data", (b) => (output += b.toString()));
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.notEqual(code, 0, "an in-memory ledger in production must not start");
    assert.match(output, /DATABASE_URL is not set/);
  });
});

describe("storage guarantees", () => {
  const user = (overrides = {}) => ({
    id: "u1", email: "a@example.com", username: "A", salt: "s", password_hash: "h",
    is_demo: false, demo_balance: 5, real_balance: 100, two_factor_enabled: false,
    referral_code: "AAA", created_at: new Date().toISOString(), ...overrides,
  });

  test("a stake that exceeds the balance is refused, and nothing is written", async () => {
    const store = createMemoryStore();
    await store.createUser(user());
    await assert.rejects(
      () => store.debitAndOpenPosition({
        userId: "u1",
        balanceKey: "real_balance",
        stake: 1000,
        position: { id: "p1", user_id: "u1", status: "open" },
        transaction: { id: "t1", user_id: "u1", type: "trade_open", amount: -1000, status: "completed" },
      }),
      (e) => e.code === "INSUFFICIENT_BALANCE"
    );
    assert.equal((await store.findUserById("u1")).real_balance, 100);
    assert.equal((await store.listPositionsByUser("u1")).length, 0, "no position may be left behind");
    assert.equal((await store.listTransactionsByUser("u1")).length, 0);
  });

  test("a position settles once, however many times settlement is attempted", async () => {
    const store = createMemoryStore();
    await store.createUser(user());
    await store.debitAndOpenPosition({
      userId: "u1",
      balanceKey: "real_balance",
      stake: 10,
      position: { id: "p1", user_id: "u1", status: "open", auto: false, ticks: 1, current_tick: 0 },
      transaction: { id: "t1", user_id: "u1", type: "trade_open", amount: -10, status: "completed" },
    });

    const claim = (n) => store.settlePosition({
      positionId: "p1",
      userId: "u1",
      balanceKey: "real_balance",
      credit: 19.52,
      position: { status: "won", exit_price: 1, exit_digit: 1, profit_loss: 9.52, settled_at: n, closed_at: new Date().toISOString() },
      transaction: { id: `t-win-${n}`, user_id: "u1", type: "trade_win", amount: 9.52, status: "completed" },
    });

    assert.equal((await claim(1)).settled, true);
    assert.equal((await claim(2)).settled, false, "the second settlement must not be paid");
    assert.equal((await store.findUserById("u1")).real_balance, round2(100 - 10 + 19.52));
    assert.equal((await store.listTransactionsByUser("u1")).filter((t) => t.type === "trade_win").length, 1);
  });

  test("a failed write inside a transaction leaves nothing behind", async () => {
    const store = createMemoryStore();
    await store.createUser(user());
    store.failWrites = true;
    await assert.rejects(
      () => store.tx(async (t) => {
        await t.creditBalance({ userId: "u1", balanceKey: "real_balance", amount: 50 });
      })
    );
    store.failWrites = false;
    assert.equal((await store.findUserById("u1")).real_balance, 100, "the credit must have rolled back");
  });

  test("a rollback keeps the objects callers already hold", async () => {
    // Restoration replaces clones in a naive implementation, silently detaching
    // every reference a caller kept — which reads as "the write vanished".
    const store = createMemoryStore();
    const created = await store.createUser(user());
    await assert.rejects(() => store.tx(async () => { throw new Error("boom"); }));
    assert.equal(created.real_balance, 100);
    await store.tx(async (t) => t.creditBalance({ userId: "u1", balanceKey: "real_balance", amount: 5 }));
    assert.equal((await store.findUserById("u1")).real_balance, 105);
    assert.equal((await store.findUserById("u1")).id, "u1");
  });

  test("a second-factor challenge survives a wrong code but is spent by a correct one", async () => {
    const store = createMemoryStore();
    await store.savePending2fa("tmp_1", { userId: "u1", code: "123456" });
    assert.equal((await store.findPending2fa("tmp_1"))?.code, "123456", "a wrong code must not consume it");
    assert.equal((await store.takePending2fa("tmp_1"))?.code, "123456");
    assert.equal(await store.findPending2fa("tmp_1"), null, "a used challenge is gone");
  });
});

describe("choosing TLS from the connection string", () => {
  test("Railway's private address stays plaintext while its public proxy does not", () => {
    assert.equal(
      needsSsl("postgresql://postgres:pw@postgres.railway.internal:5432/railway"),
      false,
      "the project's private network does not offer TLS, so requesting it would fail the connection"
    );
    assert.equal(
      needsSsl("postgresql://postgres:pw@turntable.proxy.rlwy.net:12345/railway"),
      true,
      "the public proxy refuses a plaintext connection"
    );
    assert.equal(needsSsl("postgresql://postgres:pw@containers-us-west-1.railway.app:6789/railway"), true);
  });

  test("the hosts that were already handled behave as before", () => {
    assert.equal(needsSsl("postgresql://user:pw@localhost:5432/strategyoption"), false);
    assert.equal(needsSsl("postgresql://u:p@host/db?sslmode=require"), true);
    assert.equal(needsSsl("postgresql://u:p@ep-x.us-east-2.aws.neon.tech/db"), true);
    assert.equal(needsSsl(""), false, "no connection string cannot mean a TLS requirement");
  });
});
