#!/usr/bin/env node
/**
 * The frontend checklist: does the deployed client point at the deployed API?
 *
 * `tools/verify-deploy.mjs` checks the backend. Nothing about a 200 from the
 * frontend host proves the two are connected, because the only link between them
 * is a value baked into the client's bundles when the snapshot is built:
 *
 *   PALOPTION_API_URL=https://<api-host> npm run deploy:prod
 *
 * Forget that variable, or set it to a rehearsal server, or leave it pointing at
 * the previous backend, and the site still returns 200 and still renders every
 * page. What a visitor gets instead is a sign-in that cannot work — the client
 * calls its own host, which answers `404 NOT_FOUND` in Vercel's own JSON. That
 * is the failure this checks for, and it is invisible from the outside except by
 * reading what the bundle actually resolves.
 *
 *   node tools/verify-frontend.mjs --url https://paloption.vercel.app
 *   node tools/verify-frontend.mjs --url https://paloption.vercel.app \
 *        --expect-api https://paloption-api.onrender.com
 *
 * Read-only: it fetches the page, the chunks it references, and — with
 * `--expect-api` — that API's `/healthz`. Exit code 0 only when every check
 * passes, so it can gate a frontend release.
 *
 * A NOTE ON THE OBVIOUS IMPLEMENTATION, which is wrong. Grepping a bundle for
 * "localhost" reports a problem that is not one: the client's own wss-upgrade
 * guard contains the literal strings `ws://localhost` and `ws://127.0.0.1` in a
 * comparison, and the framework's URL parser mentions `localhost` too. Both are
 * present in a correct deployment. So this reads the *baked value* out of the
 * URL module and judges that, rather than matching substrings anywhere.
 */
import https from "node:https";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* --------------------------------- reading ------------------------------- */

/**
 * The API bases baked into one chunk. The mirrored bundle keeps both URLs in a
 * single module — `getApiUrl` and `getWsUrl` — so the value appears wherever a
 * chunk inlines that module. Two shapes are recognised: this project's patched
 * form, which adds a runtime override, and the upstream form, which has only the
 * baked string. Reporting which one was found matters: the upstream shape means
 * the snapshot predates the override rather than that the base is missing.
 *
 * Exported for the tests, which check it against fixture sources.
 */
export function apiBasesIn(source) {
  const found = [];
  const patched = /let t="([^"]*)";let U=\(\)=>globalThis\.__PALOPTION_API_URL__\|\|t;e\.s\(\["getApiUrl"/g;
  const upstream = /let t="([^"]*)";e\.s\(\["getApiUrl",0,\(\)=>t,"getWsUrl"/g;
  for (const re of [patched, upstream]) {
    for (const match of source.matchAll(re)) found.push({ base: match[1], form: re === patched ? "patched" : "upstream" });
  }
  return found;
}

/**
 * Whether this chunk derives the socket from the same base and upgrades it to
 * `wss` on an https page. Without this, an https frontend pointed at an https
 * API would open a plaintext `ws://` socket and send the session token in the
 * clear — or simply fail to connect.
 */
export function socketFollowsApi(source) {
  const derives = /"getWsUrl",0,\(\)=>\{let e=[A-Za-z_$][\w$]*\(\)\.replace\(\/\^http\/,"ws"\)/.test(source);
  const upgrades = /"https:"===location\.protocol&&"ws:"===e\.substr\(0,3\)/.test(source);
  return derives && upgrades;
}

/**
 * A base that only makes sense on a developer's machine: a loopback host, or a
 * port this project's local servers use. Those are the values that get shipped
 * by accident when a snapshot is built during a rehearsal, and the symptom — a
 * sign-in that hangs or fails with a connection refused — points nowhere near
 * the cause.
 */
export function isRehearsalBase(base) {
  return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base) || /:(4174|8799)\b/.test(base);
}

