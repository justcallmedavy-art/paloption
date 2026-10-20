/**
 * Every patchable chunk, after every pass.
 *
 * WHY THIS SUITE EXISTS. The individual passes each have their own suite, and
 * that was not enough. On 2026-10-18 the sign-in pass rewrote three state-hook
 * declarations with one, and the deployed /login page died with
 * `ReferenceError: w is not defined` — a failure no anchor test could see,
 * because every anchor matched exactly as intended and the result still parsed.
 * What was wrong was that code the chunk needed had stopped existing.
 *
 * So this file checks the whole pipeline over the real bundle, for the two
 * failures that only appear in a browser:
 *
 *   - the patched chunk must still be valid JavaScript;
 *   - it must still declare every hook it declared before. A pass may rewrite a
 *     declaration, but it may not remove one.
 *
 * It is skipped, loudly, when the mirror is not present: `site/` is fetched by
 * `npm run mirror` and is not in every checkout.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PATCHABLE_CHUNKS, patchClientChunk, patchApiBase } from "../tools/client-patches.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIRROR = join(ROOT, "site", "_next", "static", "chunks");

/** Every chunk in the mirror, or an empty list when there is no mirror. */
function mirrorChunks() {
  try {
    return readdirSync(MIRROR).filter((name) => name.endsWith(".js"));
  } catch {
    return [];
  }
}

const chunks = mirrorChunks();

describe("the served bundle survives the patches", () => {
  test("the mirror is present", { skip: chunks.length ? false : "site/ is not present — run `npm run mirror`" }, () => {
    assert.ok(chunks.length > 0);
  });

  for (const name of [...PATCHABLE_CHUNKS].sort()) {
    test(`${name}: parses, and keeps every hook it had`, { skip: chunks.includes(name) ? false : "not in the mirror" }, () => {
      const source = readFileSync(join(MIRROR, name), "utf8");
      const patched = patchClientChunk(name, source);

      // A syntax error here would blank the page for every visitor.
      assert.doesNotThrow(() => new (Function.prototype.constructor)(patched.source), `${name} must still parse`);

      // A hook whose declaration was rewritten away produces a ReferenceError
      // during render instead — which is what "w is not defined" was.
      const hooks = (text) => (text.match(/useState|useRef|useEffect|useMemo|useCallback/g) || []).length;
      assert.equal(hooks(patched.source), hooks(source), `${name} must not lose a hook declaration`);

      // Patching only ever adds code to this bundle; a shorter result means an
      // edit ate something.
      assert.ok(patched.source.length >= source.length, `${name} must not shrink`);

      for (const note of patched.skipped) {
        // Reported, not asserted away: a skipped edit is a fact about the
        // bundle, and it is printed here so a green run cannot hide it.
        console.log(`  [${name}] skipped: ${note}`);
      }
    });
  }

  test("a chunk outside the patchable set is returned byte for byte", () => {
    const name = chunks.find((n) => !PATCHABLE_CHUNKS.has(n));
    if (!name) return;
    const source = readFileSync(join(MIRROR, name), "utf8");
    const patched = patchClientChunk(name, source);
    assert.equal(patched.source, source);
    assert.equal(patched.applied.length, 0);
  });

  test("the API base is only rewritten where the client resolves it", () => {
    for (const name of chunks) {
      const source = readFileSync(join(MIRROR, name), "utf8");
      const { source: patched, count } = patchApiBase(source, "https://api.example");
      if (count === 0) {
        assert.equal(patched, source, `${name}: nothing should change without the URL module`);
      } else {
        // Every occurrence of the module is rewritten together, so a chunk
        // cannot end up with two different API bases.
        assert.equal((patched.match(/https:\/\/api\.example/g) || []).length, count);
      }
    }
  });
});
