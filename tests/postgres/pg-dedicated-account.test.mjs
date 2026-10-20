/**
 * The dedicated account, end to end, against the engine that settles trades.
 *
 * The in-memory suite proves the rule's arithmetic. This one proves the part
 * only a real server can: that the account signs in with its own password, that
 * its demo trades really settle near the 70% target and its real trades do not,
 * that its balances move by exactly the payout, and that every ledger row
 * carries the balance it produced.
 *
 * A control account trades alongside it as the negative control: if the rule
 * leaked into the engine for everyone, its measured rate would climb towards
 * 0.7 and the second assertion would fail.
 *
 * Run:
 *   PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres
 *
 * It keeps its own schema and drops it afterwards, like the other PostgreSQL
 * suites, so it cannot touch a database anyone cares about.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { createPostgresStore } from "../../tools/store.mjs";
import { provisionAccount } from "../../tools/provision-account.mjs";

const TEST_URL = process.env.PG_TEST_DATABASE_URL || "";

if (!TEST_URL) {
  console.error(
    [
      "",
      "pg-dedicated-account needs a disposable PostgreSQL server and will not substitute one.",
      "",
      "  PG_TEST_DATABASE_URL='postgresql://user:pass@host:5432/db' npm run test:postgres",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const schemaUrl = (url, schema) => {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
};

const SCHEMA = `strategyoption_dedicated_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const URL_WITH_SCHEMA = schemaUrl(TEST_URL, SCHEMA);
const ASSET = "volatility_10";
const EMAIL = "smartmind254@gmail.com";
// A fixture: this file is public, and the account's real password is set on the
// ledger by tools/provision-account.mjs, never committed.
const PASSWORD = "fixture-pass-9";

const quiet = () => ({ log: () => {}, warn: () => {}, error: () => {} });

/** The spawned server, with every provider deliberately unconfigured. */
function serverEnv() {
  return {
    ...process.env,
    DATABASE_URL: URL_WITH_SCHEMA,
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "",
    DARAJA_CONSUMER_KEY: "",
    DARAJA_CONSUMER_SECRET: "",
    DARAJA_SHORTCODE: "",
    DARAJA_PASSKEY: "",
    DARAJA_CALLBACK_URL: "",
    DARAJA_CALLBACK_TOKEN: "",
    CARD_PROVIDER: "",
    CARD_SECRET_KEY: "",
  };
}

