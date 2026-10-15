/**
 * The error a visitor sees when no API is behind the frontend.
 *
 * Every failed auth request in the mirror was written as
 * `if(!i.ok)throw Error((await i.json()).error||"Registration failed")`, and
 * that fallback is unreachable for the one case that matters: a static host
 * answering with an HTML 404 makes `i.json()` throw before `||` is evaluated,
 * so the browser's parser message is what a visitor gets —
 *
 *   Unexpected token 'T', "The page c"... is not valid JSON
 *
 * These tests lock the fix in three ways, because the last two are the ones a
 * string substitution could pass while still producing broken code:
 *
 *   1. every occurrence in the real chunks is rewritten, and they still parse;
 *   2. a body that cannot be read reports the status;
 *   3. a body that CAN be read is untouched — a genuine refusal still shows the
 *      server's own message, and a JSON body with no `error` still shows the
 *      sentence the author wrote.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { fixUnparseableErrorMessages, AUTH_ERROR_CHUNKS } from "../tools/client-patches.mjs";

const chunkPath = (name) => `site/_next/static/chunks/${name}`;

/** Whether the source parses, so a pre-existing quirk is not misattributed. */
function parses(source) {
  try {
    new vm.Script(source);
    return true;
  } catch {
    return false;
  }
}

/**
 * A source that carries the idiom, rewritten by the patch and then RUN. This is
 * the load-bearing helper: it is the difference between checking that bytes
 * changed and checking that the code works.
 */
const SNIPPET =
  "async function g(url){let i=await fetch(url);" +
  'if(!i.ok)throw Error((await i.json()).error||"Registration failed");' +
  "let s=await i.json();return s.token}";

function patchedFn() {
  const { source, count } = fixUnparseableErrorMessages(SNIPPET, "synthetic.js");
  assert.equal(count, 1, "the synthetic site must be rewritten");

  return async function call(response) {
    const sandbox = { fetch: async () => response };
    vm.createContext(sandbox);
    vm.runInContext(`${source};globalThis.__g=g;`, sandbox);
    return sandbox.__g("https://static-host.example/api/auth/register");
  };
}

/** The exact body Vercel returns for an unknown path, trimmed to 60 bytes. */
const htmlBody = () => {
  throw new SyntaxError(`Unexpected token 'T', "The page c"... is not valid JSON`);
};

describe("errors from a frontend with no API behind it", () => {
  test("every occurrence in the mirror is rewritten, and the chunks still parse", async () => {
    let total = 0;

    for (const name of AUTH_ERROR_CHUNKS) {
      const original = await readFile(chunkPath(name), "utf8");
      const { source, count, skipped } = fixUnparseableErrorMessages(original, name);

      total += count;
      assert.equal(count, 4, `${name} carries four of them`);
      assert.equal(
        (source.match(/\.json\(\)\)\.error\|\|/g) || []).length,
        0,
        `${name} must have no unreachable fallback left`
      );
      assert.ok(source.includes("the service did not answer (HTTP "), `${name} gained the guard`);
      assert.deepEqual(skipped, [], `${name} should not report a skip`);
      assert.ok(parses(source), `${name} must still be valid JavaScript`);
      assert.ok(parses(original), `${name} parsed before the patch too, so the comparison means something`);
    }

    assert.equal(total, 12, "login, 2FA, demo and registration, in each of three chunks");
  });

  test("a body that cannot be read reports the status, not the parser error", async () => {
    const call = patchedFn();
    const err = await call({ ok: false, status: 404, json: async () => htmlBody() }).then(
      () => null,
      (e) => e
    );

    assert.ok(err, "it must still throw — the sign-up did fail");
    assert.doesNotMatch(err.message, /Unexpected token/, "the parser's complaint is not the user's problem");
    assert.match(err.message, /Registration failed: the service did not answer \(HTTP 404\)/);
  });

  test("a genuine refusal keeps the server's own message", async () => {
    const call = patchedFn();
    const err = await call({ ok: false, status: 400, json: async () => ({ error: "Email already registered" }) }).then(
      () => null,
      (e) => e
    );
    assert.equal(err.message, "Email already registered");
  });

  test("a JSON body with no error field keeps the sentence the author wrote", async () => {
    const call = patchedFn();
    const err = await call({ ok: false, status: 500, json: async () => ({}) }).then(
      () => null,
      (e) => e
    );
    assert.equal(err.message, "Registration failed");
  });

  test("a chunk that never had the idiom is returned untouched", () => {
    const clean = "e=>{fetch('/x').then(r=>r.json())}";
    const { source, count, skipped } = fixUnparseableErrorMessages(clean, "unrelated.js");
    assert.equal(source, clean);
    assert.equal(count, 0);
    assert.deepEqual(skipped, []);
  });

  test("a chunk known to carry it is reported if the idiom ever disappears", () => {
    const { count, skipped } = fixUnparseableErrorMessages("e=>{}", "5856812966db7242.js");
    assert.equal(count, 0);
    assert.equal(skipped.length, 1, "silence here would mean the fix stopped applying unnoticed");
  });
});
