/**
 * Brand re-colour: the original violet/pink palette -> warm ember + deep blue.
 *
 * The upstream site brands itself violet (#7C3AED) with a pink/fuchsia accent
 * (#EC4899). This module maps that whole colour family onto a new pair:
 *
 *   primary   warm ember  #ff4d2e   (was violet  #7c3aed)
 *   secondary deep blue   #2563eb   (was pink    #ec4899)
 *
 * so a gradient still runs ember -> blue and every lighter/darker step of the
 * old ramps has a matching step on the new ones.
 *
 * Three things make a naive find-and-replace wrong, and all three are handled
 * here:
 *   1. Case. The compiled CSS carries lowercase hexes in declarations but
 *      uppercase ones in selectors that match the uppercase class names in the
 *      markup (`bg-[#7C3AED]`). Case is preserved so a recoloured selector
 *      still matches its recoloured class.
 *   2. Alpha. Values appear as 8-digit hexes (`#7c3aed33`, `#7c3aed0d`). Only
 *      the 6-digit prefix is rewritten; the alpha suffix is left alone.
 *   3. `rgb()`/`rgba()` decimal triples, in each of the three ways they are
 *      written in practice: `rgb(124,58,237)`, `rgba(124, 58, 237, 0.25)` and -
 *      the one Tailwind actually emits for its colour utilities, which is easy
 *      to miss entirely - `rgb(124 58 237/var(--tw-bg-opacity,1))`. The
 *      separator style is read from the source and reproduced, because a
 *      slash-alpha value is only valid in the space-separated form.
 *
 * Everything is a single left-to-right pass over an alternation of the exact
 * source strings, so no replacement can be re-replaced by a later rule.
 */

/* --------------------------- hex remap --------------------------- */

// Purple/violet ramp -> ember ramp (lightest to darkest).
const EMBER = [
  ["#f3e8ff", "#fff1e8"], // purple-50
  ["#ede9fe", "#ffe4d6"], // violet-100
  ["#e9d5ff", "#ffe0d1"], // purple-100
  ["#ddd6fe", "#fed7c3"], // violet-200
  ["#c4b5fd", "#fdba9a"], // violet-300
  ["#d8b4fe", "#ffb59e"], // purple-300
  ["#c084fc", "#ff8f66"], // purple-400
  ["#a78bfa", "#ff8a5c"], // violet-400
  ["#a855f7", "#ff6b3d"], // purple-500
  ["#8b5cf6", "#ff5b30"], // violet-500
  ["#9333ea", "#f24a23"], // purple-600
  ["#7c3aed", "#ff4d2e"], // violet-600  <- the brand colour
  ["#7e22ce", "#d93a17"], // purple-700
  ["#6d28d9", "#c93518"], // violet-700
  ["#5b21b6", "#a52c12"], // violet-800
  ["#581c87", "#8f2a10"], // purple-900
  ["#4c1d95", "#7a2412"], // violet-900
  ["#9b6cf6", "#ff7a52"], // bespoke light violet (pairs with #7c75ff below)
];

// Pink/fuchsia ramp -> blue ramp (lightest to darkest).
const BLUE = [
  ["#fdf4ff", "#eff6ff"], // fuchsia-50
  ["#faf5ff", "#eff6ff"], // purple-50
  ["#f5f3ff", "#eff6ff"], // violet-50
  ["#fae8ff", "#dbeafe"], // fuchsia-100
  ["#fce7f3", "#dbeafe"], // pink-100
  ["#f0abfc", "#93c5fd"], // fuchsia-300
  ["#f5d0fe", "#bfdbfe"], // fuchsia-200
  ["#f9a8d4", "#93c5fd"], // pink-300
  ["#e879f9", "#60a5fa"], // fuchsia-400
  ["#f472b6", "#60a5fa"], // pink-400
  ["#d946ef", "#3b82f6"], // fuchsia-500
  ["#7c75ff", "#3b82f6"], // bespoke periwinkle (gradient partner of #9b6cf6)
  ["#6b63ff", "#2563eb"], // bespoke periwinkle, darker step
  ["#c026d3", "#2563eb"], // fuchsia-600
  ["#ec4899", "#2563eb"], // pink-500    <- the accent colour
  ["#a21caf", "#1d4ed8"], // fuchsia-700
  ["#db2777", "#1d4ed8"], // pink-600
  ["#be185d", "#1e40af"], // pink-700
];

