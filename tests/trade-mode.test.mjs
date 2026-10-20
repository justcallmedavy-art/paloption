/**
 * Even/Odd trade-mode tests.
 *
 * The defect: the trade panel initialises its mode state to "auto", and in that
 * mode the Even/Odd buttons post `auto_trading_start` instead of `manual_trade`.
 * A single click therefore started a martingale bot which kept opening positions
 * on its own until STOP, the MANUAL toggle, or a target stopped it. Nothing on
 * screen said so — the buttons are labelled with a payout, which reads as a
 * single bet.
 *
 * The fix defaults that one piece of state to "manual" at serve time, so one
 * click places one trade and the bot needs a deliberate AUTO. These tests pin
 * three things that are each easy to get wrong:
 *
 *   - that it really fires on the mirrored bundle, for BOTH panels (the desktop
 *     and mobile trade panels are separate components with separate state),
 *   - that it changes nothing else in a 600 kB minified chunk — a rewrite that
 *     silently clobbers a byte outside the anchor is the failure mode that
 *     matters here,
 *   - that it stays inert where it does not belong, reporting the skip rather
 *     than guessing, so a future bundle cannot make it rewrite unrelated state.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  fixTradeModeDefault,
  patchClientChunk,
  isPatchableChunk,
  PATCHABLE_CHUNKS,
} from "../tools/client-patches.mjs";

const run = promisify(execFile);

/** The chunk that carries both trade panels. Discovered, not hardcoded: a
 * re-mirror may rename it, and a test that then finds nothing must fail loudly. */
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function findPanelChunks() {
  const hits = [];
  for await (const file of walk("site")) {
    if (!file.endsWith(".js")) continue;
    const source = await readFile(file, "utf8");
    if (source.includes('useState)("auto")')) hits.push({ file, source });
  }
  return hits;
}

/**
 * A stand-in for a trade panel. The identifiers are the shape the minifier
 * emits, not the real ones, because a real build renames every one of them and
 * an anchor that only matches today's names would rot silently.
 */
function panel({ state, setter, hook = true, compared = true }) {
  const destructure = hook
    ? `let{startAutoTrading:n,placeManualTrade:i,stopAutoTrading:r}=e,`
    : `let n=e,`;
  const compare = compared
    ? `"auto"===${state}?n:i,"manual"===${state}`
    : `void 0`;
  return `function eL(){let e=eA(),${destructure}[${state},${setter}]=(0,s.useState)("auto");return ${compare}}`;
}

