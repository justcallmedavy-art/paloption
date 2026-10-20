/**
 * The deploy checker, tested against a server whose state is known.
 *
 * A checker is worth as much as its willingness to report bad news, so these
 * tests care about two things: that it PASSes the checks a working service
 * should pass, and that it FAILs the ones a broken deployment would hide —
 * including the failure it originally got wrong, a host that answers every
 * request with 404 while not being this service at all.
 *
 * The ledger check is expected to FAIL here: the spawned server has no
 * DATABASE_URL and keeps its book in memory, which is exactly what the check
 * exists to catch.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFile } from "node:child_process";

/** No ALLOWED_ORIGINS and no DATABASE_URL: the single-origin, in-memory shape. */
function env(extra = {}) {
  return {
    ...process.env,
    ALLOWED_ORIGINS: "",
    DATABASE_URL: "",
    NODE_ENV: "",
    REQUIRE_DATABASE_URL: "",
    ...extra,
  };
}

async function startServer(childEnv) {
  const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv,
  });
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
  return { child, port };
}

/**
 * Runs the checker against a host and reports what a person would see: the exit
 * status and the report itself. A non-zero exit is the tool doing its job, so it
 * is returned rather than thrown.
 */
function runChecker(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["tools/verify-deploy.mjs", ...args], { timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code ?? 1 : 0, out: stdout, err: stderr });
    });
  });
}

/** The lines the report is built from, so an assertion can name one check. */
const lineFor = (out, fragment) =>
  out.split("\n").find((line) => /^(PASS|FAIL|SKIP)\s/.test(line) && line.includes(fragment)) || "";

describe("the deploy checker", () => {
  test("passes what a working service should pass, and fails only the ledger", async () => {
    const { child, port } = await startServer(env());
    try {
      const { code, out } = await runChecker(["--url", `http://127.0.0.1:${port}`, "--register"]);

      for (const fragment of [
        "the service answers at all",
        "the client is served from this origin",
        "a same-origin request is accepted",
        "a foreign origin is refused",
        "the socket accepts this origin and refuses another",
        "an unknown API path answers JSON",
        "a refused login is a JSON error",
        "registration, login and the session they return work end to end",
        "protected routes reject an unauthenticated caller",
        "the cashier refuses unauthenticated and malformed requests",
        "the socket speaks the protocol the client expects",
        "the trading engine ticks without a client asking",
        "a session token authenticates the socket",
        "an anonymous socket cannot trade",
        "a client cannot set its own stake beyond its balance",
        "no response echoes a credential",
      ]) {
        assert.match(lineFor(out, fragment), /^PASS/, `expected PASS: ${lineFor(out, fragment) || fragment}`);
      }

      const failures = out.split("\n").filter((line) => line.startsWith("FAIL"));
      assert.equal(failures.length, 1, `only the ledger should fail here, got:\n${failures.join("\n")}`);
      assert.match(failures[0], /storage=memory/, "and it should say the ledger is in memory");

      // One failure still means "not verified", even with everything else green.
      assert.equal(code, 1, "a failing check must not exit 0");
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a host that answers but is not this service is a failure, not a pass", async () => {
    // Render answers 404 for any hostname nobody has claimed. A checker that
    // treats a reply as proof of life would call that deployment up.
    const impostor = http.createServer((req, res) => {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });
    await new Promise((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const { port } = impostor.address();

    try {
      const { code, out } = await runChecker(["--url", `http://127.0.0.1:${port}`]);

      assert.match(lineFor(out, "the service answers at all"), /^FAIL/, "a 404 host is not a live service");
      assert.match(lineFor(out, "the client is served from this origin"), /^FAIL/);
      assert.equal(code, 1);
      assert.doesNotMatch(out, /0 failed/, "nothing may be reported as verified");
    } finally {
      impostor.close();
    }
  });

  test("creating an account is opt-in, so a default run writes nothing", async () => {
    const { child, port } = await startServer(env());
    try {
      const { out } = await runChecker(["--url", `http://127.0.0.1:${port}`]);

      // Everything that would need an account must skip, not quietly pass.
      for (const fragment of [
        "registration, login and the session they return",
        "a session token authenticates the socket",
        "a client cannot set its own stake beyond its balance",
        "the cashier settles real payments",
        "records survive a restart",
      ]) {
        assert.match(lineFor(out, fragment), /^SKIP/, `expected SKIP without --register: ${fragment}`);
      }

      // The cashier is money: it is never checked here, by design.
      assert.match(out, /npm run verify:cashier/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("a missing or malformed --url is refused before any request", async () => {
    const noUrl = await runChecker([]);
    assert.equal(noUrl.code, 1);

    const bad = await runChecker(["--url", "strategyoption-api.onrender.com"]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /must be an http\(s\) origin/);
  });
});
