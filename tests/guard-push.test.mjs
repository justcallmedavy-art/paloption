/**
 * The push guard, tested against real temporary repositories.
 *
 * A guard is worth exactly what it does to a checkout that is trying to push,
 * so almost nothing here is mocked: each test builds a bare remote and a working
 * repository in the system temporary directory, makes real commits, and either
 * runs the guard the way the hook runs it (git's own four-field ref lines on
 * stdin) or, in the end-to-end block, lets `git push` run the committed hook
 * itself and then looks at the remote. No test contacts a network host, reads a
 * credential store, or needs a GitHub token.
 *
 * The two failures worth writing down are the two the guard could ship with:
 * blocking an ordinary push (which would make the guard the thing people bypass,
 * taking the protection with it), and allowing a workflow change nobody
 * authorised. Both have a block below, and the credential-safety block asserts
 * the thing that must never happen — a token in a report or in the audit line.
 *
 * One thing the tests have to arrange for themselves: git discovers a repository
 * by walking upwards, and these fixtures live under a temporary directory that
 * may itself sit below somebody else's repository, which changes what "outside a
 * repository" means. `GIT_CEILING_DIRECTORIES` stops that walk at the temporary
 * root, so the fixtures are judged on their own contents wherever they run.
 *
 * Run: npm test
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIT_DEFAULT_LIMIT,
  AUTHORIZATION_ENV,
  MIN_REASON_CHARS,
  PROTECTED_DIR,
  assessPush,
  auditLine,
  authorizationFrom,
  gatherPush,
  inOneLine,
  isProtectedPath,
  parseOutgoingLog,
  parseRefUpdates,
  readAuditTrail,
  redactUrl,
} from "../tools/guard-push.mjs";

const GUARD = fileURLToPath(new URL("../tools/guard-push.mjs", import.meta.url));
const HOOKS = fileURLToPath(new URL("../.githooks", import.meta.url));
const WORKFLOW = `${PROTECTED_DIR}/ci.yml`;

/* ------------------------------- scaffolding ------------------------------ */

/** Every directory this file creates, so the whole lot can be removed again. */
const created = [];
const scratch = scratchRepo("strategyoption-guard-env-");
writeFileSync(join(scratch, "empty.gitconfig"), "");

const dispose = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });

/**
 * A directory for one fixture, registered for removal the moment it exists.
 *
 * Creating and registering have to be the same step: a directory made first and
 * recorded afterwards leaks whenever the test fails in between, which is where
 * three empty `strategyoption-guard-*` directories in a temporary folder came from
 * before this was one call.
 */
function scratchRepo(prefix = "strategyoption-guard-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

after(() => {
  for (const dir of created) if (existsSync(dir)) dispose(dir);
});

/**
 * The environment every git call and every guard run gets. A developer's global
 * git config, a credential helper, or a leftover STRATEGYOPTION_* variable must not
 * be able to change what these tests measure, so all of them are removed rather
 * than inherited.
 */
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    AUTHORIZATION_ENV,
    "STRATEGYOPTION_PUSH_GUARD_LOG",
  ]) {
    delete env[key];
  }
  env.GIT_CONFIG_GLOBAL = join(scratch, "empty.gitconfig");
  env.GIT_CONFIG_SYSTEM = join(scratch, "empty.gitconfig");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = "Guard Test";
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = "guard@example.invalid";
  env.GIT_TERMINAL_PROMPT = "0";
  // No fixture may be judged by a repository above the temporary directory.
  env.GIT_CEILING_DIRECTORIES = tmpdir();
  return Object.assign(env, extra);
}

function git(args, { cwd, env = {}, input = "", allowFailure = false } = {}) {
  try {
    const stdout = execFileSync("git", args, { cwd, input, encoding: "utf8", env: baseEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    return { ok: true, code: 0, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    if (!allowFailure) throw new Error(`git ${args.join(" ")} failed: ${error.stderr?.toString() || error.message}`);
    return { ok: false, stdout: (error.stdout?.toString() ?? "").trim(), stderr: (error.stderr?.toString() ?? "").trim(), code: error.status ?? 1 };
  }
}

/** The guard, run as a person or a hook would run it: exit status, out and err. */
function runGuard(args, { cwd, input = "", env = {} } = {}) {
  try {
    const out = execFileSync(process.execPath, [GUARD, ...args], { cwd, input, encoding: "utf8", env: baseEnv(env), stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, out, err: "" };
  } catch (error) {
    return { code: error.status ?? 1, out: error.stdout?.toString() ?? "", err: error.stderr?.toString() ?? "" };
  }
}

function commitFiles(repo, files, message) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(["add", "-A"], { cwd: repo });
  git(["commit", "-q", "-m", message], { cwd: repo });
  return git(["rev-parse", "HEAD"], { cwd: repo }).stdout;
}

/**
 * The shape this repository is actually in: a bare remote, a checkout whose
 * `main` is pushed, and a workflow file that already exists on the remote — so a
 * later ordinary push does not touch it and a later workflow commit does.
 */
function seeded() {
  const root = scratchRepo();
  const remotePath = join(root, "origin.git");
  const work = join(root, "work");
  git(["init", "--bare", "-q", "-b", "main", remotePath]);
  git(["init", "-q", "-b", "main", work]);
  git(["remote", "add", "origin", remotePath], { cwd: work });
  commitFiles(work, { "README.md": "# scratch\n", [WORKFLOW]: "name: CI\non: push\njobs: {}\n" }, "seed");
  git(["push", "-q", "-u", "origin", "main"], { cwd: work });
  return { root, remotePath, work, remoteMain: () => git(["rev-parse", "refs/remotes/origin/main"], { cwd: work }).stdout };
}

/** One call to the guard in hook mode, with git's own line format on stdin. */
function hookRun(fixture, { localRef = "refs/heads/main", localSha, remoteRef = "refs/heads/main", remoteSha, url, env = {} } = {}) {
  return runGuard(["--hook", "origin", url ?? fixture.remotePath], {
    cwd: fixture.work,
    input: `${localRef} ${localSha ?? git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout} ${remoteRef} ${remoteSha ?? fixture.remoteMain()}\n`,
    env,
  });
}

/**
 * The shell the hook is written in, by absolute path.
 *
 * Node resolves a command name through the environment it is *given*, so a child
 * with `PATH` stripped cannot find `sh` at all — and a test of "what happens
 * when node is not on PATH" needs a shell that is still reachable. On Windows
 * that absolute path has to come back converted, because the shell git uses is
 * an MSYS one whose `/usr/bin/sh` is not a path the Windows loader understands.
 */
function shellPath() {
  const found = execFileSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).trim();
  if (process.platform !== "win32" || !found) return found;
  try {
    return execFileSync("cygpath", ["-w", found], { encoding: "utf8" }).trim();
  } catch {
    return found;
  }
}

/** The hook script, run the way git runs it: a shell, two arguments, stdin. */
function runHook(script, { env = {}, input = "" } = {}) {
  const shell = shellPath();
  const result = spawnSync(shell, [script, "origin", "https://example.invalid/o/r.git"], {
    input,
    encoding: "utf8",
    env: baseEnv(env),
  });
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "", missingShell: result.error?.code === "ENOENT" };
}

const auditPath = (repo) => join(repo, ".git", "strategyoption-push-guard.log");
const auditLines = (repo) => (existsSync(auditPath(repo)) ? readFileSync(auditPath(repo), "utf8").trim().split("\n") : []);

/* ------------------------------ trail fixtures ----------------------------- */

/** A UTC instant in the writer's own form, `seconds` after 12:00 on 2026-01-01. */
const instant = (seconds) => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString();

/** A record built through the writer rather than typed by hand, so the fixtures cannot drift from the format. */
const authorised = (over = {}) =>
  auditLine({
    when: instant(0),
    remote: "origin",
    refs: "refs/heads/main",
    commits: 2,
    files: WORKFLOW,
    source: `$${AUTHORIZATION_ENV}`,
    reason: "a workflow change that was intended",
    ...over,
  });

/** The same, for the kind this tool reads but deliberately does not write. */
const refused = (over = {}) =>
  authorised({ kind: "refused", when: instant(1), source: "none", reason: "the push changes a workflow file and no reason was given", ...over });

/** A trail file holding exactly this text, named outright so that reading it needs no repository. */
function trailWith(text) {
  const dir = scratchRepo();
  const path = join(dir, "strategyoption-push-guard.log");
  writeFileSync(path, text);
  return path;
}

/** `--audit`, against one named trail. */
const runAudit = (path, args = []) => runGuard(["--audit", ...args], { env: { STRATEGYOPTION_PUSH_GUARD_LOG: path } });

/* --------------------------------- reading -------------------------------- */

describe("redactUrl", () => {
  test("removes userinfo, which is where a pasted token lives", () => {
    assert.equal(redactUrl("https://user:ghp_secret@github.com/o/r.git"), "https://<redacted>@github.com/o/r.git");
    assert.equal(redactUrl("https://ghp_secret@github.com/o/r.git"), "https://<redacted>@github.com/o/r.git");
  });

  test("leaves a URL with no userinfo exactly as it is", () => {
    assert.equal(redactUrl("https://github.com/justcallmedavy-art/strategyoption.git"), "https://github.com/justcallmedavy-art/strategyoption.git");
    assert.equal(redactUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
    assert.equal(redactUrl(""), "");
    assert.equal(redactUrl(undefined), "");
  });
});

describe("parseRefUpdates", () => {
  test("reads git's four fields", () => {
    const { updates, unreadable } = parseRefUpdates(
      "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n"
    );
    assert.deepEqual(unreadable, []);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].localSha, "1".repeat(40));
    assert.equal(updates[0].remoteSha, "2".repeat(40));
    assert.equal(updates[0].deletion, false);
  });

  test("recognises a deletion, which sends no commits", () => {
    const { updates } = parseRefUpdates(`(delete) ${"0".repeat(40)} refs/heads/old ${"2".repeat(40)}\n`);
    assert.equal(updates[0].deletion, true);
    assert.equal(updates[0].remoteRef, "refs/heads/old");
  });

  test("reads several refs in one push, and ignores the blank line git ends with", () => {
    const { updates } = parseRefUpdates(
      `refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\nrefs/tags/v1 ${"3".repeat(40)} refs/tags/v1 ${"0".repeat(40)}\n\n`
    );
    assert.deepEqual(updates.map((update) => update.remoteRef), ["refs/heads/main", "refs/tags/v1"]);
  });

  test("a line that is not in that form is reported, never dropped", () => {
    const { updates, unreadable } = parseRefUpdates("something else entirely\n");
    assert.deepEqual(updates, []);
    assert.equal(unreadable.length, 1);
  });

  test("tolerates CRLF, because a hook's stdin is not always LF on Windows", () => {
    const { updates, unreadable } = parseRefUpdates(`refs/heads/main ${"1".repeat(40)} refs/heads/main ${"2".repeat(40)}\r\n`);
    assert.equal(updates.length, 1);
    assert.deepEqual(unreadable, []);
    assert.equal(updates[0].remoteSha, "2".repeat(40));
  });
});