describe("the Even/Odd buttons place one trade, not a bot", () => {
  test("defaults both mirrored trade panels to manual", async () => {
    const chunks = await findPanelChunks();
    assert.ok(chunks.length, "no chunk carries a useState(\"auto\") state at all");

    let applied = 0;
    for (const { file, source } of chunks) {
      const result = fixTradeModeDefault(source);
      applied += result.applied.length;
      assert.deepEqual(result.skipped, [], `${file}: unexpected skips`);
      // The desktop panel (D) and the mobile panel (eu) are separate states in
      // the same chunk. Both must move, or one of them still starts a bot.
      assert.equal(result.source.includes('useState)("auto")'), false, `${file}: an auto default survived`);
      assert.equal(result.applied.length, (source.match(/useState\)\("auto"\)/g) || []).length);
    }

    // Two panels today; a build with a third would still pass, a build with
    // none would not.
    assert.ok(applied >= 2, `expected both panels to be fixed, applied ${applied}`);
  });

  test("defaults the state in the chunk the server actually patches", async () => {
    const chunks = await findPanelChunks();
    const patchable = chunks.filter((c) => isPatchableChunk(c.file.split(/[\\/]/).pop()));
    assert.ok(
      patchable.length,
      `no chunk containing a trade panel is in PATCHABLE_CHUNKS ` +
        `(${[...PATCHABLE_CHUNKS].join(", ")}) — the fix would never reach the browser`
    );
  });

  test("changes nothing but the two defaults in a 600 kB chunk", async () => {
    const [chunk] = await findPanelChunks();
    assert.ok(chunk, "the trade-panel chunk has moved");
    const original = chunk.source;
    const { source } = fixTradeModeDefault(original);

    // The patched chunk must be exactly the original with each `"auto"` default
    // replaced by `"manual"` — no byte gained, lost, or moved anywhere else.
    const expected = original.replace(/useState\)\("auto"\)/g, 'useState)("manual")');
    assert.equal(source, expected);
    // "auto" -> "manual" is two bytes longer, once per panel.
    const panels = (original.match(/useState\)\("auto"\)/g) || []).length;
    assert.equal(source.length, original.length + 2 * panels);
  });

  test("the patched chunk still parses", async () => {
    const [chunk] = await findPanelChunks();
    const { source } = patchClientChunk(chunk.file.split(/[\\/]/).pop(), chunk.source);
    const dir = await mkdtemp(join(tmpdir(), "strategyoption-mode-"));
    try {
      const file = join(dir, "chunk.mjs");
      await writeFile(file, source);
      await run(process.execPath, ["--check", file]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the fix is wired into the shared patch pass", async () => {
    const [chunk] = await findPanelChunks();
    const result = patchClientChunk(chunk.file.split(/[\\/]/).pop(), chunk.source);
    assert.ok(
      result.applied.some((note) => note.includes("trade mode")),
      `patchClientChunk did not run the trade-mode pass: ${JSON.stringify(result.applied)}`
    );
  });

  test("a mode state that is not a trade panel is left alone", () => {
    // Same `useState("auto")`, but no trading hook in the enclosing component.
    const source = `<unrelated/>,[x,y]=(0,s.useState)("auto");"auto"===x;"manual"===x;`;
    const result = fixTradeModeDefault(source);
    assert.equal(result.source, source, "an unrelated auto state was rewritten");
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /expected a trade panel state/);
  });

  test("a trade panel whose state is not the mode selector is left alone", () => {
    // Has the hook, but this state is never compared against the mode strings,
    // so it is a different piece of state that merely defaults to "auto".
    const source = panel({ state: "x", setter: "y", compared: false });
    const result = fixTradeModeDefault(source);
    assert.equal(result.source, source);
    assert.equal(result.applied.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0], /compared against both modes=false/);
  });

  test("both panels of a chunk are fixed, and only the mode states", () => {
    const source = panel({ state: "D", setter: "A" }) + panel({ state: "eu", setter: "eh" });
    const result = fixTradeModeDefault(source);
    assert.equal(result.applied.length, 2);
    assert.ok(result.source.includes('useState)("manual")'));
    assert.equal(result.source.includes('useState)("auto")'), false);
  });

  test("the browser is served the fix, not the untouched chunk", async (t) => {
    // The unit tests above prove the pass works. This proves it is on the path
    // the browser takes: the served chunk must carry the MANUAL default, and
    // the unpatched bytes must still be what `site/` holds.
    const child = spawn(process.execPath, ["tools/server.mjs", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: "0" },
    });
    t.after(() => child.kill());
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

    const [chunk] = await findPanelChunks();
    const name = chunk.file.split(/[\\/]/).pop();
    const res = await fetch(`http://127.0.0.1:${port}/_next/static/chunks/${name}`);
    assert.equal(res.status, 200);
    const served = await res.text();
    assert.equal((served.match(/useState\)\("auto"\)/g) || []).length, 0, "an auto default reached the browser");
    assert.equal((served.match(/useState\)\("manual"\)/g) || []).length, 2, "both panels must reach the browser as manual");
    assert.ok(
      chunk.source.includes('useState)("auto")'),
      "the mirrored file on disk must stay untouched — the fix is serve-time only"
    );
  });

  test("PATCH_CLIENT=0 is the A/B switch and disables the fix", () => {
    const saved = process.env.PATCH_CLIENT;
    try {
      process.env.PATCH_CLIENT = "0";
      assert.equal(isPatchableChunk("219b97e8e5e970d5.js"), false);
    } finally {
      if (saved === undefined) delete process.env.PATCH_CLIENT;
      else process.env.PATCH_CLIENT = saved;
    }
  });
});
