/**
 * The credential checker, tested on the decisions rather than on the network.
 *
 * A tool that exists to report bad news is worth as much as its willingness to
 * report it, so these tests are mostly about failures: an expired token, a token
 * inside the expiry margin, a credential that can push everything except a
 * workflow file, and the two ways the checker itself could lie — reporting a
 * probe as clean when it could not read the remote's refs, or reporting the
 * workflow refusal as an authentication failure when GitHub had already accepted
 * the authentication.
 *
 * The workflow refusal below is the message GitHub actually sent this repository,
 * copied from the session that measured it (DEPLOY.md §9). Everything else that
 * has a string in it is likewise a real response, not an invention.
 *
 * No test here touches the network, git, or a credential store: the gathering
 * lives in `main()`, and the verdict is a pure function of what was gathered.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  EXPIRY_WARNING_DAYS,
  assessCredential,
  classifyRefusal,
  classifyToken,
  daysUntil,
  firstMeaningfulLine,
  parseCredential,
  parseRemote,
} from "../tools/verify-credential.mjs";

/** The line for one check, so an assertion can name it rather than index it. */
const checkFor = (checks, fragment) => checks.find((check) => check.name.includes(fragment)) ?? {};

/** What GitHub sent when the workflow probe was refused, verbatim. */
const WORKFLOW_REFUSAL =
  " ! [remote rejected] workflow-push-probe -> workflow-push-probe (refusing to allow a Personal Access Token to create or update workflow `.github/workflows/ci.yml` without `workflow` scope)\n" +
  "error: failed to push some refs to 'https://github.com/justcallmedavy-art/paloption.git'";

const AUTH_REFUSAL =
  "remote: Invalid username or token. Password authentication is not supported for Git operations.\n" +
  "fatal: Authentication failed for 'https://github.com/justcallmedavy-art/paloption.git/'";

/** A healthy set of gathered facts, with each test overriding one thing. */
function facts(overrides = {}) {
  return {
    credential: { username: "justcallmedavy-art", password: `ghp_${"a".repeat(36)}` },
    api: {
      status: 200,
      push: true,
      scopes: "repo",
      expiresAt: "2027-01-01 00:00:00 UTC",
      message: "",
    },
    auth: { accepted: true, refusal: "none", detail: "the dry-run push was accepted", refCreated: false },
    workflow: { accepted: false, refusal: "workflow-scope", detail: "refusing to allow a Personal Access Token…", path: ".github/workflows/ci.yml", refRemoved: true },
    now: Date.parse("2026-10-16T00:00:00Z"),
    ...overrides,
  };
}

describe("classifyToken", () => {
  test("names the two kinds that take different permissions", () => {
    assert.equal(classifyToken(`ghp_${"x".repeat(36)}`), "classic");
    assert.equal(classifyToken(`github_pat_${"x".repeat(20)}`), "fine-grained");
  });

  test("names the other credential types rather than calling them unknown", () => {
    assert.equal(classifyToken("gho_abc"), "oauth");
    assert.equal(classifyToken("ghs_abc"), "app");
    assert.equal(classifyToken("ghu_abc"), "user");
  });

  test("says so when there is nothing to classify", () => {
    assert.equal(classifyToken(""), "none");
    assert.equal(classifyToken(null), "none");
    assert.equal(classifyToken("hunter2"), "unrecognised");
  });
});

describe("parseRemote", () => {
  test("reads the owner and repository out of an HTTPS remote", () => {
    assert.deepEqual(parseRemote("https://github.com/justcallmedavy-art/paloption.git"), {
      host: "github.com",
      owner: "justcallmedavy-art",
      repo: "paloption",
    });
  });

  test("accepts a remote without the .git suffix", () => {
    assert.deepEqual(parseRemote("https://github.com/owner/repo"), { host: "github.com", owner: "owner", repo: "repo" });
  });

  test("reads an SSH remote too, because the shape decides whether a token is involved", () => {
    assert.deepEqual(parseRemote("git@github.com:justcallmedavy-art/paloption.git"), {
      host: "github.com",
      owner: "justcallmedavy-art",
      repo: "paloption",
    });
  });

  test("returns null for something that is not a remote at all", () => {
    assert.equal(parseRemote("not a url"), null);
    assert.equal(parseRemote(""), null);
    assert.equal(parseRemote(undefined), null);
  });
});

describe("parseCredential", () => {
  test("reads the fields git hands back, and never needs the password to be printed", () => {
    const parsed = parseCredential("protocol=https\nhost=github.com\nusername=justcallmedavy-art\npassword=secret-value\n");
    assert.equal(parsed.host, "github.com");
    assert.equal(parsed.username, "justcallmedavy-art");
    assert.equal(parsed.password, "secret-value");
  });

  test("an empty answer is an empty credential, not a crash", () => {
    assert.deepEqual(parseCredential(""), { host: "", username: "", password: "" });
    assert.deepEqual(parseCredential(undefined), { host: "", username: "", password: "" });
  });
});

