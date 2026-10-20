/**
 * The tick engine is armed before the ledger is connected.
 *
 * This is a regression test for a crash that only appeared against a real
 * database: the trading interval is created while the module is still evaluating,
 * `store = await createStore()` runs after it, and a slow connection therefore
 * leaves the interval firing with `store === null`. Dereferencing it inside the
 * async callback rejects a promise nobody awaits, which takes the whole process
 * down on boot — before it ever listens, so the platform sees a crash loop
 * rather than a degraded instance.
 *
 * The database is simulated with a TCP listener that accepts the connection and
 * then answers nothing. That is not a mock of Postgres; it is a database that is
 * slow to complete the handshake, which is the condition that produced the bug,
 * and unlike a real timeout it is deterministic — pg has no connection deadline,
 * so the client waits for as long as the test needs.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const SERVER_URL = pathToFileURL(join(process.cwd(), "tools", "server.mjs")).href;

/** How many tick intervals to sit through before judging the process. */
const TICKS = 3;

/**
 * A listener that completes the TCP handshake and then stays silent.
 *
 * `connections` is what makes the test meaningful: it proves the server reached
 * `createStore()` and dialled the database, so the ticks counted below happened
 * while the store really was still null.
 */
function stalledDatabase() {
  const sockets = new Set();
  let connections = 0;

  const listener = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      resolve({
        port: listener.address().port,
        connections: () => connections,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            listener.close(done);
          }),
      });
    });
  });
}

/** Starts tools/server.mjs against a database URL and collects its output. */
function startBoot(databaseUrl) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(SERVER_URL)});`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ALLOWED_ORIGINS: "",
        NODE_ENV: "",
        REQUIRE_DATABASE_URL: "",
        // Never reached while the boot is stalled, but pinned so a developer's
        // shell cannot make this test bind a port.
        PORT: "0",
        DATABASE_URL: databaseUrl,
      },
    }
  );

  let out = "";
  let errors = "";
  child.stdout.on("data", (b) => (out += b.toString()));
  child.stderr.on("data", (b) => (errors += b.toString()));

  return {
    child,
    out: () => out,
    errors: () => errors,
    exited: new Promise((resolve) =>
      child.on("exit", (code, signal) => resolve({ code, signal }))
    ),
  };
}

/** Polls until `check` holds, so an assertion cannot race the child process. */
function waitFor(check, ms, message) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(message));
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe("boot against a ledger that is slow to answer", () => {
  test("the tick engine skips while the store connects instead of crashing the process", async () => {
    const database = await stalledDatabase();
    const boot = startBoot(
      `postgres://ledger:ledger@127.0.0.1:${database.port}/ledger`
    );

    try {
      await waitFor(
        () => database.connections() > 0,
        15_000,
        `the server never dialled the database. log:\n${boot.out()}${boot.errors()}`
      );

      // The interval's first fire is at one second; wait well past several so a
      // single unlucky tick cannot hide the regression.
      await new Promise((resolve) => setTimeout(resolve, TICKS * 1_000 + 500));

      const log = boot.out() + boot.errors();
      assert.equal(
        boot.child.exitCode,
        null,
        `the process died while the ledger was connecting (exit ${boot.child.exitCode}):\n${log}`
      );
      assert.doesNotMatch(
        log,
        /unhandled|UnhandledPromiseRejection|Cannot read properties of null/,
        `a tick dereferenced the store before it existed:\n${log}`
      );

      // Still connecting, not silently finished: the banner is printed only
      // after createStore() returns, so its absence is what makes the check
      // above "alive during boot" rather than "alive after boot".
      assert.doesNotMatch(log, /storage\s*:/, `the boot completed; nothing was stalled:\n${log}`);
      assert.doesNotMatch(log, /api base/, `the boot completed; nothing was stalled:\n${log}`);
    } finally {
      boot.child.kill("SIGKILL");
      await boot.exited;
      await database.close();
    }
  });
});