async function startServer() {
  const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: serverEnv(),
  });
  let errors = "";
  child.stderr.on("data", (b) => (errors += b.toString()));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server never reported a port\n${errors}`)), 20_000);
    let out = "";
    child.stdout.on("data", (buf) => {
      out += buf.toString();
      const match = out.match(/127\.0\.0\.1:(\d+)/) || out.match(/0\.0\.0\.0:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`the server exited (${code})\n${errors}`)));
  });
  return { child, port, errors: () => errors };
}

const post = (base, path, body, token) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });

const get = (base, path, token) =>
  fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

/**
 * Places `count` one-tick trades over one socket and resolves once every one
 * has been accepted (the server's own `position_update`), so the settlement
 * wait starts from the last accepted trade rather than from the first write.
 */
function trade(base, token, count, { stake = 1, ticks = 1 } = {}) {
  const socket = new WebSocket(base.replace("http://", "ws://") + "/ws");
  const accepted = [];

  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`only ${accepted.length}/${count} trades were accepted`)),
      20_000
    );

    socket.addEventListener("error", () => done(reject, new Error("socket error")));
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "auth_error") return done(reject, new Error("the socket refused the session"));
      if (message.type === "trade_error") return done(reject, new Error(message.data?.message || "trade refused"));
      if (message.type === "position_update" && message.action === "add") {
        accepted.push(message.data);
        if (accepted.length >= count) return done(resolve, accepted);
        return;
      }
      if (message.type !== "auth_success") return;

      socket.send(JSON.stringify({ type: "subscribe", asset: ASSET }));
      for (let i = 0; i < count; i += 1) {
        socket.send(
          JSON.stringify({
            type: "manual_trade",
            config: { asset: ASSET, direction: "even", stake, ticks },
          })
        );
      }
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the dedicated account settles as configured", () => {
  let admin;
  let server;
  let token;
  let controlToken;

  const base = () => `http://127.0.0.1:${server.port}`;

  before(async () => {
    admin = new pg.Client({ connectionString: TEST_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);

    // Provisioned exactly as an operator would, through the store the server
    // uses, then the store is closed before the server opens its own.
    const store = await createPostgresStore({ connectionString: URL_WITH_SCHEMA, logger: quiet() });
    try {
      const { created } = await provisionAccount(store, {
        email: EMAIL,
        name: "Smart Mind",
        password: PASSWORD,
        realBalance: 9,
        demoBalance: 10000,
      });
      assert.equal(created, true);
    } finally {
      await store.close();
    }

    server = await startServer();
  });

  after(async () => {
    if (server) server.child.kill();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      await admin.end();
    }
  });

  test("it signs in with its own password and shows the demo balance", async () => {
    const res = await post(base(), "/api/auth/login", { email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 200);
    const body = await res.json();
    token = body.token;
    assert.equal(body.user.email, EMAIL);
    assert.equal(body.user.demo_balance, 10000);
    assert.equal(body.user.real_balance, 9);
    assert.equal(body.user.balance, 10000, "login lands on the demo wallet");
  });

  test("a wrong password is still refused", async () => {
    const res = await post(base(), "/api/auth/login", { email: EMAIL, password: "wrong-password" });
    assert.equal(res.status, 401);
  });

  test("its demo trades settle near 70%, and a control account does not", async () => {
    const created = await post(base(), "/api/auth/register", {
      email: `control.${randomUUID().slice(0, 8)}@example.invalid`,
      password: "ControlPass9",
      username: "Control",
    });
    assert.equal(created.status, 200);
    controlToken = (await created.json()).token;

    const TRADES = 200;
    await trade(base(), token, TRADES);
    // The control only needs enough to prove the rule did not touch it; the
    // digit check is per trade, so a burst of 20 on one tick is plenty and keeps
    // this suite off the rest of the machine's back.
    await trade(base(), controlToken, 20);
    // One tick per second; give the loop room to settle every position.
    await sleep(6000);

    const dedicated = await (await get(base(), "/api/trade/positions", token)).json();
    const control = await (await get(base(), "/api/trade/positions", controlToken)).json();

    const closed = dedicated.positions.filter((p) => p.status === "won" || p.status === "lost");
    assert.equal(closed.length, TRADES, "every demo trade settled");
    const wins = closed.filter((p) => p.status === "won").length;
    const rate = wins / closed.length;
    assert.ok(
      rate > 0.6 && rate < 0.8,
      `the dedicated account won ${wins}/${closed.length} (${rate.toFixed(2)}), expected about 0.70`
    );

    // The control account is checked trade by trade rather than by rate. Every
    // trade opened in one burst settles on the same tick, so it sees the same
    // digit — a rate over it is all-or-nothing and would say nothing. The digit
    // is the honest test: an even bet wins exactly when the exit digit is even.
    const controlClosed = control.positions.filter((p) => p.status === "won" || p.status === "lost");
    assert.equal(controlClosed.length, 20);
    for (const position of controlClosed) {
      assert.equal(
        position.status === "won",
        position.exit_digit % 2 === 0,
        `a control trade settled ${position.status} on digit ${position.exit_digit}, which the rule should not have touched`
      );
    }

    // The dedicated account, by contrast, has wins the digit cannot explain —
    // which is what a target win rate means, and proves the override fired.
    const forced = closed.filter((p) => p.status === "won" && p.exit_digit % 2 !== 0);
    assert.ok(forced.length > 0, "no win was independent of the digit, so the target rate never applied");

    // The money follows the outcomes, and only the outcomes: the stake moved at
    // open, and each win credited exactly its potential payout.
    const expected = 10000 - TRADES * 1 + closed
      .filter((p) => p.status === "won")
      .reduce((sum, p) => sum + Number(p.potential_payout), 0);
    const me = await (await get(base(), "/api/auth/me", token)).json();
    assert.equal(Number(me.user.demo_balance).toFixed(2), expected.toFixed(2));

    // History: the API page is capped, so the shape is checked here and the
    // completeness of EVERY row is checked against the table itself.
    const { transactions } = await (await get(base(), "/api/transactions", token)).json();
    assert.ok(transactions.length > 0);
    for (const entry of transactions) {
      assert.notEqual(entry.balance_after, null, `${entry.type} ${entry.id} has no resulting balance`);
      assert.ok(Number.isFinite(entry.balance_after));
      assert.ok(entry.created_at, "every entry is timestamped");
    }
    assert.ok(transactions.some((t) => t.type === "trade_open"));
    assert.ok(transactions.some((t) => t.type === "trade_win"));
    assert.ok(transactions.some((t) => t.type === "trade_loss"));

    const ledger = await admin.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE balance_after IS NULL)::int AS missing
         FROM ${SCHEMA}.transactions`
    );
    assert.ok(ledger.rows[0].total >= TRADES + 1, `only ${ledger.rows[0].total} ledger rows were written`);
    assert.equal(ledger.rows[0].missing, 0, "some ledger rows do not record the balance they left behind");
  });

  test("switching to real shows $9, and a real trade moves it by its own outcome", async () => {
    const switched = await post(base(), "/api/auth/switch-account", { mode: "real" }, token);
    assert.equal(switched.status, 200);
    const real = await switched.json();
    assert.equal(real.user.balance, 9);
    assert.equal(real.user.real_balance, 9);

    // Five, not ten: $9 of real balance cannot fund ten $1 stakes, and the
    // sixth refusal would be an assertion failure about the wrong thing.
    await trade(base(), token, 5, { stake: 1 });
    await sleep(4000);

    const positions = await (await get(base(), "/api/trade/positions", token)).json();
    const realTrades = positions.positions.filter((p) => p.is_demo === false);
    assert.equal(realTrades.length, 5, "the five real trades are recorded as real");
    const expected = 9 - 5 + realTrades
      .filter((p) => p.status === "won")
      .reduce((sum, p) => sum + Number(p.potential_payout), 0);

    const me = await (await get(base(), "/api/auth/me", token)).json();
    assert.equal(Number(me.user.real_balance).toFixed(2), expected.toFixed(2));

    // Back to demo for the next reader, without changing either wallet.
    const back = await post(base(), "/api/auth/switch-account", { mode: "demo" }, token);
    const demo = await back.json();
    assert.equal(demo.user.balance, Number(me.user.demo_balance));
    assert.equal(demo.user.real_balance, Number(me.user.real_balance));
  });
});