describe("daysUntil", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");

  test("parses GitHub's expiry format, which is not ISO", () => {
    assert.equal(daysUntil("2026-10-24 22:41:11 UTC", now), 8);
  });

  test("goes negative once the date has passed", () => {
    assert.equal(daysUntil("2026-10-15 00:00:00 UTC", now), -1);
  });

  test("null when there is no date, which is not the same as no expiry", () => {
    assert.equal(daysUntil("", now), null);
    assert.equal(daysUntil("not a date", now), null);
  });
});

describe("classifyRefusal", () => {
  test("recognises the workflow refusal this repository actually hit", () => {
    assert.equal(classifyRefusal(WORKFLOW_REFUSAL), "workflow-scope");
  });

  test("recognises the forms a fine-grained token is refused with", () => {
    assert.equal(
      classifyRefusal("remote: refusing to allow a fine-grained personal access token to update workflow .github/workflows/x.yml without `workflow` permission"),
      "workflow-scope"
    );
  });

  test("separates an authentication failure from a permission failure", () => {
    assert.equal(classifyRefusal(AUTH_REFUSAL), "auth");
    assert.equal(classifyRefusal("remote: Permission to owner/repo.git denied to someone-else."), "permission");
    assert.equal(classifyRefusal("fatal: could not read Username for 'https://github.com': terminal prompts disabled"), "auth");
  });

  test("names the push problems that are nobody's permission", () => {
    assert.equal(classifyRefusal(" ! [rejected] main -> main (fetch first)"), "non-fast-forward");
    assert.equal(classifyRefusal("remote: error: GH013: Repository rule violations found"), "protected");
  });

  test("no output at all is not a refusal", () => {
    assert.equal(classifyRefusal(""), "none");
  });
});

describe("firstMeaningfulLine", () => {
  test("quotes the reason, not the sha and branch name that change every run", () => {
    assert.match(
      firstMeaningfulLine(WORKFLOW_REFUSAL),
      /^refusing to allow a Personal Access Token to create or update workflow `\.github\/workflows\/ci\.yml` without `workflow` scope$/
    );
  });

  test("drops the lines that say nothing about why", () => {
    assert.equal(
      firstMeaningfulLine("To https://github.com/o/r.git\nremote: Permission to o/r.git denied to nobody.\nerror: failed to push some refs"),
      "Permission to o/r.git denied to nobody."
    );
    assert.equal(firstMeaningfulLine("Everything up-to-date"), "");
  });
});

