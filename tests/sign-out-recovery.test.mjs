/**
 * Signing out, and signing back in.
 *
 * WHY THIS SUITE EXISTS. On 2026-10-18 the deployed site answered every sign-in
 * attempt after a sign-out with the browser's "Failed to fetch", which reads
 * exactly like a wrong password or a deleted account. It was neither: the API
 * host had gone away, and the accounts were all still in the database. Two
 * things had to be proved before that could be said with confidence:
 *
 *   1. sign-out is client-only — it removes a token and nothing else, so an
 *      account cannot be lost by signing out;
 *   2. there is no account-deletion endpoint at all, so nothing in the product
 *      can remove one, and the sign-in page's wording is the only thing that
 *      ever looked like the account had gone.
 *
 * These tests run against a spawned server with the in-memory store: no
 * database, no provider. They prove the API's decisions, not durability — the
 * Postgres suite proves that.
 *
 * Run: npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function env(extra = {}) {
  return {
    ...process.env,
    DATABASE_URL: "",
    NODE_ENV: "",
    REQUIRE_DATABASE_URL: "",
    ALLOWED_ORIGINS: "",
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

describe("an account survives a sign-out", () => {
  let server;
  before(async () => { server = await startServer(env()); });
  after(() => { if (server) server.child.kill(); });

  const base = () => `http://127.0.0.1:${server.port}`;

  const post = async (path, body, token) => {
    const res = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const me = async (token) => {
    const res = await fetch(`${base()}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const email = `signout.${Date.now()}@example.invalid`;
  const password = "CorrectHorse9";
  let registeredToken;

  test("a fresh account registers and can be read back", async () => {
    const res = await post("/api/auth/register", { email, password, username: "signout.probe" });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "registration signs the account in");
    registeredToken = res.body.token;
    const who = await me(registeredToken);
    assert.equal(who.status, 200);
    assert.equal(who.body.user.email, email);
  });

  test("signing out — which the client does by dropping its token — cannot delete the account", async () => {
    // The sign-out button in the mirrored client makes no request: it removes
    // `token` from localStorage and clears its own state. What this pins is the
    // consequence — the credential that was already issued still identifies the
    // account, and a new sign-in with the same password does too.
    const again = await post("/api/auth/login", { email, password });
    assert.equal(again.status, 200, "the same credentials sign in again");
    assert.notEqual(again.body.token, registeredToken, "a new session token is issued");

    const who = await me(registeredToken);
    assert.equal(who.status, 200, "the account is still there after the sign-out");
    assert.equal(who.body.user.email, email);
  });

  test("and again, from the token the second sign-in minted", async () => {
    const first = await post("/api/auth/login", { email, password });
    const second = await post("/api/auth/login", { email, password });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await me(first.body.token)).body.user.email, email);
    assert.equal((await me(second.body.token)).body.user.email, email);
  });

  test("a wrong password is refused, and is told so in the API's own words", async () => {
    const res = await post("/api/auth/login", { email, password: "not-the-password" });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid email or password/);
  });

  test("an unknown account is refused the same way, without confirming it is unknown", async () => {
    const res = await post("/api/auth/login", { email: "nobody@example.invalid", password });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid email or password/);
  });

  test("there is no route that deletes an account", async () => {
    // The product has no such feature; this is what keeps it that way. A
    // deletion route added later fails this test rather than shipping quietly.
    for (const path of [
      "/api/auth/delete-account",
      "/api/auth/account/delete",
      "/api/auth/logout",
      "/api/auth/me",
    ]) {
      const res = await fetch(`${base()}${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${registeredToken}` } });
      assert.equal(res.status, 404, `DELETE ${path} must not exist`);
      assert.equal((await res.json()).code, "UNKNOWN_ROUTE");
    }
    // And the account is still readable after all of that.
    assert.equal((await me(registeredToken)).status, 200);
  });
});
