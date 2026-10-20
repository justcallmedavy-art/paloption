/**
 * Signing out, and getting back in.
 *
 * WHY THIS SUITE EXISTS. Measured on 2026-10-18 against the deployed site: the
 * frontend was pointed at a temporary API tunnel that had since died, so every
 * sign-in attempt after a sign-out answered with the browser's own words —
 *
 *   catch(e){setError(e.message||"Login failed")}   ->  "Failed to fetch"
 *
 * — which reads exactly like a wrong password or a vanished account. The
 * accounts were all still in the database. Sign-out itself touches nothing on
 * the server; it removes a token from localStorage. These tests pin the two
 * repairs that make that legible: an unreachable API says so and says nothing
 * was changed, and the address that was used comes back pre-filled.
 *
 * They run against the real mirrored chunk when it is present, and against a
 * minimal fixture otherwise, so the pass is checked on the bytes it will
 * actually be applied to.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SIGN_IN_CHUNKS,
  UNREACHABLE_SIGN_IN_MESSAGE,
  isPatchableChunk,
  patchClientChunk,
  patchSignInRecovery,
} from "../tools/client-patches.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIGN_IN_CHUNK = "5595d28ad44d9db8.js";

/** The mirror's own bytes, when the mirror is present. */
function mirrorChunk() {
  try {
    return readFileSync(join(ROOT, "site", "_next", "static", "chunks", SIGN_IN_CHUNK), "utf8");
  } catch {
    return null;
  }
}

/** A miniature of the shape the pass anchors on. */
const FIXTURE =
  'function x(){let[e,x]=(0,r.useState)(""),[b,v]=(0,r.useState)(""),[w,j]=(0,r.useState)(!1);' +
  "let J=async t=>{try{let t=await A(e,b);if(t.requires2FA&&t.tempToken){return}}catch(e){N(e.message||\"Login failed\")}};" +
  '"Can\'t access your authenticator?"}';

const target = () => mirrorChunk() || FIXTURE;

describe("an unreachable API is reported as unreachable", () => {
  test("all three edits land on the sign-in page", () => {
    const result = patchSignInRecovery(target(), SIGN_IN_CHUNK);
    assert.equal(result.count, 3);
    assert.equal(result.skipped.length, 0);
    assert.match(result.applied.join("\n"), /unreachable API reports itself/);
    assert.match(result.applied.join("\n"), /last address used is pre-filled/);
    assert.match(result.applied.join("\n"), /remembers the address/);
  });

  test("the browser's own network wording is replaced, and the account is said to be safe", () => {
    const { source } = patchSignInRecovery(target(), SIGN_IN_CHUNK);
    assert.ok(source.includes(UNREACHABLE_SIGN_IN_MESSAGE));
    assert.match(source, /failed to fetch/i);
    assert.match(source, /nothing was changed/);
  });

  test("the server's own refusal is still shown verbatim", () => {
    const { source } = patchSignInRecovery(target(), SIGN_IN_CHUNK);
    // "Invalid email or password" arrives as JSON from the API and must survive:
    // a wrong password is a different, real answer from an unreachable host.
    assert.match(source, /\(e&&e\.message\)/, "the message is preferred over the fallback");
    assert.match(source, /"Login failed"/, "the original sentence is kept as the last resort");
  });

  test("the address is remembered on success and pre-filled on the next visit", () => {
    const { source } = patchSignInRecovery(target(), SIGN_IN_CHUNK);
    assert.match(source, /localStorage\.setItem\("strategyoption:last-email",e\)/);
    assert.match(source, /localStorage\.getItem\("strategyoption:last-email"\)/);
    assert.ok(
      source.indexOf('getItem("strategyoption:last-email")') < source.indexOf('setItem("strategyoption:last-email"'),
      "the pre-fill is the read, the remember is the write"
    );
  });

  test("no state hook is lost: the password and its visibility flag stay declared", () => {
    // Measured on 2026-10-18, on the deployed page: an earlier version of this
    // pass matched all three declarations and rewrote them with one, so the
    // password input rendered `value:b` against a variable that no longer
    // existed and /login died with "ReferenceError: w is not defined" before a
    // character could be typed. The count of hooks is the honest invariant.
    const before = target();
    const { source } = patchSignInRecovery(before, SIGN_IN_CHUNK);
    const hooks = (s) => (s.match(/useState/g) || []).length;
    assert.equal(hooks(source), hooks(before), "the number of state hooks must not change");
    assert.match(
      source,
      /catch\(_\)\{return ""\}\}\)\(\)\),\[\w+,\w+\]=\(0,\w+\.useState\)\(""\),\[\w+,\w+\]=\(0,\w+\.useState\)\(!1\)/,
      "the password state and the visibility flag must still follow the pre-filled email"
    );
    assert.ok(source.length > before.length, "an edit that shortens the chunk has deleted something");
  });

  test("reading storage cannot break the page when it is unavailable", () => {
    const { source } = patchSignInRecovery(target(), SIGN_IN_CHUNK);
    assert.match(source, /useState\)\(\(function\(\)\{try\{return localStorage\.getItem/);
    assert.match(source, /catch\(_\)\{return ""\}\}/);
  });

  test("it is applied at serve time, on the chunk that carries the form", () => {
    assert.ok(SIGN_IN_CHUNKS.has(SIGN_IN_CHUNK));
    assert.equal(isPatchableChunk(SIGN_IN_CHUNK), true);
    const whole = patchClientChunk(SIGN_IN_CHUNK, target());
    assert.match(whole.applied.join("\n"), /last address used is pre-filled/);
    assert.ok(!whole.skipped.some((note) => note.includes("sign-in:")), whole.skipped.join("; "));
  });

  test("applying it twice is a no-op, not a second rewrite", () => {
    const once = patchSignInRecovery(target(), SIGN_IN_CHUNK).source;
    const twice = patchSignInRecovery(once, SIGN_IN_CHUNK);
    assert.equal(twice.count, 0, "the anchors are gone once the pass has run");
    assert.equal(twice.source, once);
  });

  test("a chunk with no sign-in form is left alone, silently", () => {
    const other = patchSignInRecovery("let a=1;", "219b97e8e5e970d5.js");
    assert.equal(other.count, 0);
    assert.equal(other.skipped.length, 0);
    assert.equal(other.source, "let a=1;");
  });

  test("the chunk that does carry the form reports a lost anchor instead of passing quietly", () => {
    const result = patchSignInRecovery("let a=1;", SIGN_IN_CHUNK);
    assert.equal(result.count, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /no longer looks like it/);
  });
});

describe("the mirrored page, when it is present", () => {
  const source = mirrorChunk();

  test("the pass still matches the real bundle", { skip: source ? false : "site/ mirror is not present" }, () => {
    const result = patchSignInRecovery(source, SIGN_IN_CHUNK);
    assert.equal(result.count, 3, result.skipped.join("; "));
  });

  test("the result is still valid JavaScript", { skip: source ? false : "site/ mirror is not present" }, () => {
    const { source: patched } = patchSignInRecovery(source, SIGN_IN_CHUNK);
    // A syntax error here would take the whole page down, so it is checked with
    // the same parser the browser uses rather than by eye.
    assert.doesNotThrow(() => new (Function.prototype.constructor)(patched));
  });
});