describe("isProtectedPath", () => {
  test("protects the workflow directory and everything under it", () => {
    assert.equal(isProtectedPath(".github/workflows/ci.yml"), true);
    assert.equal(isProtectedPath(".github/workflows/nested/deploy.yml"), true);
    assert.equal(isProtectedPath(".github/workflows"), true);
  });

  test("does not protect a path that merely starts with the same characters", () => {
    assert.equal(isProtectedPath(".github/workflows-notes.md"), false);
    assert.equal(isProtectedPath(".github/workflows2/ci.yml"), false);
    assert.equal(isProtectedPath("docs/.github/workflows/ci.yml"), false);
    assert.equal(isProtectedPath(".github/CODEOWNERS"), false);
    assert.equal(isProtectedPath(""), false);
  });
});

describe("authorizationFrom", () => {
  test("an unset variable authorises nothing, and says how to set one", () => {
    const result = authorizationFrom({});
    assert.equal(result.granted, false);
    assert.match(result.detail, new RegExp(AUTHORIZATION_ENV));
  });

  test("an empty or whitespace-only variable is not consent", () => {
    assert.equal(authorizationFrom({ [AUTHORIZATION_ENV]: "   " }).granted, false);
  });

  test("a reason too short to read back later is refused, with its length", () => {
    const result = authorizationFrom({ [AUTHORIZATION_ENV]: "yes" });
    assert.equal(result.granted, false);
    assert.match(result.detail, new RegExp(`at least ${MIN_REASON_CHARS}`));
  });

  test("a reason long enough is granted, and carried", () => {
    const reason = "re-run the guard suite after a runner image change";
    const result = authorizationFrom({ [AUTHORIZATION_ENV]: reason });
    assert.equal(result.granted, true);
    assert.equal(result.reason, reason);
    assert.equal(result.source, `$${AUTHORIZATION_ENV}`);
  });

  test("the command-line flag is an authorisation too, and is named as one", () => {
    const result = authorizationFrom({}, "update the CI job that runs the guard");
    assert.equal(result.granted, true);
    assert.equal(result.source, "--allow-workflow");
    assert.equal(authorizationFrom({}, "short").granted, false);
  });
});

describe("parseOutgoingLog", () => {
  test("tells commit ids apart from paths", () => {
    const parsed = parseOutgoingLog(`${"a".repeat(40)}\n\nREADME.md\n${PROTECTED_DIR}/ci.yml\n`);
    assert.deepEqual(parsed.commits, ["a".repeat(40)]);
    assert.deepEqual(parsed.paths, ["README.md", `${PROTECTED_DIR}/ci.yml`]);
  });

  test("no output is no commits and no paths", () => {
    assert.deepEqual(parseOutgoingLog(""), { commits: [], paths: [] });
  });
});

/* --------------------------------- deciding ------------------------------- */

const update = (overrides = {}) => ({
  localRef: "refs/heads/main",
  localSha: "a".repeat(40),
  remoteRef: "refs/heads/main",
  remoteSha: "b".repeat(40),
  deletion: false,
  outgoing: { commits: ["c".repeat(40)], paths: ["README.md"], baseSource: "the remote's current bbbbbbb is in this checkout" },
  ...overrides,
});

const checkFor = (checks, fragment) => checks.find((check) => check.name.includes(fragment)) ?? {};

