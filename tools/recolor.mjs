/**
 * Apply the brand re-colour to the hand-written clone in the repo root.
 *
 * The mirror (`site/`) is re-coloured at serve time, so its copy on disk stays
 * faithful. This script is for the other artefact — the standalone rebuild of
 * index/login/register/trade that `npm run serve` hands out unchanged — whose
 * files are edited in place because nothing regenerates them.
 *
 * Idempotent: run it twice and the second run reports zero edits, because the
 * source colours are gone. Run it after editing a page by hand.
 *
 * Usage: node tools/recolor.mjs [--check]
 *   --check   report what would change without writing anything (exit 1 if any
 *             file still carries the old palette)
 */
import { readFile, writeFile } from "node:fs/promises";
import { recolor } from "./palette.mjs";
import { recolorIcon } from "./icon-recolor.mjs";

const TARGETS = [
  "index.html",
  "login.html",
  "register.html",
  "trade.html",
  "manifest.json",
  "src/input.css",
  "js/app.js",
  "js/login.js",
];

// Raster marks: these need a pixel pass, not the text pass.
//
// The pixel pass reads a pixel's own colour to decide what it becomes, so it is
// NOT a fixed point: running it on its own output walks the transition pixels
// further along. Left alone that would let a second run drift the icon.
//
// So each mark is always regenerated from the pristine upstream copy in the
// mirror rather than from whatever currently sits in the rebuild. That makes the
// result a pure function of the upstream file — byte-identical on every run, and
// a no-op once it has been applied.
const ICONS = [
  "favicon.ico",
  "icon.png",
  "apple-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

const pristinePath = (path) => `site/${path}`;

const check = process.argv.includes("--check");
let totalEdits = 0;
let dirty = 0;

for (const path of TARGETS) {
  let original;
  try {
    original = await readFile(path, "utf8");
  } catch {
    console.log(`skip   ${path} (not present)`);
    continue;
  }

  const { text, edits } = recolor(original);
  totalEdits += edits;
  if (edits) dirty += 1;

  if (!edits) {
    console.log(`clean  ${path}`);
    continue;
  }

  if (check) {
    console.log(`DIRTY  ${path}: ${edits} colour value(s) still on the old palette`);
    continue;
  }

  await writeFile(path, text);
  console.log(`ok     ${path}: ${edits} colour value(s) remapped`);
}

for (const path of ICONS) {
  const source = pristinePath(path);
  let original;
  try {
    original = await readFile(source);
  } catch {
    console.log(`skip   ${path} (no pristine source at ${source})`);
    continue;
  }

  const { buffer, changed, note } = recolorIcon(original);
  if (!changed) {
    console.log(`skip   ${path} (${source} carries no brand pixels)`);
    continue;
  }
  let current = null;
  try {
    current = await readFile(path);
  } catch {
    /* not written yet */
  }

  if (current && current.equals(buffer)) {
    console.log(`clean  ${path} (matches ${source} recoloured)`);
    continue;
  }

  totalEdits += changed;
  dirty += 1;
  if (check) {
    console.log(`DIRTY  ${path}: does not match ${source} recoloured (${note})`);
    continue;
  }

  await writeFile(path, buffer);
  console.log(`ok     ${path}: ${changed} px repainted from ${source} (${note})`);
}

console.log(`\n${dirty} file(s) with edits, ${totalEdits} remapped value(s)/pixel(s) total`);

if (check && dirty) process.exit(1);
