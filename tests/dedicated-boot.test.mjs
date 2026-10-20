/**
 * The account a deployment creates for itself when it boots.
 *
 * WHY THIS FILE EXISTS. Provisioning the account from a command is useless on a
 * host whose free tier has no shell and whose database was created empty
 * seconds ago: there is nowhere to run the command and nothing to sign in with.
 * The server now reads DEDICATED_ACCOUNT_EMAIL and DEDICATED_ACCOUNT_PASSWORD
 * at boot and creates the account through the ordinary scrypt path.
 *
 * A unit test of `provisionAccount` would not cover that, because the risk is
 * the wiring: the environment is read too late, the account is created in a
 * store nothing serves, or the password ends up in the boot log. So this spawns
 * the real server, exactly as `npm start` does, and signs in over HTTP with the
 * credential the environment handed it.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const EMAIL = "boot.fixture@example.invalid";
// A fixture, never the operator's password: this repository is public.
const PASSWORD = "fixture-pass-9";

/**
 * Starts `tools/server.mjs` with whatever environment the test needs and
 * resolves once it reports the port it was given. An in-memory ledger is forced
 * by setting DATABASE_URL to empty, which the server treats as a decision
 * rather than an absence — see loadEnvFile in tools/server.mjs.
 */
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DATABASE_URL: "",
      NODE_ENV: "",
      REQUIRE_DATABASE_URL: "",
      DEDICATED_ACCOUNT_EMAIL: "",
      DEDICATED_ACCOUNT_PASSWORD: "",
      ...extraEnv,
    },
  });

  let output = "";
  child.stdout.on("data", (buf) => (output += buf.toString()));
  child.stderr.on("data", (buf) => (output += buf.toString()));

  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server never reported a port:\n${output}`)), 15_000);
    const poll = setInterval(() => {
      const match = output.match(/127\.0\.0\.1:(\d+)/);
      if (match) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    }, 25);
    child.on("exit", (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`the server exited (${code}) before listening:\n${output}`));
    });
  });

  return { child, port, output: () => output };
}

const login = async (base, body) => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

describe("the account a deployment provisions for itself", () => {
  test("exists at the first boot, with the stated balances, and can sign in", async () => {
    const server = startServer({
      DEDICATED_ACCOUNT_EMAIL: EMAIL,
      DEDICATED_ACCOUNT_PASSWORD: PASSWORD,
    });
    try {
      const port = await server.port;
      const base = `http://127.0.0.1:${port}`;

      const signedIn = await login(base, { email: EMAIL, password: PASSWORD });
      assert.equal(signedIn.status, 200, `login returned ${signedIn.status}: ${JSON.stringify(signedIn.body)}`);
      assert.equal(signedIn.body.user.email, EMAIL);
      assert.equal(signedIn.body.user.demo_balance, 10000);
      assert.equal(signedIn.body.user.real_balance, 9);
      assert.ok(signedIn.body.token, "a session token comes back");

      // The boot log must say what it did without ever saying the secret.
      const log = server.output();
      assert.match(log, /dedicated\s+: created/, "the boot says it created the account");
      assert.equal(log.includes(PASSWORD), false, "the password is never printed");
    } finally {
      server.child.kill();
    }
  });

  test("a wrong password is still refused", async () => {
    const server = startServer({
      DEDICATED_ACCOUNT_EMAIL: EMAIL,
      DEDICATED_ACCOUNT_PASSWORD: PASSWORD,
    });
    try {
      const port = await server.port;
      const wrong = await login(`http://127.0.0.1:${port}`, { email: EMAIL, password: "not-the-password" });
      assert.equal(wrong.status, 401);
    } finally {
      server.child.kill();
    }
  });

  test("nothing is created when the deployment does not name an account", async () => {
    const server = startServer();
    try {
      const port = await server.port;
      const base = `http://127.0.0.1:${port}`;
      const signedIn = await login(base, { email: EMAIL, password: PASSWORD });
      assert.equal(signedIn.status, 401, "no account exists to sign in with");
      assert.equal(/dedicated\s+: created/.test(server.output()), false);
    } finally {
      server.child.kill();
    }
  });

  test("an email without a password creates nothing, and says so", async () => {
    const server = startServer({ DEDICATED_ACCOUNT_EMAIL: EMAIL });
    try {
      const port = await server.port;
      const signedIn = await login(`http://127.0.0.1:${port}`, { email: EMAIL, password: PASSWORD });
      assert.equal(signedIn.status, 401);
      assert.match(server.output(), /without DEDICATED_ACCOUNT_PASSWORD/);
    } finally {
      server.child.kill();
    }
  });
});