// Surfaces. These are near-black greys with a violet cast, so leaving them
// would keep the whole dark theme looking purple no matter what the accents do.
// They move to a neutral, faintly cool charcoal that sits well under both the
// ember and the blue; the light-theme greys lose their violet cast too.
const SURFACE = [
  ["#141021", "#101520"], // app background
  ["#1f1936", "#1a2130"], // card
  ["#1b1630", "#161d2b"], // panel
  ["#120d20", "#0d111a"], // deep
  ["#17102b", "#121926"], // raised
  ["#16121f", "#141922"], // another violety black
  ["#181329", "#151b28"], // input / muted surface
  ["#282041", "#212a3a"], // raised card step
  ["#2e2447", "#26303f"], // hovered card step
  ["#56506b", "#4b5563"], // muted text (violet grey)
  ["#faf8fc", "#f8fafc"], // light page
  ["#f2eff7", "#f1f5f9"], // light deep
  ["#f6f5fb", "#f5f7fa"], // light body
];

// Deliberately NOT remapped: #9945ff is Solana's own brand mark (the SOL
// ticker badge and the SOL asset colour). It is a third-party logo, not the
// site's theme, so recolouring it would misrepresent the asset.

export const PALETTE = [...EMBER, ...BLUE, ...SURFACE];

/* ------------------------ rgb() decimal remap ------------------------ */

const triple = (sixHex) => {
  const n = parseInt(sixHex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].join(",");
};

/** "124,58,237" -> "255,77,46" for every mapped colour. */
const RGB_TRIPLES = new Map(PALETTE.map(([from, to]) => [triple(from), triple(to)]));

/* --------------------------- the pass --------------------------- */

const HEX_MAP = new Map(PALETTE.map(([from, to]) => [from, to]));
const HEX_KEYS = PALETTE.map(([from]) => from);
const HEX_RE = new RegExp(`(?:${HEX_KEYS.join("|")})`, "gi");
// Either separator, captured so the same one can be written back. The comma
// branch is tried first so "124, 58, 237" keeps its comma-and-space shape.
const RGB_RE = /(?<=rgba?\()(\d{1,3})(\s*,\s*|\s+)(\d{1,3})(\s*,\s*|\s+)(\d{1,3})/g;

/**
 * Rewrite every occurrence of the old brand family. Returns the text unchanged
 * (and reports zero edits) when there is nothing to do, so callers can cheaply
 * detect a file that does not carry the palette at all.
 */
export function recolor(text) {
  if (typeof text !== "string" || text === "") return { text, edits: 0 };
  let edits = 0;

  // Hex. Case is preserved: a selector typed in uppercase stays uppercase so it
  // keeps matching the equally-uppercase class name in the markup.
  let out = text.replace(HEX_RE, (match) => {
    const next = HEX_MAP.get(match.toLowerCase());
    if (!next) return match;
    edits += 1;
    return match === match.toUpperCase() ? next.toUpperCase() : next;
  });

  // rgb()/rgba() triples, in every separator style, preserving which was used.
  out = out.replace(RGB_RE, (match, r, sep1, g, sep2, b) => {
    const next = RGB_TRIPLES.get(`${r},${g},${b}`);
    if (!next) return match;
    edits += 1;
    const [nr, ng, nb] = next.split(",");
    return `${nr}${sep1}${ng}${sep2}${nb}`;
  });

  return { text: out, edits };
}

/** File extensions whose contents can carry the palette. */
export const RECOLORABLE_EXTS = new Set([".css", ".html", ".htm", ".js", ".mjs", ".json", ".svg"]);