describe("assessPush", () => {
  test("an ordinary push passes, and asks for no authorisation at all", () => {
    const result = assessPush({ remote: "origin", url: "https://example.invalid/o/r.git", updates: [update()] });
    assert.equal(result.allowed, true);
    assert.match(checkFor(result.checks, "files were established").detail, /none changes/);
    assert.equal(checkFor(result.checks, "no unauthorised change").status, "skip");
    assert.equal(result.audit.needed, false);
  });

  test("a workflow change is refused, names the file, and says what authorises it", () => {
    const result = assessPush({ updates: [update({ outgoing: { commits: ["c".repeat(40)], paths: [WORKFLOW], baseSource: "x" } })] });
    assert.equal(result.allowed, false);
    const failed = checkFor(result.checks, "no unauthorised change");
    assert.equal(failed.status, "fail");
    assert.match(failed.detail, new RegExp(AUTHORIZATION_ENV.replace(/[$]/g, "\\$")));
    assert.match(failed.detail, new RegExp(`${PROTECTED_DIR}/ci\\.yml`));
  });

  test("a reason long enough authorises it, and is what the audit line will carry", () => {
    const reason = "add a job that runs the push guard suite";
    const result = assessPush({
      updates: [update({ outgoing: { commits: ["c".repeat(40)], paths: [WORKFLOW], baseSource: "x" } })],
      authorization: authorizationFrom({ [AUTHORIZATION_ENV]: reason }),
    });
    assert.equal(result.allowed, true);
    const gate = checkFor(result.checks, "no unauthorised change");
    assert.equal(gate.status, "pass");
    assert.match(gate.detail, /the push changes \.github\/workflows\/ci\.yml/);
    assert.ok(gate.detail.includes(JSON.stringify(reason)));
    assert.equal(result.audit.needed, true);
    assert.equal(result.audit.reason, reason);
    assert.equal(result.audit.files, WORKFLOW);
  });

  test("a deletion sends no commits and is allowed", () => {
    const result = assessPush({ updates: [update({ deletion: true, outgoing: { commits: [], paths: [] } })] });
    assert.equal(result.allowed, true);
    assert.match(checkFor(result.checks, "outgoing commits were identified").detail, /deletion|no commits/);
  });

  test("a hook line that could not be read refuses, because nothing could be judged", () => {
    const result = assessPush({ updates: [], unreadable: ["garbage"] });
    assert.equal(result.allowed, false);
    assert.equal(checkFor(result.checks, "pre-push input").status, "fail");
  });

  test("an empty push has nothing to send and is allowed", () => {
    const result = assessPush({ updates: [] });
    assert.equal(result.allowed, true);
    assert.match(checkFor(result.checks, "pre-push input").detail, /nothing to send/);
  });

  test("commits that cannot be established refuse on an existing ref with a workflow file in the tree", () => {
    const result = assessPush({ updates: [update({ outgoing: { unknown: true, treeHasWorkflow: true, commits: [], paths: [] } })] });
    assert.equal(result.allowed, false);
    assert.equal(checkFor(result.checks, "outgoing commits were identified").status, "skip");
    assert.equal(checkFor(result.checks, "files were established").status, "skip");
    const failed = checkFor(result.checks, "no unauthorised change");
    assert.equal(failed.status, "fail");
    assert.match(failed.detail, /could not be ruled out/);
  });

  test("the same unknown state is allowed when the pushed tree has no workflow file", () => {
    const result = assessPush({ updates: [update({ outgoing: { unknown: true, treeHasWorkflow: false, commits: [], paths: [] } })] });
    assert.equal(result.allowed, true);
    assert.match(checkFor(result.checks, "files were established").detail, /no \.github\/workflows\/ file at all/);
    assert.equal(checkFor(result.checks, "no unauthorised change").status, "skip");

    // A tree that could not be read is a question that failed, and a failed
    // question is not the same answer as "there is no workflow file here".
    const unreadable = assessPush({ updates: [update({ outgoing: { unknown: true, treeHasWorkflow: null, commits: [], paths: [] } })] });
    assert.equal(unreadable.allowed, false);
    assert.match(checkFor(unreadable.checks, "files were established").detail, /tree being pushed could not be read/);
  });

  test("the same unknown state is allowed once it is authorised, and will be recorded", () => {
    const result = assessPush({
      updates: [update({ outgoing: { unknown: true, treeHasWorkflow: true, commits: [], paths: [] } })],
      authorization: authorizationFrom({ [AUTHORIZATION_ENV]: "the first push of a mirror of this repository" }),
    });
    assert.equal(result.allowed, true);
    assert.equal(result.audit.needed, true);
  });

  test("a ref the remote does not have yet is allowed, and reported as a creation", () => {
    const newRef = update({
      remoteSha: "0".repeat(40),
      outgoing: { unknown: true, treeHasWorkflow: true, commits: [], paths: [] },
    });
    const result = assessPush({ remote: "backup", updates: [newRef] });
    assert.equal(result.allowed, true);
    assert.equal(result.audit.needed, false, "nothing is authorised, so nothing is recorded");
    const gate = checkFor(result.checks, "no unauthorised change");
    assert.equal(gate.status, "skip");
    assert.match(gate.detail, /does not exist on backup yet, so this push creates it/);
    assert.match(gate.detail, /is whatever the history being sent contains, not an edit this checkout made/);
  });

  test("an existing ref with a missing value refuses, and fetching is the remedy named", () => {
    const result = assessPush({ updates: [update({ remoteSha: "b".repeat(40), outgoing: { unknown: true, treeHasWorkflow: true, commits: [], paths: [] } })] });
    assert.equal(result.allowed, false);
    const gate = checkFor(result.checks, "no unauthorised change");
    assert.equal(gate.status, "fail");
    assert.match(gate.detail, new RegExp(`refs/heads/main`));
    assert.match(checkFor(result.checks, "outgoing commits were identified").detail, /git fetch origin/);
  });

  test("what decided the push is stated, and it is not a probe", () => {
    const result = assessPush({ updates: [update()] });
    const check = checkFor(result.checks, "nothing was probed");
    assert.equal(check.status, "pass");
    assert.match(check.detail, /no --dry-run/);
    assert.match(check.detail, /verify:credential/);
  });

  test("a remote URL with a token in it never reaches the report", () => {
    const result = assessPush({ remote: "origin", url: "https://user:ghp_neverPrintMe@example.invalid/o/r.git", updates: [update()] });
    const text = JSON.stringify(result.checks);
    assert.ok(!text.includes("ghp_neverPrintMe"));
    assert.match(checkFor(result.checks, "destination").detail, /<redacted>@/);
  });
});

/* ---------------------------- real repositories --------------------------- */

