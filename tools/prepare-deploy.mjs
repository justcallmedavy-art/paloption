/**
 * Build the static deployment snapshot for Vercel.
 *
 * `tools/server.mjs` re-colours the mirror and patches the client bundle on the
 * way out, which is why `site/` stays a faithful copy of upstream. A static host
 * has no such hook: whatever sits in the upload directory is what the browser
 * gets. This script performs exactly the same two passes over a snapshot it
 * builds from the pristine sources.
 *
 * Two artefacts, one origin each:
 *   - the app shell, copied from the mirror `site/`
 *   - the landing page, overlaid at `/landing` from the hand-built clone in the
 *     repo root, so the snapshot needs a rewrite rule that gives it a trailing
 *     slash (its assets are relative)
 *
 * Because every byte comes from a pristine source, the output is a pure function
 * of `site/` plus the repo-root landing files: running it twice writes the same
 * bytes. That matters for the raster brand marks in particular, whose pixel pass
 * is not a fixed point and would drift if it read its own output.
 *
 * Usage: node tools/prepare-deploy.mjs [--out deploy/paloption] [--check]
 *   --check   build to a temporary directory and report any difference against
 *             the existing snapshot, writing nothing (exit 1 if it differs)
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { recolor } from "./palette.mjs";
import { recolorIcon } from "./icon-recolor.mjs";
import {
  isPatchableChunk,
  isRecolorable,
  isRecolorableImage,
  patchApiBase,
  patchClientChunk,
  fixUnparseableErrorMessages,
  apiBaseFromEnv,
} from "./client-patches.mjs";

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const outFlag = argv.indexOf("--out");
const outArg = outFlag === -1 ? "deploy/paloption" : argv[outFlag + 1];
if (!outArg || outArg === "--check") {
  console.error("usage: node tools/prepare-deploy.mjs [--out <dir>] [--check]");
  process.exit(2);
}
const outDir = resolve(outArg);

const MIRROR = resolve("site");
const apiBase = apiBaseFromEnv();

/** The landing page's files, and where each comes from. */
const LANDING = [
  ["index.html", "landing/index.html"],
  ["manifest.json", "landing/manifest.json"],
  ["dist/styles.css", "landing/dist/styles.css"],
  ["js/app.js", "landing/js/app.js"],
  ["js/login.js", "landing/js/login.js"],
  ["js/main.js", "landing/js/main.js"],
  ["js/register.js", "landing/js/register.js"],
  // The landing page's own favicon/icons are the mirror's, re-coloured the same way.
  ["site/favicon.ico", "landing/favicon.ico"],
  ["site/icon.png", "landing/icon.png"],
  ["site/icons/icon-192.png", "landing/icons/icon-192.png"],
  ["site/icons/icon-512.png", "landing/icons/icon-512.png"],
];

const VERCEL_JSON = `${JSON.stringify(
  {
    $schema: "https://openapi.vercel.sh/vercel.json",
    redirects: [{ source: "/landing", destination: "/landing/", permanent: false }],
  },
  null,
  2
)}\n`;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

/** The serve-time transform: re-colour first, then the client patches. */
async function transform(absSource, outRel) {
  const name = basename(outRel);
  const ext = extname(outRel);

  if (isRecolorableImage(ext)) {
    const { buffer, changed, note } = recolorIcon(await readFile(absSource));
    if (!changed) return readFile(absSource);
    return { buffer, note };
  }

  const patchable = isPatchableChunk(name);
  const apiPatchable = ext === ".js";
  if (!isRecolorable(ext) && !patchable && !apiPatchable) return readFile(absSource);

  let source = await readFile(absSource, "utf8");
  let edits = 0;
  if (isRecolorable(ext)) {
    const result = recolor(source);
    source = result.text;
    edits = result.edits;
  }
  const applied = [];
  const skipped = [];
  if (patchable) {
    const patched = patchClientChunk(name, source);
    source = patched.source;
    applied.push(...patched.applied);
    skipped.push(...patched.skipped);
  }
  // Points the frontend at the API host. With PALOPTION_API_URL unset the client
  // stays same-origin, which is what a single-host deployment wants.
  let apiEdits = 0;
  if (apiPatchable) {
    const patched = patchApiBase(source, apiBaseFromEnv());
    source = patched.source;
    apiEdits = patched.count;
  }
  // Makes the client's own "…failed" fallback reachable, so a frontend served
  // without its API reports that instead of the browser's JSON parse error.
  let errorEdits = 0;
  if (apiPatchable) {
    const patched = fixUnparseableErrorMessages(source, name);
    source = patched.source;
    errorEdits = patched.count;
    skipped.push(...patched.skipped);
  }
  return { buffer: Buffer.from(source), edits, applied, skipped, apiEdits, errorEdits };
}