/** A short, comparable identity for a bundle, for a report a person can act on. */
export function bundleDigest(bytes) {
  return `${bytes.length} bytes ${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
}

/**
 * Which served bundles are not the ones this repository builds now.
 *
 * The point of the base check above is that a wrong value is invisible from
 * outside. The same is true of an old value: a frontend deployed before the last
 * client patch answers 200, carries a plausible API base, and quietly lacks the
 * fix. So when the caller has built a fresh snapshot, compare bytes.
 *
 * `served` is `[{ path, bytes }]` and `expected(path)` returns the fresh build's
 * buffer for that path, or null. Pure, so the tests drive it with fixtures — the
 * failures it must report are the interesting part, not the fetching.
 */
export function compareWithBuild(served, expected) {
  const differences = [];
  for (const bundle of served) {
    const want = expected(bundle.path);
    if (!want) {
      differences.push(`${bundle.path}: not in the fresh build (live ${bundleDigest(bundle.bytes)})`);
      continue;
    }
    if (!want.equals(bundle.bytes)) {
      differences.push(`${bundle.path}: live ${bundleDigest(bundle.bytes)}, fresh build ${bundleDigest(want)}`);
    }
  }
  return differences;
}

/* --------------------------------- verdict ------------------------------- */

/**
 * The decision, separated from the fetching so it can be tested without a
 * network. `bases` is what `apiBasesIn` found across every chunk, `health` is
 * the `--expect-api` probe (null when it was not asked for).
 */
export function assessFrontend({ bases, socketOk, expectApi = "", health = null, buildDiffs = null, apiHealthSkipped = null }) {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });

  const distinct = [...new Set(bases.map((b) => b.base))];
  const forms = [...new Set(bases.map((b) => b.form))];

  if (!bases.length) {
    record("the client's URL module is present", "fail", "no chunk carried getApiUrl/getWsUrl — this is not the bundle this project builds");
  } else if (distinct.length > 1) {
    record("one API base is baked in, not several", "fail", `found ${distinct.length}: ${distinct.map((b) => JSON.stringify(b)).join(", ")}`);
  } else {
    const base = distinct[0];
    record(
      "one API base is baked in",
      "pass",
      `${base ? base : "empty — the client calls its own origin"} (in ${forms.join("/")} form, ${bases.length} chunk(s))`
    );
  }

  const base = distinct.length === 1 ? distinct[0] : null;

  if (base !== null) {
    if (isRehearsalBase(base)) {
      record("the baked base is not a rehearsal server", "fail", `${base} is a loopback/rehearsal address — this snapshot was built locally`);
    } else if (/^http:\/\//.test(base)) {
      record("the baked base is not plain http", "fail", `${base} would send every request, and the session token, unencrypted`);
    } else {
      record(
        "the baked base is not a rehearsal server",
        "pass",
        base ? "public https origin" : "same-origin, which is correct only when the API serves this client"
      );
    }

    if (expectApi) {
      const matches = base === expectApi;
      record(
        "the baked base is the API we expect",
        matches ? "pass" : "fail",
        matches ? base : `expected ${expectApi}, bundle resolves ${base || "same-origin (its own host)"}`
      );
    }
  }

  record(
    "the socket follows the API base over wss",
    socketOk ? "pass" : "fail",
    socketOk ? "getWsUrl derives /ws from the same base and upgrades to wss on an https page" : "the socket base or its wss upgrade is missing"
  );

  // A separate check from the wss one, because they fail for different reasons:
  // a bundle in the upstream form predates the API-base override entirely, which
  // is a deployment that was never rebuilt from this repository's tooling.
  const patchedForm = bases.some((b) => b.form === "patched");
  record(
    "the bundles carry this repository's client patches",
    patchedForm ? "pass" : "fail",
    patchedForm
      ? `the API-base override is present (${bases.filter((b) => b.form === "patched").length} chunk(s))`
      : "every chunk is in the pre-patch form — this snapshot was built before the URL override, so it cannot be re-pointed and its socket never upgrades"
  );

  if (buildDiffs === null) {
    record("the served bundles are the ones this repository builds now", "skip", "needs --expect-build <snapshot dir>");
  } else {
    record(
      "the served bundles are the ones this repository builds now",
      buildDiffs.length ? "fail" : "pass",
      buildDiffs.length ? `${buildDiffs.length} bundle(s) differ: ${buildDiffs.slice(0, 3).join("; ")}` : "every served chunk is byte-identical to a fresh build"
    );
  }

  if (expectApi && health) {
    const ok = health.status === 200 && health.json?.ok === true && health.json?.storage === "postgres";
    record(
      "the API the client points at is live and backed by Postgres",
      ok ? "pass" : "fail",
      ok ? `/healthz: storage=${health.json.storage}` : `HTTP ${health.status} ${JSON.stringify(health.json)?.slice(0, 90)}`
    );
  } else if (apiHealthSkipped) {
    record("the API the client points at is live and backed by Postgres", "skip", apiHealthSkipped);
  } else if (expectApi) {
    record("the API the client points at is live and backed by Postgres", "skip", "the health check could not be performed");
  } else {
    record("the API the client points at is live and backed by Postgres", "skip", "needs --expect-api");
  }

  return checks;
}

/* -------------------------------- transport ------------------------------ */

/**
 * Where a redirect points, as an absolute URL. `Location` may be absolute,
 * protocol-relative or a bare path, and all three appear in the wild.
 * Exported for the tests.
 */
export function resolveRedirect(from, location) {
  return new URL(location, from).href;
}

/**
 * One request, following a bounded number of redirects.
 *
 * Following them is not politeness: a host answering `302` for a trailing slash
 * — or an apex domain pointing at `www`, or http redirecting to https — is a
 * working deployment, and a checker that stopped at the 302 would call the whole
 * site broken and never read a bundle. A 404 is still a result, not an error.
 */
function request(url, { timeout = 20_000, follow = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.get(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        timeout,
        // No Accept-Encoding: bytes are compared against a local build further
        // down, so a compressed body would be compared against an uncompressed
        // one and reported as a difference that is not there.
        headers: { "Accept-Encoding": "identity" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", async () => {
          const status = res.statusCode || 0;
          const location = res.headers.location;
          if (location && follow > 0 && [301, 302, 303, 307, 308].includes(status)) {
            try {
              resolve(await request(resolveRedirect(url, location), { timeout, follow: follow - 1 }));
            } catch (err) {
              reject(err);
            }
            return;
          }
          // Both forms of the body: the string for reading the bundle, the
          // bytes for comparing it with a build. Decoding is unconditional on
          // purpose — a caller that asks for bytes and then reads `.text` must
          // not be handed null, which is a mistake this made once already.
          const body = Buffer.concat(chunks);
          resolve({ status, headers: res.headers, bytes: body, text: body.toString("utf8"), url });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeout}ms`)));
    req.on("error", reject);
  });
}