describe("the guard against real repositories", () => {
  test("an ordinary push is allowed, and writes no audit line", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { "README.md": "# scratch\nmore\n" }, "an ordinary change");

    const result = hookRun(fixture);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /none changes \.github\/workflows\//);
    assert.match(result.out, /no unauthorised workflow change is leaving/);
    assert.deepEqual(auditLines(fixture.work), []);
  });

  test("a change to the workflow file is blocked when it is not authorised", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  extra: {}\n" }, "an unauthorised workflow change");

    const result = hookRun(fixture);
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`${PROTECTED_DIR}/ci\\.yml`));
    assert.match(result.out, new RegExp(AUTHORIZATION_ENV));
    assert.match(result.out, /refused, nothing was pushed/);
    assert.deepEqual(auditLines(fixture.work), []);
  });

  test("unrelated files alongside the workflow change do not make it acceptable", () => {
    const fixture = seeded();
    commitFiles(
      fixture.work,
      { [WORKFLOW]: "name: CI\non: push\njobs:\n  extra: {}\n", "docs/notes.md": "unrelated\n" },
      "a workflow change with company"
    );

    const result = hookRun(fixture);
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`${PROTECTED_DIR}/ci\\.yml`));
  });

  test("a workflow change in an earlier commit of a multi-commit push is still found", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  extra: {}\n" }, "the workflow change, first");
    commitFiles(fixture.work, { "README.md": "# scratch\ntja\n" }, "an ordinary change, second");
    const outgoing = Number(git(["rev-list", "--count", `refs/remotes/origin/main..HEAD`], { cwd: fixture.work }).stdout);

    const result = hookRun(fixture);
    assert.equal(outgoing, 2);
    assert.equal(result.code, 1);
    assert.match(result.out, /2 commit\(s\) not already on origin/);
    assert.match(result.out, /1 of them change \.github\/workflows\/ci\.yml/);
  });

  test("an authorised workflow push is allowed, and the reason is written to the audit line", () => {
    const fixture = seeded();
    const reason = "add a step that runs the push guard suite";
    const head = commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  guard: {}\n" }, "an authorised workflow change");

    const result = hookRun(fixture, { env: { [AUTHORIZATION_ENV]: reason } });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /authorised by \$STRATEGYOPTION_WORKFLOW_PUSH_REASON/);

    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1, "one authorisation, one line");
    assert.match(lines[0], new RegExp(`files=".?${PROTECTED_DIR.replace(/\./g, "\\.")}\\/ci\\.yml`));
    assert.ok(lines[0].includes(JSON.stringify(reason)));
    assert.ok(lines[0].includes(JSON.stringify("refs/heads/main")));
    assert.match(lines[0], /commits=1 /);
    assert.equal(head, git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout);
  });

  test("an authorised workflow push through --explain reports without recording anything", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  guard: {}\n" }, "an authorised workflow change");

    const result = runGuard(["--explain", "--allow-workflow", "explain a workflow change without pushing"], { cwd: fixture.work });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /authorised by --allow-workflow/);
    assert.match(result.out, /no audit line was written/);
    assert.deepEqual(auditLines(fixture.work), []);
  });

  test("--explain refuses a reason that is too short to mean anything", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs: {}\n# x\n" }, "an unauthorised change");
    const result = runGuard(["--explain", "--allow-workflow", "yes"], { cwd: fixture.work });
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`at least ${MIN_REASON_CHARS}`));
  });

  test("a reason with a newline in it cannot forge a second audit line", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  x: {}\n" }, "an authorised change");
    // The reason is the one value in the log that a person types, so it is the
    // one that has to be escaped: a raw newline here would append a second,
    // forged entry claiming whatever the author of the reason likes.
    hookRun(fixture, { env: { [AUTHORIZATION_ENV]: "authorised: a runner image change\n2020-01-01 remote=\"evil\" reason=\"not the real one\"" } });
    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1, `the log must stay one line per authorisation:\n${lines.join("\n")}`);
    assert.match(lines[0], /reason="authorised: a runner image change\\n/);
  });

  test("the audit line is refused when it cannot be written, and the push with it", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  x: {}\n" }, "an authorised change");

    // A directory where the log should be: the write fails for a reason no
    // platform-specific permission trick is needed to reproduce.
    const blocked = join(fixture.root, "a-directory");
    mkdirSync(blocked, { recursive: true });
    const result = hookRun(fixture, {
      env: { [AUTHORIZATION_ENV]: "an authorised workflow change, nowhere to record it", STRATEGYOPTION_PUSH_GUARD_LOG: blocked },
    });
    assert.equal(result.code, 1);
    assert.match(result.out, /cannot be recorded is not one/);
  });

  test("a deletion is allowed even though the branch has workflow history", () => {
    const fixture = seeded();
    const result = hookRun(fixture, {
      localRef: "(delete)",
      localSha: "0".repeat(40),
      remoteRef: "refs/heads/old",
      remoteSha: "0".repeat(40),
    });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /deletes ref|deletion/);
  });

  test("a push that sends nothing new is allowed", () => {
    const fixture = seeded();
    const head = git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout;
    const result = hookRun(fixture, { localSha: head, remoteSha: head });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /nothing new/);
  });

  test("a hook line that is not in git's format refuses the push", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { "README.md": "# scratch\ngarbage test\n" }, "an ordinary change behind a garbled hook line");
    const result = runGuard(["--hook", "origin", fixture.remotePath], { cwd: fixture.work, input: "garbage\n" });
    assert.equal(result.code, 1);
    assert.match(result.out, /four-field form/);
  });

  test("a detached HEAD is judged by the commit, not by a branch name", () => {
    const fixture = seeded();
    git(["checkout", "-q", "--detach"], { cwd: fixture.work });
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  y: {}\n" }, "a workflow change from a detached HEAD");

    const result = hookRun(fixture, { localRef: "HEAD" });
    assert.equal(result.code, 1);
    assert.match(result.out, new RegExp(`${PROTECTED_DIR}/ci\\.yml`));
    assert.match(result.out, /HEAD/);
  });

  test("an unusual branch name and a tag are judged the same way", () => {
    const fixture = seeded();
    git(["checkout", "-q", "-b", "release/2.0"], { cwd: fixture.work });
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  z: {}\n" }, "a workflow change on a slash branch");

    const onBranch = hookRun(fixture, { localRef: "refs/heads/release/2.0", remoteRef: "refs/heads/release/2.0", remoteSha: "0".repeat(40) });
    assert.equal(onBranch.code, 1);

    git(["tag", "v1"], { cwd: fixture.work });
    const onTag = hookRun(fixture, { localRef: "refs/tags/v1", remoteRef: "refs/tags/v1", remoteSha: "0".repeat(40) });
    assert.equal(onTag.code, 1);

    const head = git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout;
    const deletion = hookRun(fixture, { localRef: "(delete)", localSha: "0".repeat(40), remoteRef: "refs/heads/release/2.0", remoteSha: head });
    assert.equal(deletion.code, 0, deletion.out + deletion.err);
  });

  test("a first push to a remote whose ref does not exist yet is allowed, and says why", () => {
    const remote = seeded();
    const root = scratchRepo();
    const fresh = join(root, "fresh");
    git(["init", "-q", "-b", "main", fresh]);
    git(["remote", "add", "origin", remote.remotePath], { cwd: fresh });
    commitFiles(fresh, { [WORKFLOW]: "name: CI\non: push\njobs: {}\n" }, "first commit of a fresh checkout");

    // A ref the remote does not have is not an edit to anything: the push makes
    // it, and the workflow file in it is the history being sent. Refusing this
    // would block every first push of an existing history to a new remote — so
    // it is reported, and GitHub's own permission is what governs it there.
    const firstPush = runGuard(["--hook", "origin", remote.remotePath], {
      cwd: fresh,
      input: `refs/heads/main ${git(["rev-parse", "HEAD"], { cwd: fresh }).stdout} refs/heads/main ${"0".repeat(40)}\n`,
    });
    assert.equal(firstPush.code, 0, firstPush.out + firstPush.err);
    assert.match(firstPush.out, /does not exist on origin yet, so this push creates it/);
    assert.match(firstPush.out, /verify:credential/);
    assert.deepEqual(auditLines(fresh), [], "nothing was authorised, so nothing is audited");
  });

  test("a workflow change on an existing remote ref whose value is missing is refused, and told to fetch", () => {
    const root = scratchRepo();
    const fresh = join(root, "fresh");
    git(["init", "-q", "-b", "main", fresh]);
    commitFiles(fresh, { [WORKFLOW]: "name: CI\non: push\njobs:\n  fetch: {}\n" }, "a workflow file in a checkout with no remote at all");
    const head = git(["rev-parse", "HEAD"], { cwd: fresh }).stdout;
    const refLine = `refs/heads/main ${head} refs/heads/main ${"b".repeat(40)}`;

    // The remote has this ref — its value is not zeros — and this checkout has
    // never seen that value. Unlike a ref that does not exist yet, this question
    // is answerable, so the answer is not "go ahead": fetch, then push.
    const refused = runGuard(["--hook", "origin", "https://example.invalid/o/r.git"], { cwd: fresh, input: `${refLine}\n` });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /exists there and this checkout has no value for it/);
    assert.match(refused.out, /git fetch origin/);

    const authorised = runGuard(["--hook", "origin", "https://example.invalid/o/r.git"], {
      cwd: fresh,
      input: `${refLine}\n`,
      env: { [AUTHORIZATION_ENV]: "pushing over a ref this checkout has not fetched" },
    });
    assert.equal(authorised.code, 0, authorised.out + authorised.err);
    assert.equal(auditLines(fresh).length, 1);
  });

  test("a checkout whose tree has no workflow file is allowed even without a fetch", () => {
    const root = scratchRepo();
    const fresh = join(root, "fresh");
    git(["init", "-q", "-b", "main", fresh]);
    commitFiles(fresh, { "README.md": "# nothing to protect here\n" }, "a repository with no workflow file at all");

    const result = runGuard(["--hook", "origin", join(root, "nowhere.git")], {
      cwd: fresh,
      input: `refs/heads/main ${git(["rev-parse", "HEAD"], { cwd: fresh }).stdout} refs/heads/main ${"0".repeat(40)}\n`,
    });
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /no \.github\/workflows\/ file at all/);
  });

  test("an invalid remote name does not crash the guard", () => {
    const fixture = seeded();
    const result = runGuard(["--hook", "not-a-remote", "https://example.invalid/o/r.git"], {
      cwd: fixture.work,
      input: `refs/heads/main ${git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout} refs/heads/main ${fixture.remoteMain()}\n`,
    });
    // The remote's own sha is in the checkout, so the answer is exact despite the
    // name being nonsense — and either way it must decide rather than throw.
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /the destination was identified/);
    assert.ok(!/could not decide/.test(result.out + result.err));
  });

  test("outside a git repository the guard refuses instead of deciding", () => {
    const outside = scratchRepo();
    const result = runGuard(["--explain"], { cwd: outside });
    assert.equal(result.code, 1);
    assert.match(result.err, /not a git working tree/);
  });

  test("existing user changes and the checkout's state survive a run", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { "README.md": "# scratch\nwith an edit\n" }, "an ordinary change");
    writeFileSync(join(fixture.work, "README.md"), "# scratch\nan edit nobody committed\n");
    writeFileSync(join(fixture.work, "untracked.txt"), "mine\n");
    const before = {
      status: git(["status", "--porcelain"], { cwd: fixture.work }).stdout,
      head: git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout,
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.work }).stdout,
      refs: git(["show-ref"], { cwd: fixture.work }).stdout,
    };

    hookRun(fixture);

    assert.equal(readFileSync(join(fixture.work, "README.md"), "utf8"), "# scratch\nan edit nobody committed\n");
    assert.equal(readFileSync(join(fixture.work, "untracked.txt"), "utf8"), "mine\n");
    assert.equal(git(["status", "--porcelain"], { cwd: fixture.work }).stdout, before.status);
    assert.equal(git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout, before.head);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.work }).stdout, before.branch);
    assert.equal(git(["show-ref"], { cwd: fixture.work }).stdout, before.refs);
  });

  test("a commit that cannot be read and a remote that cannot be read both refuse", () => {
    const fixture = seeded();
    const missing = "a".repeat(40);

    // The remote's sha is in the checkout, so the log is attempted and fails: the
    // guard could not decide, and says exactly that rather than reporting a clean
    // push nothing examined.
    const undecidable = hookRun(fixture, { localSha: missing });
    assert.equal(undecidable.code, 1);
    assert.match(undecidable.err, /could not decide/);

    // Nothing about the remote is known either, so the tree check is what fails —
    // and a check that failed is never read as "there is nothing there".
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);
    const unreadableTree = runGuard(["--hook", "origin", join(root, "missing.git")], {
      cwd: root,
      input: `refs/heads/main ${missing} refs/heads/main ${"b".repeat(40)}\n`,
    });
    assert.equal(unreadableTree.code, 1);
    assert.match(unreadableTree.out, /could not be read|cannot be told/);
    assert.match(unreadableTree.out, /no unauthorised change/);
  });

  test("the guard issues only read-only git commands", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  w: {}\n" }, "a workflow change");

    // Every command the gathering issues is recorded, then run for real, so the
    // decision below is still made from this repository's actual history.
    const recorded = [];
    const run = (args) => {
      recorded.push(args);
      return git(args, { cwd: fixture.work }).stdout;
    };
    const gathered = gatherPush({
      remote: "origin",
      refUpdates: [
        {
          localRef: "refs/heads/main",
          localSha: git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout,
          remoteRef: "refs/heads/main",
          remoteSha: fixture.remoteMain(),
          deletion: false,
        },
      ],
      run,
    });

    assert.ok(recorded.length > 0);
    const writes = recorded.filter((args) => /^(push|ls-remote|fetch|credential|remote|update-ref|commit|config|tag|checkout)$/.test(args[0]));
    assert.deepEqual(writes, [], `the guard must not run these: ${JSON.stringify(writes)}`);
    const readsAllowed = new Set(["cat-file", "for-each-ref", "ls-tree", "log", "rev-parse", "rev-list", "show-ref"]);
    const unexpected = recorded.filter((args) => !readsAllowed.has(args[0]));
    assert.deepEqual(unexpected, [], `the guard asked git something it does not need: ${JSON.stringify(unexpected)}`);
    const result = assessPush({ remote: "origin", url: fixture.remotePath, updates: gathered.updates });
    assert.equal(result.allowed, false, "the recorded run still decides from real history");
  });

  test("no credential value reaches the report, and none reaches the audit line", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  q: {}\n" }, "an authorised workflow change");
    const secret = "ghp_ThisMustNeverBePrinted1234567890";

    const result = hookRun(fixture, {
      url: `https://justcallmedavy-art:${secret}@example.invalid/owner/repo.git`,
      env: { [AUTHORIZATION_ENV]: "a workflow change with a token in the remote URL" },
    });

    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /<redacted>@/);
    for (const text of [result.out, result.err, ...auditLines(fixture.work)]) {
      assert.ok(!text.includes(secret), `a credential reached the output:\n${text}`);
      assert.ok(!text.includes("ghp_"), "no token-shaped string belongs in the report");
    }
  });
});

