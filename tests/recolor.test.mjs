/**
 * Brand re-colour tests.
 *
 * These lock the two things that are easy to get wrong and expensive to miss:
 * a hex swap that silently misses its case-variant or its `rgb()` spelling, and
 * a pixel pass that quietly tints the badge green or eats the white glyph.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { recolor } from "../tools/palette.mjs";
import { recolorIcon, decodePng } from "../tools/icon-recolor.mjs";

/* ------------------------------ helpers ------------------------------ */

function hsv(r, g, b) {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    const rr = r / 255;
    const gg = g / 255;
    const bb = b / 255;
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max];
}

function bands({ width, height, rgba }) {
  const out = { violet: 0, rose: 0, green: 0, warm: 0, blue: 0, neutral: 0, total: 0 };
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 40) continue;
    out.total += 1;
    const [h, s] = hsv(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (s < 0.12) out.neutral += 1;
    else if (h >= 255 && h < 305) out.violet += 1;
    else if (h >= 305 && h < 345) out.rose += 1;
    else if (h >= 60 && h < 165) out.green += 1;
    else if (h < 70 || h >= 345) out.warm += 1;
    else out.blue += 1;
  }
  return out;
}

/* ------------------------------ text pass ------------------------------ */

describe("palette", () => {
  test("maps the brand pair and keeps the gradient two-toned", () => {
    const { text } = recolor("a{color:#7c3aed}b{color:#ec4899}");
    assert.match(text, /#ff4d2e/);
    assert.match(text, /#2563eb/);
    assert.doesNotMatch(text, /#7c3aed|#ec4899/);
  });

  test("case is preserved, so a recoloured selector still matches its class", () => {
    // The compiled CSS carries lowercase hexes in declarations but uppercase
    // ones in the escaped selectors that match uppercase class names in markup.
    // Both spellings must survive as themselves or the rules stop applying.
    const { text } = recolor(".bg-\\[\\#7C3AED\\]{background:#7c3aed}");
    assert.equal((text.match(/#FF4D2E/g) || []).length, 1, "the selector stays uppercase");
    assert.equal((text.match(/#ff4d2e/g) || []).length, 1, "the declaration stays lowercase");
    assert.equal((text.match(/#7C3AED|#7c3aed/g) || []).length, 0, "no old value survives in either case");

    // And the pair still agree after the swap: the escaped selector must be the
    // escaped form of the recoloured class name, exactly as Tailwind emits it.
    const markup = recolor('class="bg-[#7C3AED]"').text;
    assert.equal(markup, 'class="bg-[#FF4D2E]"');
    assert.ok(text.includes(".bg-\\[\\#FF4D2E\\]"), "the escaped selector must target the new class");
  });

  test("an alpha suffix rides along with the hex it belongs to", () => {
    assert.equal(recolor("#7c3aed33").text, "#ff4d2e33");
    assert.equal(recolor("#7C3AED0d").text, "#FF4D2E0d");
  });

  test("rgb()/rgba() triples are the same colours spelled differently", () => {
    assert.equal(recolor("rgba(124,58,237,0.25)").text, "rgba(255,77,46,0.25)");
    // Separator style is preserved, so a pretty-printed value stays pretty.
    assert.equal(recolor("rgba(124, 58, 237, 0.08)").text, "rgba(255, 77, 46, 0.08)");
    assert.equal(recolor("rgb(236,72,153)").text, "rgb(37,99,235)");
  });

  test("the space-separated form Tailwind emits is handled and stays space-separated", () => {
    // This is the one that matters most and is easiest to miss: the compiled CSS
    // writes its colour utilities as rgb(R G B/var(--tw-*-opacity,1)), not as
    // hex and not with commas. A comma-only rule leaves every one of them violet.
    const css = ".bg-purple-500{--tw-bg-opacity:1;background-color:rgb(168 85 247/var(--tw-bg-opacity,1))}";
    const { text, edits } = recolor(css);
    assert.equal(edits, 1);
    assert.ok(text.includes("rgb(255 107 61/var(--tw-bg-opacity,1))"), text);
    assert.doesNotMatch(text, /168 85 247/, "the old channel values must be gone");

    // A slash-alpha value is only valid space-separated, so the separator style
    // has to come back the way it went in.
    assert.equal(recolor("rgb(236 72 153)").text, "rgb(37 99 235)");
    assert.equal(recolor("rgb(236,72,153)").text, "rgb(37,99,235)");
  });

  test("surfaces lose their violet cast, not just the accents", () => {
    const { text } = recolor("bg:#141021;card:#1f1936;panel:#1b1630;deep:#120d20");
    assert.doesNotMatch(text, /#141021|#1f1936|#1b1630|#120d20/);
  });

  test("is idempotent — no replacement is itself a source string", () => {
    const once = recolor("x:#7c3aed y:#ec4899 z:#141021").text;
    const twice = recolor(once);
    assert.equal(twice.text, once, "a second pass must change nothing");
    assert.equal(twice.edits, 0);
  });

  test("leaves colours that are not the brand alone", () => {
    // #9945ff is Solana's mark; #22c55e is a success green; #0a0f1a a neutral.
    const source = "sol:#9945ff ok:#22c55e bg:#0a0f1a w:#ffffff";
    assert.equal(recolor(source).text, source);
    assert.equal(recolor(source).edits, 0);
  });

  test("reports how much it changed so callers can detect a clean file", () => {
    assert.equal(recolor("nothing here").edits, 0);
    assert.equal(recolor("#7c3aed #7c3aed").edits, 2);
  });
});

/* ------------------------------ pixel pass ------------------------------ */

describe("icon recolour", () => {
  const hasIcons = existsSync("site/icon.png") && existsSync("site/favicon.ico");

  test("repaints the badge without tinting it green or eating the white glyph", { skip: !hasIcons }, async () => {
    const source = await readFile("site/icon.png");
    const before = decodePng(source);
    assert.ok(before, "the fixture must be a PNG we can decode");

    const { buffer, changed } = recolorIcon(source);
    assert.ok(changed > 0, "the violet badge must produce work to do");

    const after = decodePng(buffer);
    assert.ok(after, "the output must still be a readable PNG");
    assert.equal(after.width, before.width);
    assert.equal(after.height, before.height);

    // Alpha is untouched, so the transparent corners and the badge's edge stay.
    for (let i = 3; i < before.rgba.length; i += 4) {
      assert.equal(after.rgba[i], before.rgba[i], `alpha at byte ${i} must not change`);
    }

    const b = bands(before);
    const a = bands(after);
    assert.ok(b.violet > b.total * 0.4, `the fixture should start violet, saw ${b.violet}/${b.total}`);
    assert.equal(a.green, 0, "a red-to-blue blend must not pass through green");
    assert.ok(
      a.violet < b.violet * 0.2,
      `violet must be mostly gone: ${b.violet} -> ${a.violet}`
    );
    assert.ok(a.warm > a.total * 0.4, `the badge should read warm, saw ${a.warm}/${a.total}`);

    // The glyph is neutral, so the neutral count is a proxy for it surviving.
    assert.equal(a.neutral, b.neutral, "the white glyph must be preserved exactly");
  });

  test("an already-recoloured mark is reported as having nothing to do", { skip: !hasIcons }, async () => {
    // Only the violet band is drained; the pass is deliberately not a fixed
    // point, which is why tools/recolor.mjs regenerates from the pristine copy.
    const source = await readFile("site/icon.png");
    const once = recolorIcon(source).buffer;
    const second = recolorIcon(once);
    assert.ok(second.changed < recolorIcon(source).changed * 0.3, "the bulk of the work is done");
  });

  test("handles the PNG payload inside the .ico container", { skip: !hasIcons }, async () => {
    const { buffer, changed, note } = recolorIcon(await readFile("site/favicon.ico"));
    assert.ok(changed > 0);
    assert.match(note, /ico/);
    assert.equal(buffer.readUInt16LE(0), 0, "reserved");
    assert.equal(buffer.readUInt16LE(2), 1, "type: icon");
    const count = buffer.readUInt16LE(4);
    assert.equal(count, 1);

    const size = buffer.readUInt32LE(14);
    const offset = buffer.readUInt32LE(18);
    assert.equal(offset, 22, "one entry, so the payload starts right after the directory");
    assert.equal(offset + size, buffer.length, "the declared size must match the file");

    const payload = buffer.subarray(offset, offset + size);
    assert.ok(decodePng(payload), "the repacked payload must be a readable PNG");
  });

  test("leaves a file it does not understand untouched", () => {
    const junk = Buffer.from("not an image at all, definitely not");
    const { buffer, changed } = recolorIcon(junk);
    assert.equal(changed, 0);
    assert.equal(buffer, junk, "the very same buffer must come back");
  });
});