const brief = (text) => String(text).replace(/\s+/g, " ").trim().slice(0, 120);

/* --------------------------------- running ------------------------------- */

/**
 * The CLI. Kept in a function and called only when this file is executed, so the
 * tests can import the checks above without running a network probe — importing
 * a module must not do that.
 */
export async function run(argv = process.argv.slice(2)) {
  const flag = (name) => argv.includes(`--${name}`);
  const valueOf = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at === -1 ? null : argv[at + 1];
  };

  if (flag("help") || !argv.length) {
    console.log(
      [
        "usage: node tools/verify-frontend.mjs --url https://<frontend> [options]",
        "",
        "  --path /trade              which page to read (default /trade)",
        "  --expect-api <origin>      the API origin the bundles must resolve; also probed at /healthz",
        "  --no-api-health            do not probe the API (an artifact gate does not need it to exist yet)",
        "  --expect-build <dir>       a snapshot to compare the served bundles against, byte for byte",
        "  --json                     the report as JSON",
      ].join("\n")
    );
    return argv.length ? 0 : 1;
  }

  const target = valueOf("url");
  if (!target || !/^https?:\/\//.test(target)) {
    console.error("--url must be an http(s) origin, e.g. --url https://paloption.vercel.app");
    return 1;
  }
  const BASE = target.replace(/\/+$/, "");
  const PATHNAME = valueOf("path") || "/trade";
  const EXPECT_API = (valueOf("expect-api") || "").replace(/\/+$/, "");
  const NO_API_HEALTH = flag("no-api-health");
  const EXPECT_BUILD = valueOf("expect-build");
  const AS_JSON = flag("json");
  /** A page references a handful of chunks; this bounds a runaway. */
  const MAX_CHUNKS = 40;

  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });
  let bases = [];
  let socketOk = false;
  /** Every referenced bundle, kept whole so it can be compared with a build. */
  const served = [];

  try {
    const page = await request(BASE + PATHNAME);
    const isHtml = /\btext\/html\b/i.test(String(page.headers["content-type"] || ""));
    record("the frontend answers with a page", page.status === 200 && isHtml ? "pass" : "fail", `HTTP ${page.status} ${page.headers["content-type"] || ""}`);

    if (page.status !== 200 || !isHtml) {
      // Nothing below can be judged against something that is not a page.
      bases = [];
    } else {
      const sources = [...new Set([...page.text.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]))];
      record("the page references its client bundles", sources.length ? "pass" : "fail", `${sources.length} script(s), reading up to ${Math.min(sources.length, MAX_CHUNKS)}`);

      let scanned = 0;
      const failures = [];
      for (const src of sources.slice(0, MAX_CHUNKS)) {
        try {
          const chunk = await request(BASE + src);
          scanned += 1;
          bases.push(...apiBasesIn(chunk.text));
          if (socketFollowsApi(chunk.text)) socketOk = true;
          served.push({ path: src, bytes: chunk.bytes });
        } catch (err) {
          failures.push(`${src}: ${brief(err.message)}`);
        }
      }
      record("every referenced bundle could be read", failures.length ? "fail" : "pass", failures.length ? failures.slice(0, 3).join("; ") : `${scanned} chunk(s) fetched`);
    }

    /**
     * A fresh build to compare against. Read once per bundle, and a file that
     * cannot be read counts as a difference rather than as agreement — an
     * unreadable build must not turn into a pass.
     */
    let buildDiffs = null;
    if (EXPECT_BUILD) {
      const root = EXPECT_BUILD.replace(/[\\/]+$/, "");
      const bodies = await Promise.all(
        served.map((bundle) => readFile(join(root, ...bundle.path.replace(/^\/+/, "").split("/"))).catch(() => null))
      );
      buildDiffs = compareWithBuild(
        served,
        (path) => bodies[served.findIndex((b) => b.path === path)] ?? null
      );
    }

    let health = null;
    if (EXPECT_API && !NO_API_HEALTH) {
      try {
        const res = await request(EXPECT_API + "/healthz");
        let json = null;
        try {
          json = JSON.parse(res.text);
        } catch {
          /* a non-JSON body is itself the finding */
        }
        health = { status: res.status, json };
      } catch (err) {
        health = { status: 0, json: null, error: brief(err.message) };
      }
    }
    checks.push(
      ...assessFrontend({
        bases,
        socketOk,
        expectApi: EXPECT_API,
        health,
        buildDiffs,
        apiHealthSkipped: NO_API_HEALTH && EXPECT_API ? "not checked (--no-api-health: an artifact gate does not need the API to exist yet)" : null,
      })
    );
  } catch (err) {
    record("the frontend could be reached", "fail", brief(err.message));
    checks.push(
      ...assessFrontend({ bases, socketOk, expectApi: EXPECT_API, health: null }).map((c) => ({
        ...c,
        status: c.status === "pass" ? "skip" : c.status,
      }))
    );
  }

  const failed = checks.filter((c) => c.status === "fail");
  const passed = checks.filter((c) => c.status === "pass");
  const skipped = checks.filter((c) => c.status === "skip");

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          url: BASE,
          path: PATHNAME,
          expectApi: EXPECT_API || null,
          expectBuild: EXPECT_BUILD || null,
          apiHealthProbed: Boolean(EXPECT_API) && !NO_API_HEALTH,
          checks,
          passed: passed.length,
          failed: failed.length,
          skipped: skipped.length,
        },
        null,
        2
      )
    );
  } else {
    for (const check of checks) {
      console.log(`${check.status === "pass" ? "PASS" : check.status === "skip" ? "SKIP" : "FAIL"}  ${check.name} — ${check.detail}`);
    }
    console.log(`\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped against ${BASE}${PATHNAME}`);
  }

  return failed.length ? 1 : 0;
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) process.exit(await run());