/* -------------------------------- end to end ------------------------------ */

/**
 * The committed hook, run by git itself. `core.hooksPath` points this checkout's
 * `.githooks` directory at a throwaway repository, so what runs here is
 * byte-for-byte the file a developer installs — and whether the push lands is
 * read off the bare remote afterwards rather than inferred from an exit status.
 */
describe("git push, through the committed hook", () => {
  const withHook = (fixture) => {
    git(["config", "core.hooksPath", HOOKS], { cwd: fixture.work });
    return fixture;
  };
  const pushed = (fixture, env = {}) => git(["push", "origin", "main"], { cwd: fixture.work, env, allowFailure: true });
  const remoteMain = (fixture) => git(["ls-remote", "--heads", fixture.remotePath, "main"], { allowFailure: true }).stdout;

  test("an ordinary push goes through and lands on the remote", () => {
    const fixture = withHook(seeded());
    const head = commitFiles(fixture.work, { "README.md": "# scratch\npushed for real\n" }, "an ordinary change");

    const result = pushed(fixture);
    assert.equal(result.code, 0, result.stderr);
    assert.match(remoteMain(fixture), new RegExp(`^${head}\\s+refs/heads/main$`));
  });

  test("a workflow push is refused, and nothing arrives on the remote", () => {
    const fixture = withHook(seeded());
    const before = remoteMain(fixture);
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  hook: {}\n" }, "a workflow change nobody authorised");

    const result = pushed(fixture);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}${result.stderr}`, /is authorised|refused/);
    assert.equal(remoteMain(fixture), before, "the remote must be exactly as it was");
    assert.deepEqual(auditLines(fixture.work), []);
  });

  test("the same push goes through when the reason is given, and is recorded", () => {
    const fixture = withHook(seeded());
    const reason = "add a hook coverage job to CI on purpose";
    const head = commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  hook: {}\n" }, "an authorised workflow change");

    const result = pushed(fixture, { [AUTHORIZATION_ENV]: reason });
    assert.equal(result.code, 0, result.stderr);
    assert.match(remoteMain(fixture), new RegExp(`^${head}\\s+refs/heads/main$`));
    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(JSON.stringify(reason)));
  });

  test("--no-verify still bypasses the hook, because git's own escape hatch is not hidden", () => {
    const fixture = withHook(seeded());
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  bypass: {}\n" }, "a workflow change pushed past the hook");
    const result = git(["push", "--no-verify", "origin", "main"], { cwd: fixture.work, allowFailure: true });
    assert.equal(result.code, 0, result.stderr);
  });
});

/* --------------------------------- install -------------------------------- */

describe("installing and inspecting the guard", () => {
  test("--install sets hooksPath, is idempotent, and --uninstall undoes it", () => {
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);

    const before = runGuard(["--status"], { cwd: root });
    assert.equal(before.code, 0);
    assert.match(before.out, /\(unset/);

    const install = runGuard(["--install"], { cwd: root });
    assert.equal(install.code, 0, install.err);
    assert.equal(git(["config", "--get", "core.hooksPath"], { cwd: root, allowFailure: true }).stdout, ".githooks");

    const again = runGuard(["--install"], { cwd: root });
    assert.equal(again.code, 0);
    assert.match(again.out, /already installed/);

    const after = runGuard(["--status"], { cwd: root });
    assert.match(after.out, /the guard runs on every push/);

    const uninstall = runGuard(["--uninstall"], { cwd: root });
    assert.equal(uninstall.code, 0);
    assert.equal(git(["config", "--get", "core.hooksPath"], { cwd: root, allowFailure: true }).code, 1);
  });

  test("--install refuses to overwrite a hooks path it did not set", () => {
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);
    git(["config", "core.hooksPath", "somewhere/else"], { cwd: root });

    const result = runGuard(["--install"], { cwd: root });
    assert.equal(result.code, 1);
    assert.match(result.err, /refusing to overwrite/);
    assert.equal(git(["config", "--get", "core.hooksPath"], { cwd: root }).stdout, "somewhere/else");
  });

  test("--uninstall leaves a hooks path it did not set alone", () => {
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);
    git(["config", "core.hooksPath", "somewhere/else"], { cwd: root });
    const result = runGuard(["--uninstall"], { cwd: root });
    assert.equal(result.code, 0);
    assert.match(result.out, /leaving core.hooksPath alone/);
    assert.equal(git(["config", "--get", "core.hooksPath"], { cwd: root }).stdout, "somewhere/else");
  });

  test("the hook refuses the push when node is not on PATH", (t) => {
    // The hook's whole job is to be the last thing between a misunderstanding and
    // GitHub, so a machine that cannot run the guard must not push quietly. An
    // empty PATH is exactly that machine.
    const nothingOnThisPath = join(scratch, "a-path-with-nothing-on-it");
    mkdirSync(nothingOnThisPath, { recursive: true });
    const result = runHook(join(HOOKS, "pre-push"), { env: { PATH: nothingOnThisPath } });
    if (result.missingShell) return t.skip("no sh on this machine to run the hook script with");
    assert.equal(result.code, 1);
    assert.match(`${result.out}${result.err}`, /node is not on PATH/);
  });

  test("the hook refuses the push when the guard tool is not there", (t) => {
    const root = scratchRepo();
    mkdirSync(join(root, ".githooks"), { recursive: true });
    copyFileSync(join(HOOKS, "pre-push"), join(root, ".githooks", "pre-push"));
    const result = runHook(join(root, ".githooks", "pre-push"));
    if (result.missingShell) return t.skip("no sh on this machine to run the hook script with");
    assert.equal(result.code, 1);
    assert.match(`${result.out}${result.err}`, /is missing/);
  });

  test("the committed hook exists and is executable for a POSIX checkout", () => {
    const hook = join(HOOKS, "pre-push");
    assert.ok(existsSync(hook), `${hook} is what --install points git at`);
    if (process.platform !== "win32") {
      // Windows ignores the bit — git runs hooks through its own sh there — but a
      // POSIX checkout skips a hook that is not executable, silently.
      assert.ok(statSync(hook).mode & 0o111, `${hook} must be executable or git will skip it`);
    }
  });

  test("a temporary repository is removed again, which is what the cleanup relies on", () => {
    // Registered like every other fixture, then removed here — so this test
    // measures the same disposal the cleanup depends on, and leaves nothing
    // behind even if it fails.
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);
    commitFiles(root, { "README.md": "# gone shortly\n" }, "a commit so the object store is not empty");
    dispose(root);
    assert.equal(existsSync(root), false);
  });
});

/* ---------------------------- the authorisation trail --------------------- */

/**
 * What the trail says — and, just as much, what it does not say.
 *
 * Every fixture is produced by the writer itself wherever the format allows, so
 * these tests fail when the format and the reader drift apart rather than when a
 * hand-typed string stops matching an implementation detail. The two failures
 * worth writing down are the two a reader of an audit trail could ship with:
 * reporting a line it could not read as an authorisation, and printing a value
 * that forges a line of its own.
 *
 * Likewise the exit statuses are deliberate. Listing a trail that contains a
 * broken line succeeds, because reading it is not a verification and a reader
 * that refuses to show you a damaged file is a reader you cannot use to find out
 * why it is damaged; `--check` is the verification, and that one fails.
 */
describe("reading the authorisation trail", () => {
  test("a checkout with no trail says so, and verifying nothing passes", () => {
    const root = scratchRepo();
    git(["init", "-q", "-b", "main", root]);

    const listed = runGuard(["--audit"], { cwd: root });
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /records {2}: none/);

    const checked = runGuard(["--audit", "--check"], { cwd: root });
    assert.equal(checked.code, 0, checked.out + checked.err);
    assert.match(checked.out, /PASS — nothing is recorded/);
  });

  test("an empty trail reads as no records rather than as a broken one", () => {
    const path = trailWith("");
    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /and empty/);
    assert.match(listed.out, /records {2}: none/);
    assert.equal(runAudit(path, ["--check"]).code, 0);
  });

  test("an authorisation and a refusal are told apart, counted, and listed newest first", () => {
    const path = trailWith(`${authorised()}\n${refused()}\n`);
    const result = runAudit(path);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /records {2}: 2 — authorised 1, refused 1, malformed 0, incomplete 0/);
    assert.match(result.out, /#1 {2}\S+ {2}authorised/);
    assert.match(result.out, /#2 {2}\S+ {2}refused/);
    assert.ok(result.out.indexOf("#2") < result.out.indexOf("#1"), "the newest record is listed first");
    assert.match(result.out, /reason "a workflow change that was intended"/);
  });

  test("a record the guard writes now names its kind, so nothing has to be inferred", () => {
    const fixture = seeded();
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  k: {}\n" }, "an authorised workflow change");
    const result = hookRun(fixture, { env: { [AUTHORIZATION_ENV]: "record the kind on the audit line" } });
    assert.equal(result.code, 0, result.out + result.err);

    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\S+ kind="authorised" remote="origin" /);

    const audit = runGuard(["--audit"], { cwd: fixture.work });
    assert.equal(audit.code, 0, audit.out + audit.err);
    assert.match(audit.out, /records {2}: 1 — authorised 1, refused 0, malformed 0, incomplete 0/);
    assert.ok(!/legacy/.test(audit.out), `a record written now is not a legacy one:\n${audit.out}`);
    assert.equal(runGuard(["--audit", "--check"], { cwd: fixture.work }).code, 0);
  });

  test("the line this repository actually holds reads as one authorisation", () => {
    // Verbatim from .git/strategyoption-push-guard.log: the shape every record on
    // disk has, which is also the shape the reader has to be able to read
    // without reinterpreting it as something it was not.
    const path = trailWith(
      '2026-10-16T16:15:34.072Z remote="guardprobe" refs="refs/heads/main" commits=1 files=".github/workflows/ci.yml" source="$STRATEGYOPTION_WORKFLOW_PUSH_REASON" reason="prove the guard end to end against a throwaway local remote"\n'
    );
    const result = runAudit(path);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /records {2}: 1 — authorised 1, refused 0, malformed 0, incomplete 0/);
    assert.match(result.out, /#1 {2}2026-10-16T16:15:34\.072Z {2}authorised \(legacy record\)/);
    assert.match(result.out, /written before the kind= field existed/);
    assert.match(result.out, /refs\/heads\/main/);
    assert.equal(runAudit(path, ["--check"]).code, 0, "a legacy record is readable, so it is not a failure");
  });

  test("--outcome filters the listing, and never hides a record that could not be read", () => {
    const path = trailWith(`${authorised()}\n${refused()}\nthis is not a record at all\n`);

    const onlyRefused = runAudit(path, ["--outcome", "refused"]);
    assert.equal(onlyRefused.code, 0, onlyRefused.out + onlyRefused.err);
    assert.match(onlyRefused.out, /records {2}: 3 — authorised 1, refused 1, malformed 1, incomplete 0/, "the totals are the file's, not the filter's");
    assert.ok(!/#1 /.test(onlyRefused.out), `the authorised record must not be listed:\n${onlyRefused.out}`);
    assert.match(onlyRefused.out, /#3 {2}\S+ {2}malformed/, "a line that cannot be read is never filtered away");

    const onlyAuthorised = runAudit(path, ["--outcome", "authorised"]);
    assert.match(onlyAuthorised.out, /#1 {2}/);
    assert.ok(!/#2 /.test(onlyAuthorised.out));
    assert.match(onlyAuthorised.out, /#3 {2}\S+ {2}malformed/);
  });

  test("--limit keeps the newest records and says how many it left out", () => {
    const path = trailWith(`${authorised()}\n${authorised({ when: instant(1) })}\n${authorised({ when: instant(2) })}\n`);

    const one = runAudit(path, ["--limit", "1"]);
    assert.equal(one.code, 0, one.out + one.err);
    assert.match(one.out, /#3 {2}/, "the newest record is the one kept");
    assert.ok(!/#1 /.test(one.out));
    assert.match(one.out, /2 more record\(s\) not listed/);
    assert.match(one.out, /records {2}: 3 /, "the totals still cover the whole file");

    const every = runAudit(path, ["--limit", "all"]);
    for (const index of [1, 2, 3]) assert.match(every.out, new RegExp(`#${index} {2}`));
    assert.ok(!/more record\(s\) not listed/.test(every.out));
  });

  test("the default listing is bounded, and is the bound the usage text names", () => {
    const lines = Array.from({ length: AUDIT_DEFAULT_LIMIT + 1 }, (_, index) =>
      authorised({ when: instant(index), reason: `intended workflow change number ${index}` })
    );
    const path = trailWith(`${lines.join("\n")}\n`);

    const result = runAudit(path);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, new RegExp(`#${AUDIT_DEFAULT_LIMIT + 1} {2}`));
    assert.ok(!/#1 /.test(result.out));
    assert.match(result.out, /1 more record\(s\) not listed/);
    assert.match(
      runGuard(["--help"]).out,
      new RegExp(`default\\s+${AUDIT_DEFAULT_LIMIT}\\)`),
      "the usage text has to name the default it applies"
    );
  });

  test("a line that is not a record is malformed, shown, and failed", () => {
    const path = trailWith(`${authorised()}\nthis is not a record at all\n`);

    const listed = runAudit(path);
    assert.equal(listed.code, 0, "reading a damaged trail is not itself a verification");
    assert.match(listed.out, /#2 {2}\S+ {2}malformed/);
    assert.match(listed.out, /is not a date/);
    assert.match(listed.out, /text that is not a field/);
    assert.match(listed.out, /the line, verbatim: this is not a record at all/);

    const checked = runAudit(path, ["--check"]);
    assert.equal(checked.code, 1, "an explicitly requested verification fails on an unreadable line");
    assert.match(checked.out, /FAIL  every record could be read/);
    assert.match(checked.out, /FAILED — 1 check\(s\)/);
    assert.match(checked.out, /checked all 2 record\(s\) in the file/);
  });

  test("a record cut short mid-field is malformed rather than half-read", () => {
    const path = trailWith(`${authorised({ when: instant(4) }).slice(0, 45)}\n`);
    const result = runAudit(path);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /malformed 1/);
    assert.match(result.out, /text that is not a field/);
    assert.equal(runAudit(path, ["--check"]).code, 1);
  });

  test("a record missing a field, and one whose write lost its last newline, are incomplete", () => {
    const missingAField = authorised().replace(/ reason="[^"]*"/, "");
    const noTerminator = authorised({ when: instant(3) });
    const path = trailWith(`${authorised()}\n${missingAField}\n${noTerminator}`);

    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /records {2}: 3 — authorised 1, refused 0, malformed 0, incomplete 2/);
    assert.match(listed.out, /#2 {2}\S+ {2}incomplete/);
    assert.match(listed.out, /#3 {2}\S+ {2}incomplete/);
    assert.match(listed.out, /reason\b/, "the missing field is named");
    assert.match(listed.out, /the line has no terminator/);
    assert.match(listed.out, /reason \(missing\)/);

    const checked = runAudit(path, ["--check"]);
    assert.equal(checked.code, 1);
    assert.match(checked.out, /FAIL  every record is complete/);
  });

  test("a kind this tool does not write is malformed, not quietly an authorisation", () => {
    const path = trailWith(`${authorised({ kind: "reviewed" })}\n`);
    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /malformed 1/);
    assert.match(listed.out, /is not one of authorised, refused/);
    assert.equal(runAudit(path, ["--check"]).code, 1);
  });

  test("a path an authorisation cannot cover is reported, and fails verification", () => {
    const path = trailWith(`${authorised({ files: "docs/notes.md" })}\n`);
    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /the record names docs\/notes\.md/);
    assert.equal(runAudit(path, ["--check"]).code, 1);
    assert.match(runAudit(path, ["--check"]).out, /FAIL  every recorded path is under/);
  });

  test("an empty files value is a shape, not a gap, and is not a failure", () => {
    // What an authorisation over a ref this checkout has never fetched records:
    // the change could not be established, which is why the reason is required.
    const path = trailWith(`${authorised({ files: "", commits: 0, reason: "pushing over a ref this checkout has not fetched" })}\n`);
    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.match(listed.out, /files  \(none named — the change it covered was not established\)/);
    assert.match(listed.out, /0 commit\(s\)/, "the count it does carry is printed as written");
    assert.equal(runAudit(path, ["--check"]).code, 0);
  });

  test("a push to a URL carrying a token records no credential", () => {
    const fixture = seeded();
    const secret = "ghp_AuditMustNeverHoldThis1234567890";
    const destination = `https://justcallmedavy-art:${secret}@example.invalid/owner/repo.git`;
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  t: {}\n" }, "an authorised workflow change");

    // git hands the hook the destination *string*, so a push that names a URL
    // arrives with the URL as the remote's name — measured in the block below.
    const result = runGuard(["--hook", destination, destination], {
      cwd: fixture.work,
      input: `refs/heads/main ${git(["rev-parse", "HEAD"], { cwd: fixture.work }).stdout} refs/heads/main ${fixture.remoteMain()}\n`,
      env: { [AUTHORIZATION_ENV]: "a workflow change pushed to a URL" },
    });
    assert.equal(result.code, 0, result.out + result.err);

    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /remote="https:\/\/<redacted>@example\.invalid\/owner\/repo\.git"/);
    for (const text of [result.out, result.err, ...lines]) {
      assert.ok(!text.includes(secret), `a credential reached the report or the trail:\n${text}`);
    }
  });

  test("a record that already holds a credential is printed redacted, reported, and failed", () => {
    const secret = "ghp_LegacyTrailCredential1234567890";
    const destination = `https://owner:${secret}@example.invalid/owner/repo.git`;
    // Hand-built, because the writer cannot produce this shape any more: it is
    // what a record written before the remote was redacted looks like, and it
    // keeps its kind= absent for the same reason.
    const poisoned = authorised()
      .replace(/ kind="authorised"/, "")
      .replace(/remote="[^"]*"/, `remote=${JSON.stringify(destination)}`);
    assert.ok(poisoned.includes(secret), "the fixture has to be poisoned for this to measure anything");
    const path = trailWith(`${poisoned}\n`);

    const listed = runAudit(path);
    assert.equal(listed.code, 0, listed.out + listed.err);
    assert.ok(!`${listed.out}${listed.err}`.includes(secret), `the report printed a credential:\n${listed.out}`);
    assert.match(listed.out, /<redacted>@example\.invalid/);
    assert.match(listed.out, /the remote value carries userinfo/);

    const checked = runAudit(path, ["--check"]);
    assert.equal(checked.code, 1);
    assert.match(checked.out, /FAIL  no record stores a credential/);

    // The reader reports a credential in the trail; it does not scrub one. The
    // file is the user's, and a tool that quietly rewrites an audit trail is a
    // worse tool than one that says what it found.
    assert.ok(readFileSync(path, "utf8").includes(secret), "the file itself is left exactly as it was found");
  });

  test("a reason carrying a newline cannot forge a line in the report either", () => {
    const forged = "fine\nalso authorised: not really\u001b[31m";
    const path = trailWith(`${authorised({ reason: forged })}\n`);
    const result = runAudit(path);
    assert.equal(result.code, 0, result.out + result.err);
    assert.match(result.out, /fine\\x0aalso authorised: not really\\x1b\[31m/);
    assert.ok(!/^also authorised/m.test(result.out), `a value forged a line:\n${result.out}`);
  });

  test("reading the trail never changes it", () => {
    const path = trailWith(`${authorised()}\n${refused()}\nthis is not a record\n`);
    const before = readFileSync(path);
    const statBefore = statSync(path);

    for (const args of [[], ["--check"], ["--limit", "1"], ["--outcome", "refused"], ["--limit", "all"]]) {
      const result = runAudit(path, args);
      assert.ok(result.code === 0 || result.code === 1, `unexpected exit ${result.code}: ${result.out}${result.err}`);
    }

    assert.deepEqual(readFileSync(path), before, "the bytes must be identical");
    assert.equal(statSync(path).size, statBefore.size);
    assert.equal(statSync(path).mtimeMs, statBefore.mtimeMs, "nothing may write to the file, not even a stat-then-append");
  });

  test("a trail is refused rather than guessed at outside a repository, and read when it is named", () => {
    const dir = scratchRepo();
    const path = join(dir, "strategyoption-push-guard.log");
    writeFileSync(path, `${authorised()}\n`);

    const named = runGuard(["--audit"], { cwd: dir, env: { STRATEGYOPTION_PUSH_GUARD_LOG: path } });
    assert.equal(named.code, 0, named.out + named.err);
    assert.match(named.out, /authorised 1/);

    const unnamed = runGuard(["--audit"], { cwd: dir });
    assert.equal(unnamed.code, 1);
    assert.match(unnamed.err, /no trail to read/);
  });

  test("--audit refuses a flag or a value it cannot honour", () => {
    const path = trailWith(`${authorised()}\n`);
    assert.equal(runAudit(path, ["--bogus"]).code, 2);
    assert.equal(runAudit(path, ["--limit"]).code, 2);
    assert.equal(runAudit(path, ["--limit", "lots"]).code, 2);
    assert.equal(runAudit(path, ["--outcome", "maybe"]).code, 2);
    assert.match(runAudit(path, ["--limit", "lots"]).err, /takes a count or "all"/);
  });

  test("several audits at once see the same trail, because reading takes no lock", async () => {
    const path = trailWith(`${authorised()}\n${refused()}\n`);
    const once = () =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          [GUARD, "--audit"],
          { encoding: "utf8", env: baseEnv({ STRATEGYOPTION_PUSH_GUARD_LOG: path }) },
          (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, out: stdout, err: stderr })
        );
      });

    const results = await Promise.all([once(), once(), once(), once()]);
    for (const result of results) {
      assert.equal(result.code, 0, result.out + result.err);
      assert.equal(result.out, results[0].out);
    }
    assert.equal(readFileSync(path, "utf8"), `${authorised()}\n${refused()}\n`);
  });

  test("records out of timestamp order are reported without failing the check", () => {
    // Each record is one append, so two pushes at the same moment can land in
    // either order: a trailing timestamp is worth reporting and is not by itself
    // evidence that the file was edited.
    const path = trailWith(`${authorised({ when: instant(5) })}\n${refused({ when: instant(1) })}\n`);
    const checked = runAudit(path, ["--check"]);
    assert.equal(checked.code, 0, checked.out + checked.err);
    assert.match(checked.out, /out of timestamp order/);
    assert.match(checked.out, /PASSED/);
  });

  test("git hands the hook the destination string, which is a URL when a URL is pushed", () => {
    const fixture = seeded();
    git(["config", "core.hooksPath", HOOKS], { cwd: fixture.work });
    commitFiles(fixture.work, { [WORKFLOW]: "name: CI\non: push\njobs:\n  u: {}\n" }, "an authorised workflow change");

    // Pushed to the destination itself rather than to the named remote — which
    // is what `git push https://… main` does, and what makes the *redaction* in
    // the writer load-bearing rather than decorative. The push goes to a local
    // bare repository; no host is contacted.
    const result = git(["push", fixture.remotePath, "main"], {
      cwd: fixture.work,
      env: { [AUTHORIZATION_ENV]: "push to the destination instead of the named remote" },
      allowFailure: true,
    });
    assert.equal(result.code, 0, result.stderr);

    const lines = auditLines(fixture.work);
    assert.equal(lines.length, 1);
    const recorded = JSON.parse(lines[0].match(/remote=("(?:[^"\\]|\\.)*")/)[1]);
    assert.notEqual(recorded, "origin");
    assert.ok(recorded.includes("origin.git"), `the trail records the destination git passed:\n${lines[0]}`);
  });
});

describe("reading a trail file's shape", () => {
  test("a trailing newline is the file's shape, and a blank line inside it is not", () => {
    assert.deepEqual(readAuditTrail("").records, []);
    assert.equal(readAuditTrail("").empty, true);
    assert.equal(readAuditTrail(`${authorised()}\n`).records.length, 1);

    const inside = readAuditTrail(`${authorised()}\n\nthe last record\n`);
    assert.equal(inside.records.length, 3);
    assert.equal(inside.records[1].status, "malformed");
    assert.match(inside.records[1].problems.join(" "), /empty/);
    assert.equal(inside.records[2].index, 3, "a record is named by its line in the file");
  });

  test("a value is escaped for display, one control character at a time", () => {
    assert.equal(inOneLine("a\nb"), "a\\x0ab");
    assert.equal(inOneLine("plain"), "plain");
    assert.equal(inOneLine(null), "");
  });
});
