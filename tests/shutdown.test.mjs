/**
 * Startup and shutdown, which is what a hosting platform actually exercises.
 *
 * Railway redeploys by killing the process, so the way a process stops matters
 * as much as the way it starts: the trading tick must stop, socket clients must
 * be told rather than dropped, and the ledger pool must be released.
 *
 * The signal is emitted in-process rather than delivered by the OS on purpose.
 * Node does not deliver SIGTERM to a process on Windows — the platform this is
 * developed on — so `process.kill(pid, "SIGTERM")` would test the operating
 * system, not this code. Emitting it runs the very handler a Linux host will
 * call, and leaves only the delivery mechanism unproven.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const SERVER_URL = pathToFileURL(join(process.cwd(), "tools", "server.mjs")).href;

/**
 * Starts the real server, optionally asking it to shut itself down after a
 * delay, and resolves once the port has been reported.
 */
function startServer({ shutdownAfterMs = null, env = {} } = {}) {
  const trigger =
    shutdownAfterMs === null ? "" : `setTimeout(() => process.emit("SIGTERM"), ${shutdownAfterMs});`;

  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(SERVER_URL)}); ${trigger}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ALLOWED_ORIGINS: "",
        DATABASE_URL: "",
        NODE_ENV: "",
        REQUIRE_DATABASE_URL: "",
        // server.mjs prefers an argv port, which this entry point does not have.
        PORT: "0",
        ...env,
      },
    }
  );

  let out = "";
  let errors = "";
  child.stdout.on("data", (b) => (out += b.toString()));
  child.stderr.on("data", (b) => (errors += b.toString()));

  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no port reported. stderr: ${errors}`)), 20_000);
    const watch = () => {
      const match = out.match(/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout.on("data", watch);
    child.on("error", reject);
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  return {
    child,
    port,
    exited,
    out: () => out,
    errors: () => errors,
    /** Waits for a line, so an assertion cannot race the shutdown. */
    waitFor: (fragment, ms = 15_000) =>
      new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`never saw "${fragment}". log:\n${out}`)), ms);
        const check = () => {
          if (out.includes(fragment)) {
            clearTimeout(deadline);
            resolve();
          }
        };
        child.stdout.on("data", check);
        check();
      }),
  };
}

/** Opens a socket and reports whatever the server sends back on it. */
function openSocket(port) {
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
        Origin: `http://127.0.0.1:${port}`,
      },
    });
    const timer = setTimeout(() => reject(new Error("the socket never opened")), 15_000);
    req.on("upgrade", (_res, socket) => {
      clearTimeout(timer);
      const frames = [];
      socket.on("data", (buf) => frames.push(buf));
      socket.on("error", () => {});
      resolve({ socket, frames: () => Buffer.concat(frames) });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("startup and shutdown", () => {
  test("health reports the ledger and the environment without leaking a secret", async () => {
    const server = startServer({ env: { DATABASE_URL: "", FIXTURE_SECRET: "super-secret-value" } });
    const port = await server.port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await res.json();

      assert.equal(res.status, 200, "a healthy instance answers 200");
      assert.equal(body.ok, true);
      assert.equal(body.storage, "memory");
      assert.equal(body.ledger, "reachable", "the ledger is the dependency worth reporting");
      assert.equal(body.environment, "development");
      assert.equal(typeof body.uptime, "number");

      // The environment is named, never quoted: no configured value may appear.
      assert.doesNotMatch(JSON.stringify(body), /super-secret-value/);
    } finally {
      server.child.kill("SIGKILL");
    }
  });

  test("the boot log says which interface it bound and which environment it is in", async () => {
    const server = startServer();
    await server.port;
    // The port line arrives before the rest of the banner, so wait for the last
    // line being asserted rather than reading whatever happens to have landed.
    await server.waitFor("api base");
    try {
      assert.match(server.out(), /binding\s*: 0\.0\.0\.0:\d+ \(all interfaces\)/);
      assert.match(server.out(), /environment\s*: development/);
      assert.match(server.out(), /api base\s*: same-origin/);
    } finally {
      server.child.kill("SIGKILL");
    }
  });

  test("a shutdown stops the tick engine, closes the socket politely and exits cleanly", async () => {
    const server = startServer({ shutdownAfterMs: 2_500 });
    const port = await server.port;
    try {
      const client = await openSocket(port);

      // Give the tick engine a moment to have written at least one frame, so the
      // close frame is distinguishable from the opening burst.
      await new Promise((r) => setTimeout(r, 1_200));

      await server.waitFor("shutdown complete");
      const { code, signal } = await server.exited;

      assert.match(server.out(), /SIGTERM received/, "the handler ran");
      assert.equal(code, 0, `expected a clean exit, got code=${code} signal=${signal}`);
      assert.doesNotMatch(server.out(), /unhandled|UnhandledPromiseRejection/);

      // A close frame, not a dropped connection: opcode 0x88 and status 1001.
      const frames = client.frames();
      const closeAt = frames.indexOf(Buffer.from([0x88]));
      assert.ok(closeAt >= 0, "the client was sent a close frame");
      assert.equal(frames.readUInt16BE(closeAt + 2), 1001, "and it says the server is going away");

      // The port must be free again, or a redeploy cannot bind it.
      await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), "the listener is closed");
      client.socket.destroy();
    } finally {
      server.child.kill("SIGKILL");
    }
  });
});
