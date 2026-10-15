/**
 * The frontend checker, tested on sources whose right answer is known.
 *
 * A checker earns its keep in two directions, so both are covered here: it must
 * PASS a correct deployment, and it must FAIL the ways a frontend silently loses
 * its backend — a snapshot built without PALOPTION_API_URL (the bundles then call
 * the frontend's own host), a snapshot built during a rehearsal and shipped with
 * a loopback base, and a bundle that predates the wss upgrade.
 *
 * It also pins the near-miss this tool exists to avoid: the client's own
 * wss-upgrade guard contains the literal strings `ws://localhost` and
 * `ws://127.0.0.1`, so a naive search of the bundle for "localhost" finds a
 * problem in a perfectly correct deployment. The check reads the baked value
 * instead, and these tests hold that line.
 *
 * No network: every input is a fixture string.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { apiBasesIn, socketFollowsApi, isRehearsalBase, assessFrontend, resolveRedirect } from "../tools/verify-frontend.mjs";

/** What tools/client-patches.mjs writes into a chunk, with `base` baked in. */
const patched = (base) =>
  `},74728,e=>{"use strict";let t="${base}";let U=()=>globalThis.__PALOPTION_API_URL__||t;e.s(["getApiUrl",0,()=>U(),"getWsUrl",0,()=>{let e=U().replace(/^http/,"ws");"https:"===location.protocol&&"ws:"===e.substr(0,3)&&0>e.indexOf("ws://localhost")&&0>e.indexOf("ws://127.0.0.1")&&(e="wss:"+e.substr(3));return\`\${e}/ws\`}])},75254,e=>{`;

/** The upstream module, before the patch: no override, no wss upgrade. */
const upstream = (base) =>
  `},74728,e=>{"use strict";let t="${base}";e.s(["getApiUrl",0,()=>t,"getWsUrl",0,()=>{let e=t.replace(/^http/,"ws");return\`\${e}/ws\`}])},75254,e=>{`;

const PROD = "https://paloption-api.onrender.com";

const passes = (checks) => checks.filter((c) => c.status === "pass");
const failures = (checks) => checks.filter((c) => c.status === "fail");
const named = (checks, name) => checks.find((c) => c.name.includes(name));

describe("following a redirect", () => {
  test("a trailing-slash redirect lands on the same host", () => {
    // Met for real: a static host answers 302 for /trade -> /trade/. Treating
    // that as a broken site meant never reading a single bundle.
    assert.equal(resolveRedirect("http://127.0.0.1:4181/trade", "/trade/"), "http://127.0.0.1:4181/trade/");
  });

  test("an absolute and a protocol-relative target both resolve", () => {
    assert.equal(resolveRedirect("https://paloption.vercel.app/trade", "https://paloption.vercel.app/login"), "https://paloption.vercel.app/login");
    assert.equal(resolveRedirect("https://paloption.vercel.app/trade", "//www.example.com/trade"), "https://www.example.com/trade");
  });

  test("a relative target resolves against the request", () => {
    assert.equal(resolveRedirect("https://example.com/a/b", "c"), "https://example.com/a/c");
  });
});

describe("reading the baked API base", () => {
  test("finds the patched form and says which form it is", () => {
    assert.deepEqual(apiBasesIn(patched(PROD)), [{ base: PROD, form: "patched" }]);
  });

  test("finds the upstream form too, so a pre-patch snapshot is reported as such", () => {
    assert.deepEqual(apiBasesIn(upstream("")), [{ base: "", form: "upstream" }]);
  });

  test("finds one per chunk, and none in a chunk without the module", () => {
    assert.equal(apiBasesIn(patched(PROD) + patched(PROD)).length, 2, "each inlined copy counts");
    assert.deepEqual(apiBasesIn("var x = 1; console.log('unrelated');"), []);
  });

  test("the wss upgrade is recognised, and its absence is not", () => {
    assert.equal(socketFollowsApi(patched(PROD)), true);
    assert.equal(socketFollowsApi(upstream(PROD)), false, "the upstream module derives /ws but never upgrades to wss");
  });
});