describe("assessCredential", () => {
  test("a credential that can push but not touch workflows fails exactly one check", () => {
    const checks = assessCredential(facts());
    assert.equal(checks.filter((check) => check.status === "fail").length, 1);
    assert.equal(checkFor(checks, "may commit under").status, "fail");
    // The distinction the whole tool turns on: GitHub refused the workflow, not
    // the authentication, so that check must not be dragged down with it.
    assert.equal(checkFor(checks, "authenticates and may write").status, "pass");
    assert.match(checkFor(checks, "may commit under").detail, /Workflows permission/);
  });

  test("a credential outside the expiry margin passes the expiry check", () => {
    const checks = assessCredential(facts({ api: { status: 200, push: true, scopes: "repo", expiresAt: "2028-01-01 00:00:00 UTC", message: "" } }));
    assert.equal(checkFor(checks, "about to expire").status, "pass");
  });

  test("a credential inside the margin fails, and says how long is left", () => {
    const checks = assessCredential(facts({ api: { status: 200, push: true, scopes: "repo", expiresAt: "2026-10-24 22:41:11 UTC", message: "" } }));
    const check = checkFor(checks, "about to expire");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /8 day\(s\) left/);
    assert.match(check.detail, new RegExp(`${EXPIRY_WARNING_DAYS}-day margin`));
  });

  test("an already expired credential is a failure, not a warning", () => {
    const checks = assessCredential(facts({ api: { status: 200, push: true, scopes: "repo", expiresAt: "2026-10-01 00:00:00 UTC", message: "" } }));
    assert.match(checkFor(checks, "about to expire").detail, /expired 15 day\(s\) ago/);
    assert.equal(checkFor(checks, "about to expire").status, "fail");
  });

  test("no expiry reported is a pass with the reason, not a silent tick", () => {
    const checks = assessCredential(facts({ api: { status: 200, push: true, scopes: "", expiresAt: "", message: "" } }));
    const check = checkFor(checks, "about to expire");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /reported no expiry/);
  });

  test("a remote that uses no stored credential is skipped, not failed", () => {
    const checks = assessCredential({ credential: null, api: null, auth: null, workflow: null, httpsRemote: false });
    assert.deepEqual(checks.filter((check) => check.status === "fail"), []);
    assert.ok(checks.length > 0 && checks.every((check) => check.status === "skip"));
    assert.match(checks[0].detail, /SSH uses a key/);
  });

  test("no stored credential is the failure to report first", () => {
    const checks = assessCredential(facts({ credential: null, api: null, auth: null, workflow: null }));
    assert.equal(checkFor(checks, "a credential is stored").status, "fail");
    assert.match(checkFor(checks, "a credential is stored").detail, /DEPLOY\.md §9/);
  });

  test("a classic token without workflow scope says so in its scopes", () => {
    const checks = assessCredential(facts());
    const check = checkFor(checks, "scopes are known");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /no workflow scope/);
  });

  test("a fine-grained token is not judged on scopes it does not have", () => {
    const checks = assessCredential(facts({ credential: { username: "u", password: `github_pat_${"x".repeat(20)}` } }));
    const check = checkFor(checks, "scopes are known");
    assert.equal(check.status, "skip");
    assert.match(check.detail, /permissions rather than scopes/);
  });

  test("an authentication failure fails the write check and quotes the reason", () => {
    const checks = assessCredential(facts({ auth: { accepted: false, refusal: "auth", detail: "Invalid username or token.", refCreated: false } }));
    const check = checkFor(checks, "authenticates and may write");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /Invalid username or token/);
  });

  test("a refusal that only mentions workflow scope still counts as write access", () => {
    const checks = assessCredential(
      facts({ auth: { accepted: false, refusal: "workflow-scope", detail: "refusing to allow a Personal Access Token…", refCreated: false } })
    );
    assert.equal(checkFor(checks, "authenticates and may write").status, "pass");
  });

  test("the probe that could not list refs is skipped, never passed", () => {
    const checks = assessCredential(facts({ auth: { accepted: true, refusal: "none", detail: "", refCreated: null } }));
    const check = checkFor(checks, "dry-run probe created nothing");
    assert.equal(check.status, "skip");
    assert.match(check.detail, /could not list/);
  });

  test("a probe ref left behind is a failure, because --dry-run cannot create one", () => {
    const checks = assessCredential(facts({ auth: { accepted: true, refusal: "none", detail: "", refCreated: true } }));
    assert.equal(checkFor(checks, "dry-run probe created nothing").status, "fail");
  });

  test("an unreachable API fails rather than passing by omission", () => {
    const checks = assessCredential(facts({ api: { error: "could not reach api.github.com: timeout" } }));
    assert.equal(checkFor(checks, "GitHub answers").status, "fail");
    assert.match(checkFor(checks, "GitHub answers").detail, /could not reach/);
  });

  test("no push permission from the repository is a failure", () => {
    const checks = assessCredential(facts({ api: { status: 200, push: false, scopes: "repo", expiresAt: "2028-01-01 00:00:00 UTC", message: "" } }));
    assert.equal(checkFor(checks, "may push here").status, "fail");
  });

  test("a skipped workflow probe is a skip, with the flag that caused it implied", () => {
    const checks = assessCredential(facts({ workflow: null }));
    assert.equal(checkFor(checks, "may commit under").status, "skip");
  });

  test("skipping the workflow probe does not fail the run", () => {
    const checks = assessCredential(facts({ workflow: null }));
    assert.equal(checks.filter((check) => check.status === "fail").length, 0);
  });

  test("an accepted workflow push also checks that it cleaned up after itself", () => {
    const accepted = assessCredential(
      facts({ workflow: { accepted: true, refusal: "none", detail: "", path: ".github/workflows/ci.yml", refRemoved: true } })
    );
    assert.equal(checkFor(accepted, "may commit under").status, "pass");
    assert.equal(checkFor(accepted, "cleaned up after itself").status, "pass");

    const left = assessCredential(
      facts({ workflow: { accepted: true, refusal: "none", detail: "", path: ".github/workflows/ci.yml", refRemoved: false, remote: "origin", ref: "probe-abc" } })
    );
    const check = checkFor(left, "cleaned up after itself");
    assert.equal(check.status, "fail");
    assert.match(check.detail, /git push origin --delete probe-abc/);
  });

  test("a probe that touched the working tree is a failure, because it should not", () => {
    const checks = assessCredential(facts({ worktreeChanged: true }));
    assert.equal(checkFor(checks, "left the checkout alone").status, "fail");
  });

  test("a healthy credential fails nothing at all", () => {
    const healthy = assessCredential(
      facts({ workflow: { accepted: true, refusal: "none", detail: "", path: ".github/workflows/ci.yml", refRemoved: true } })
    );
    assert.deepEqual(healthy.filter((check) => check.status === "fail"), []);
  });
});