const staging = join(tmpdir(), `paloption-snapshot-${process.pid}`);
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

let files = 0;
let totalColourEdits = 0;
let totalPatchEdits = 0;
let totalRepainted = 0;
let totalApiEdits = 0;

async function emit(absSource, outRel) {
  const result = await transform(absSource, outRel);
  const dest = join(staging, outRel);
  await mkdir(dirname(dest), { recursive: true });
  if (Buffer.isBuffer(result)) {
    await writeFile(dest, result);
  } else {
    await writeFile(dest, result.buffer);
    totalColourEdits += result.edits ?? 0;
    totalPatchEdits += (result.applied ?? []).length;
    totalApiEdits += result.apiEdits ?? 0;
    if (result.note) totalRepainted += 1;
    for (const note of result.skipped ?? []) console.warn(`[client-patch] SKIPPED ${outRel}: ${note}`);
  }
  files += 1;
}

for await (const file of walk(MIRROR)) {
  // The project's own credentials and dev files never belong in a snapshot.
  if (basename(file).startsWith(".env")) continue;
  await emit(file, relative(MIRROR, file));
}

for (const [from, to] of LANDING) {
  const abs = resolve(from);
  try {
    await stat(abs);
  } catch {
    // `dist/` is generated and gitignored, so on a fresh clone the stylesheet
    // the landing page embeds does not exist yet and the fix is a build rather
    // than a fixture. Naming the build here turns a bare missing-file error into
    // the one command that resolves it.
    const hint = from.startsWith("dist/") ? " — run `npm run build` to compile it" : "";
    throw new Error(`landing source is missing: ${from}${hint}`);
  }
  await emit(abs, to);
}

await writeFile(join(staging, "vercel.json"), VERCEL_JSON);
files += 1;

const summary = `${files} file(s), ${totalColourEdits} colour value(s) remapped, ${totalPatchEdits} client edit(s), ${totalRepainted} mark(s) repainted, API base -> ${apiBase || "same-origin"} in ${totalApiEdits} chunk(s)`;

if (check) {
  const diffs = [];
  const wanted = new Set();
  for await (const file of walk(staging)) wanted.add(relative(staging, file).split("\\").join("/"));
  for (const rel of wanted) {
    try {
      const [a, b] = await Promise.all([readFile(join(staging, rel)), readFile(join(outDir, rel))]);
      if (!a.equals(b)) diffs.push(`differs  ${rel}`);
    } catch {
      diffs.push(`missing  ${rel}`);
    }
  }
  for await (const file of walk(outDir)) {
    const rel = relative(outDir, file).split("\\").join("/");
    if (rel.startsWith(".vercel/")) continue;
    if (!wanted.has(rel)) diffs.push(`stale    ${rel}`);
  }
  await rm(staging, { recursive: true, force: true });
  for (const line of diffs) console.log(line);
  console.log(diffs.length ? `out of date: ${summary}` : `up to date: ${summary}`);
  process.exit(diffs.length ? 1 : 0);
}

// Replace the snapshot, keeping the CLI's project link so the deployment target
// is unchanged. Anything not produced above is removed, so a stale file cannot
// survive into an upload.
await mkdir(outDir, { recursive: true });
for (const entry of await readdir(outDir, { withFileTypes: true })) {
  if (entry.name === ".vercel") continue;
  await rm(join(outDir, entry.name), { recursive: true, force: true });
}
await mkdir(outDir, { recursive: true });
await cp(staging, outDir, { recursive: true });
await rm(staging, { recursive: true, force: true });

console.log(`wrote ${outDir}: ${summary}`);