describe("what counts as a rehearsal base", () => {
  test("loopback hosts and this project's local ports", () => {
    for (const base of ["http://localhost:8799", "http://127.0.0.1:4174", "http://[::1]:8799", "http://127.0.0.1", "https://localhost"]) {
      assert.equal(isRehearsalBase(base), true, base);
    }
  });

  test("and nothing else", () => {
    for (const base of [PROD, "https://paloption.vercel.app", "", "http://localhostx.example", "https://api.example.com:443", "https://notlocalhost.example:8799ish"]) {
      assert.equal(isRehearsalBase(base), false, base);
    }
  });

  test("the client's own guard strings are not mistaken for a loopback base", () => {
    // The trap: this chunk is a correct production bundle, and it contains
    // "ws://localhost" as a comparison. Reading the baked value is what saves it.
    assert.deepEqual(apiBasesIn(patched(PROD)).map((b) => b.base), [PROD]);
    const checks = assessFrontend({ bases: apiBasesIn(patched(PROD)), socketOk: socketFollowsApi(patched(PROD)), expectApi: PROD });
    assert.deepEqual(failures(checks), [], `expected no failures, got ${JSON.stringify(failures(checks))}`);
  });
});

describe("the verdict", () => {
  test("a correct split deployment passes every check", () => {
    const checks = assessFrontend({
      bases: apiBasesIn(patched(PROD)),
      socketOk: true,
      expectApi: PROD,
      health: { status: 200, json: { ok: true, storage: "postgres" } },
    });
    assert.deepEqual(failures(checks), [], `no failures, got ${JSON.stringify(failures(checks))}`);
    assert.ok(named(checks, "one API base").status === "pass");
    assert.ok(named(checks, "is live and backed by Postgres").status === "pass");
  });

  test("a snapshot built without PALOPTION_API_URL fails when an API was expected", () => {
    const checks = assessFrontend({ bases: apiBasesIn(patched("")), socketOk: true, expectApi: PROD });
    const mismatch = named(checks, "the API we expect");
    assert.equal(mismatch.status, "fail");
    assert.match(mismatch.detail, /same-origin \(its own host\)/, "and says what the bundle resolves instead");
    // Same-origin is not a failure on its own: it is the correct one-origin shape.
    const oneOrigin = assessFrontend({ bases: apiBasesIn(patched("")), socketOk: true });
    assert.deepEqual(failures(oneOrigin), [], "without --expect-api, same-origin passes");
  });

  test("a snapshot built during a rehearsal is called out", () => {
    const checks = assessFrontend({ bases: apiBasesIn(patched("http://127.0.0.1:8799")), socketOk: true, expectApi: PROD });
    const rehearsal = named(checks, "not a rehearsal server");
    assert.equal(rehearsal.status, "fail");
    assert.match(rehearsal.detail, /loopback\/rehearsal/);
  });

  test("an http base on an https page is refused", () => {
    const checks = assessFrontend({ bases: apiBasesIn(patched("http://api.example.com")), socketOk: true });
    assert.equal(named(checks, "not plain http").status, "fail");
  });

  test("a bundle that has lost its wss upgrade fails", () => {
    const checks = assessFrontend({ bases: apiBasesIn(upstream(PROD)), socketOk: socketFollowsApi(upstream(PROD)) });
    assert.equal(named(checks, "socket follows").status, "fail");
  });

  test("a bundle that is not this client at all fails", () => {
    const checks = assessFrontend({ bases: [], socketOk: false });
    assert.equal(named(checks, "URL module is present").status, "fail");
  });

  test("two different bases in one deployment is a failure, not a choice", () => {
    const checks = assessFrontend({ bases: [...apiBasesIn(patched(PROD)), ...apiBasesIn(patched("https://old.example"))], socketOk: true, expectApi: PROD });
    const several = named(checks, "not several");
    assert.equal(several.status, "fail");
    assert.match(several.detail, /old\.example/);
  });

  test("a live API that is not Postgres is a failure", () => {
    const checks = assessFrontend({
      bases: apiBasesIn(patched(PROD)),
      socketOk: true,
      expectApi: PROD,
      health: { status: 200, json: { ok: true, storage: "memory" } },
    });
    const ledger = named(checks, "is live and backed by Postgres");
    assert.equal(ledger.status, "fail");
    assert.match(ledger.detail, /memory/, "the storage it reported is quoted");
  });

  test("the health check is skipped, not passed, when no API was named", () => {
    const checks = assessFrontend({ bases: apiBasesIn(patched(PROD)), socketOk: true });
    assert.equal(named(checks, "is live and backed by Postgres").status, "skip");
  });
});
