/**
 * Mirror paloptions.com into ./site, preserving the original URL paths so that
 * absolute references like /_next/static/chunks/x.js keep working offline.
 *
 * Usage:  node tools/mirror.mjs
 *
 * Notes:
 *  - Only same-origin assets are downloaded. Google Fonts (fonts.googleapis.com
 *    / fonts.gstatic.com) stay external, exactly as the original loads them.
 *  - The production API origin is rewritten to an empty string so this local
 *    copy never talks to their live backend. See REWRITES below.
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const ORIGIN = "https://paloptions.com";
const OUT = "site";

/* Route -> where it lands on disk (directory index so /register/ resolves). */
const ROUTES = {
  "/": "index.html",
  "/register": "register/index.html",
  "/login": "login/index.html",
  "/forgot-password": "forgot-password/index.html",
  "/trade": "trade/index.html",
  "/download": "download/index.html",
  "/cashier": "cashier/index.html",
  "/referrals": "referrals/index.html",
  "/responsible-trading": "responsible-trading/index.html",
  "/settings": "settings/index.html",
  "/settings/profile": "settings/profile/index.html",
  "/settings/password": "settings/password/index.html",
  "/settings/2fa": "settings/2fa/index.html",
  "/settings/verify": "settings/verify/index.html",
  "/admin": "admin/index.html",
  "/admin/login": "admin/login/index.html",
  "/admin/dashboard": "admin/dashboard/index.html",
};

/* Replacements applied to downloaded JavaScript.
   The clone must not reach the real production API or websocket. */
const REWRITES = [
  ["https://api.paloption.com", ""],
];

const downloaded = new Map(); // url -> local path
const queue = [];
const failures = [];
const skipped = [];

function toUrl(ref, base) {
  try {
    return new URL(ref, base).href;
  } catch {
    return null;
  }
}

function localPathFor(url) {
  const u = new URL(url);
  let path = decodeURIComponent(u.pathname);

  // The mirror root is not part of the origin's URL space. A reference whose
  // path contains a `site/` segment would otherwise be joined onto OUT a second
  // time, writing a whole duplicate copy *inside* the mirror — which is how a
  // nested site/_next/static/chunks/site/ tree appeared. Refuse it.
  const root = OUT.replace(/^\.\//, "").replace(/\/+$/, "");
  if (path.split("/").includes(root)) return null;

  if (ROUTES[path]) return join(OUT, ROUTES[path]);
  if (path.endsWith("/")) path += "index.html";
  return join(OUT, path.replace(/^\//, ""));
}

function enqueue(url) {
  if (!url || downloaded.has(url) || queue.includes(url)) return;
  const u = new URL(url);
  if (u.origin !== ORIGIN) return; // leave external hosts alone
  queue.push(url);
}

/* Pull every same-origin reference out of a text asset. */
function extractRefs(text, base) {
  const refs = new Set();

  // href/src/action attributes
  for (const m of text.matchAll(/(?:href|src|action)="([^"#]+)"/g)) refs.add(m[1]);
  // absolute paths used inside the RSC payload and JS strings
  for (const m of text.matchAll(/["'`](\/(?:_next|icons)\/[A-Za-z0-9._/-]+\.(?:js|css|png|woff2?))["'`]/g)) refs.add(m[1]);
  // bare /_next paths anywhere (covers escaped \"/_next/...\" in inline scripts)
  for (const m of text.matchAll(/(\/_next\/static\/[A-Za-z0-9._/-]+\.(?:js|css|png|ico|woff2?))/g)) refs.add(m[1]);
  // url(...) in CSS
  for (const m of text.matchAll(/url\((?:["']?)([^"')]+)(?:["']?)\)/g)) refs.add(m[1]);

  for (const r of refs) {
    if (r.startsWith("data:") || r.startsWith("http://") || r.startsWith("https://") || r.startsWith("//")) continue;
    enqueue(toUrl(r, base));
  }
}

async function fetchTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await mkdir(dirname(dest), { recursive: true });

  const type = res.headers.get("content-type") || "";
  const isText = /text|javascript|json|xml|svg/.test(type) || /\.(js|css|json|html|svg)$/.test(dest);

  if (!isText) {
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    return { bytes: Buffer.byteLength(await readFile(dest)), type };
  }

  let text = await res.text();
  let rewrites = 0;
  if (/\.js$/.test(dest)) {
    for (const [from, to] of REWRITES) {
      if (text.includes(from)) {
        rewrites += text.split(from).length - 1;
        text = text.split(from).join(to);
      }
    }
  }
  await writeFile(dest, text);
  extractRefs(text, url);
  return { bytes: Buffer.byteLength(text), type, rewrites };
}

/* ------------------------------- run ------------------------------- */
for (const route of Object.keys(ROUTES)) enqueue(ORIGIN + route);
enqueue(ORIGIN + "/manifest.json");
enqueue(ORIGIN + "/sw.js");
enqueue(ORIGIN + "/favicon.ico");
enqueue(ORIGIN + "/opengraph-image.png");

let total = 0;
while (queue.length) {
  const url = queue.shift();
  if (downloaded.has(url)) continue;
  const dest = localPathFor(url);
  if (!dest) {
    skipped.push({ url, reason: `path nests a second copy under ${OUT}/` });
    console.log(`SKIP              ${new URL(url).pathname}: would nest under ${OUT}/`);
    continue;
  }
  try {
    const info = await fetchTo(url, dest);
    downloaded.set(url, dest);
    total += info.bytes;
    const extra = info.rewrites ? `  (${info.rewrites} api ref${info.rewrites > 1 ? "s" : ""} neutralised)` : "";
    console.log(`ok   ${String(info.bytes).padStart(8)}  ${new URL(url).pathname} -> ${dest}${extra}`);
  } catch (err) {
    failures.push({ url, error: err.message });
    console.log(`FAIL              ${new URL(url).pathname}: ${err.message}`);
  }
}

console.log(`\n${downloaded.size} assets, ${(total / 1024 / 1024).toFixed(1)} MB written to ${OUT}/`);
if (skipped.length) {
  console.log(`${skipped.length} skipped (they would have nested a duplicate copy):`);
  for (const s of skipped) console.log(`  ${s.url} — ${s.reason}`);
}
if (failures.length) {
  console.log(`${failures.length} failed:`);
  for (const f of failures) console.log(`  ${f.url} — ${f.error}`);
}
