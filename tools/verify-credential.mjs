#!/usr/bin/env node
/**
 * Is the credential that pushes to this repository still the right one?
 *
 * WHY THIS EXISTS. Two facts about pushing here are easy to know and hard to
 * check. The credential is an HTTPS token in Windows Credential Manager rather
 * than anything in the checkout, and it has to satisfy **two** separate
 * permissions: Contents, for the push to be allowed at all, and Workflows, for
 * the one directory this project keeps under `.github/`. The first failure that
 * matters is an expiry — a token that lapses turns `git push` into an
 * authentication error that reads like a network fault, and that is exactly the
 * state this repository was in when its token was eight days from its date. The
 * second is a credential that can push everything except a workflow file, which
 * this repository has hit too: its stored token is a classic one carrying only
 * `repo`.
 *
 * Neither can be inferred from a read. The repository is public, so
 * `git ls-remote` succeeds with no credential at all, which means a stale token
 * passes that check every time. Both probes below are therefore writes, and both
 * are safe to run:
 *
 *   * the **auth probe** is `git push --dry-run`, which negotiates with GitHub —
 *     so a refused or bogus token fails there, with exit 128 — and creates no
 *     ref at all. It pushes the *remote's own* commit rather than local work, so
 *     a pending workflow edit of yours cannot make it report a false failure;
 *   * the **workflow probe** really pushes a commit whose only difference from
 *     `HEAD` is a comment line inside `.github/workflows/`, then deletes the
 *     branch it created. The commit is built through a temporary index, so the
 *     working tree, `HEAD` and the current branch are never touched, and the
 *     refusal it is looking for creates nothing anyway — measured: the branch is
 *     a 404 afterwards.
 *
 * DEPLOY.md §9 is the same thing in prose, with the verbatim refusals and what to
 * do about each.
 *
 * Usage:
 *   npm run verify:credential
 *   npm run verify:credential -- --no-workflow    # skip the branch-creating probe
 *   npm run verify:credential -- --remote upstream
 *
 * Exit codes: 0 when every check that ran passed, 1 for any failure, 2 for a
 * usage error. A skipped check is printed as SKIP with its reason, never as a
 * pass — the distinction this project cares about everywhere else.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** How close to its date a credential has to be before that is a failure. */
export const EXPIRY_WARNING_DAYS = 14;

/** The two permissions that matter, and what a missing one looks like. */
const WORKFLOWS_DIR = ".github/workflows";

/* --------------------------------- reading -------------------------------- */

/**
 * What kind of token this is, from its prefix alone. Reporting it matters because
 * the two kinds take different permissions: a fine-grained token has no
 * `workflow` scope to grant, and looking for one is the dead end §9 warns about.
 * Exported for the tests.
 */
export function classifyToken(value) {
  if (typeof value !== "string" || !value) return "none";
  if (value.startsWith("github_pat_")) return "fine-grained";
  if (value.startsWith("ghp_")) return "classic";
  if (value.startsWith("gho_")) return "oauth";
  if (value.startsWith("ghs_")) return "app";
  if (value.startsWith("ghu_")) return "user";
  return "unrecognised";
}

/**
 * The owner and repository in a remote URL, whether it is HTTPS or SSH-shaped.
 * Exported for the tests.
 */
export function parseRemote(url) {
  const text = String(url ?? "").trim();
  const https = text.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (https) return { host: https[1], owner: https[2], repo: https[3] };
  const ssh = text.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { host: ssh[1], owner: ssh[2], repo: ssh[3] };
  return null;
}

/** `protocol=https\nhost=…\nusername=…\npassword=…` from `git credential fill`. */
export function parseCredential(stdout) {
  const fields = {};
  for (const line of String(stdout ?? "").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return { host: fields.host ?? "", username: fields.username ?? "", password: fields.password ?? "" };
}

/**
 * Whole days until an expiry, or null when there is no date to read. GitHub
 * answers with `2026-10-24 22:41:11 UTC`, which is not an ISO string, so the
 * separator has to be fixed before it will parse.
 */
export function daysUntil(expiresAt, now = Date.now()) {
  const text = String(expiresAt ?? "").trim();
  const iso = text.replace(/ UTC$/, "Z").replace(" ", "T");
  const when = Date.parse(iso);
  if (Number.isNaN(when)) return null;
  return Math.floor((when - now) / 86_400_000);
}

/**
 * Which refusal this is, from what `git push` printed.
 *
 * The strings are the ones GitHub actually sends; the workflow one is quoted in
 * full in DEPLOY.md §9 because it reads like an access problem rather than a
 * permission one. Exported for the tests.
 */
export function classifyRefusal(output) {
  const text = String(output ?? "");
  if (/refusing to allow a Personal Access Token to create or update workflow/i.test(text)) return "workflow-scope";
  if (/refusing to allow.*without `?workflow`? (?:scope|permission)/i.test(text)) return "workflow-scope";
  if (/Permission to .* denied/i.test(text)) return "permission";
  if (/Invalid username or token|Authentication failed|could not read Username|terminal prompts disabled/i.test(text)) return "auth";
  if (/non-fast-forward|fetch first|\[rejected\].*fetch first/i.test(text)) return "non-fast-forward";
  if (/GH013|protected branch|Repository rule violations/i.test(text)) return "protected";
  return text.trim() ? "other" : "none";
}

/**
 * The one line of a git failure worth quoting: GitHub's `remote:` line if there
 * is one, otherwise the rejection itself.
 *
 * A rejected ref line reads `! [remote rejected] <sha> -> <ref> (reason)`, and
 * the first two of those are noise — the sha and the ref are different on every
 * run, and the reason is the whole message. So the reason is what comes back.
 */
export function firstMeaningfulLine(output) {
  const lines = String(output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("To ") && !line.startsWith("Everything up-to-date"));
  const remote = lines.find((line) => line.startsWith("remote:"));
  const line = (remote ?? lines[0] ?? "").replace(/^remote:\s*/, "");
  const rejected = line.match(/^!?\s*\[remote rejected\]\s+\S+\s+->\s+\S+\s+\((.*)\)$/);
  return rejected ? rejected[1] : line;
}

/* --------------------------------- deciding ------------------------------- */

/**
 * The verdict, separated from the probing so it can be tested without a network,
 * a remote or a credential.
 *
 *   credential  `git credential fill` result, or null when nothing was stored
 *   api         what GET /repos/{owner}/{repo} answered: { status, push, scopes,
 *               expiresAt, message }, or { error } when it could not be reached
 *   auth        the dry-run probe: { accepted, refusal, detail, refCreated }
 *   workflow    the branch-creating probe, or null when it was not run
 *   httpsRemote whether this remote authenticates with a stored credential at
 *               all: an SSH remote uses a key, and none of this applies to it
 *   now         injected clock, for the expiry arithmetic
 */
export function assessCredential({ credential, api, auth, workflow, worktreeChanged = false, httpsRemote = true, now = Date.now() }) {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });
  const notApplicable =
    "this remote does not use a stored HTTPS credential (SSH uses a key), so there is nothing to inspect here";

  if (!httpsRemote) {
    for (const name of [
      "a credential is stored for this host",
      "the token's scopes are known",
      "GitHub answers for the stored credential",
      "the credential may push here",
      "the credential is not about to expire",
    ]) {
      record(name, "skip", notApplicable);
    }
  } else if (!credential?.password) {
    record(
      "a credential is stored for this host",
      "fail",
      "nothing in the credential store — `git credential approve` one; DEPLOY.md §9 has the three lines"
    );
  } else {
    const kind = classifyToken(credential.password);
    record(
      "a credential is stored for this host",
      "pass",
      `${kind} token (${credential.password.length} chars) as ${credential.username || "an unnamed account"}`
    );

    if (kind === "classic") {
      const scopes = String(api?.scopes ?? "").trim();
      record(
        "the token's scopes are known",
        scopes ? "pass" : "skip",
        scopes
          ? `${scopes}${/(^|,)\s*workflow\s*(,|$)/.test(scopes) ? " (includes workflow)" : " — no workflow scope, so a commit under .github/workflows/ will be refused"}`
          : "GitHub reported no scopes for it"
      );
    } else {
      record(
        "the token's scopes are known",
        "skip",
        `${kind} tokens carry permissions rather than scopes; the workflow probe is what tests the one that matters`
      );
    }
  }

  if (httpsRemote && api?.error) {
    record("GitHub answers for the stored credential", "fail", api.error);
  } else if (api && api.status !== 200) {
    record("GitHub answers for the stored credential", "fail", `GET the repository returned HTTP ${api.status}${api.message ? ` — ${api.message}` : ""}`);
  } else if (api) {
    record("GitHub answers for the stored credential", "pass", `/repos/… returned 200 as ${credential?.username || "the stored account"}`);
    record(
      "the credential may push here",
      api.push ? "pass" : "fail",
      api.push ? "the repository reports push access" : "the repository reports no push access — the token's repository access or Contents permission is wrong"
    );

    const days = daysUntil(api.expiresAt, now);
    if (api.expiresAt && days === null) {
      record("the credential is not about to expire", "skip", `an expiry was reported (${api.expiresAt}) but not in a form this tool can measure`);
    } else if (days === null) {
      record("the credential is not about to expire", "pass", "GitHub reported no expiry, so there is no date to fall off");
    } else if (days < 0) {
      record("the credential is not about to expire", "fail", `expired ${-days} day(s) ago (${api.expiresAt}) — pushes are being refused or will be on the next one`);
    } else if (days <= EXPIRY_WARNING_DAYS) {
      record(
        "the credential is not about to expire",
        "fail",
        `${days} day(s) left (${api.expiresAt}) — inside the ${EXPIRY_WARNING_DAYS}-day margin, and a credential that lapses mid-task is indistinguishable from a broken remote`
      );
    } else {
      record("the credential is not about to expire", "pass", `${days} day(s) left (${api.expiresAt})`);
    }
  }

  if (!auth) {
    record("the credential authenticates and may write", "skip", httpsRemote ? "no credential was probed" : notApplicable);
  } else if (auth.accepted) {
    record("the credential authenticates and may write", "pass", "the dry-run push was accepted");
  } else if (auth.refusal === "workflow-scope") {
    // Still a pass for *this* check: GitHub got past authentication and the
    // write check, and refused on the workflow rule alone.
    record(
      "the credential authenticates and may write",
      "pass",
      "accepted apart from the workflow permission, which is the check below"
    );
  } else {
    record("the credential authenticates and may write", "fail", `${auth.refusal} — ${auth.detail || "no detail"}`);
  }

  if (auth) {
    record(
      "the dry-run probe created nothing",
      auth.refCreated === null ? "skip" : auth.refCreated ? "fail" : "pass",
      auth.refCreated === null
        ? "could not list the remote's refs, so this was not checked"
        : auth.refCreated
          ? "a probe ref exists on the remote — --dry-run should never create one"
          : "no ref on the remote afterwards"
    );
  }  if (!workflow) {
    record("the credential may commit under " + WORKFLOWS_DIR + "/", "skip", httpsRemote ? "not run (--no-workflow, or no workflow file to probe)" : notApplicable);
  } else if (workflow.accepted) {
    record(
      "the credential may commit under " + WORKFLOWS_DIR + "/",
      "pass",
      `a commit touching ${workflow.path} was accepted, and the probe branch was deleted`
    );
    record(
      "the workflow probe cleaned up after itself",
      workflow.refRemoved === null ? "skip" : workflow.refRemoved ? "pass" : "fail",
      workflow.refRemoved === null
        ? "could not list the remote's refs to confirm the branch is gone"
        : workflow.refRemoved
          ? "no probe branch on the remote"
          : `the probe branch is still on the remote — delete it with \`git push ${workflow.remote ?? "origin"} --delete ${workflow.ref ?? "<branch>"}\``
    );
  } else if (workflow.refusal === "workflow-scope") {
    record(
      "the credential may commit under " + WORKFLOWS_DIR + "/",
      "fail",
      `refused: ${workflow.detail} — the credential needs the Workflows permission (fine-grained) or the workflow scope (classic); DEPLOY.md §9`
    );
  } else {
    record("the credential may commit under " + WORKFLOWS_DIR + "/", "fail", `${workflow.refusal} — ${workflow.detail || "no detail"}`);
  }

  if (workflow) {
    record(
      "the probes left the checkout alone",
      worktreeChanged ? "fail" : "pass",
      worktreeChanged ? "the working tree changed — the probes are supposed to build their commit through a temporary index" : "same working tree, same HEAD, same branch"
    );
  }

  return checks;
}

/* -------------------------------- transport ------------------------------- */

const git = (args, { input, env, allowFailure = false } = {}) => {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf8",
      input,
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    if (!allowFailure) throw error;
    return {
      ok: false,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
      code: error.status ?? 1,
    };
  }
};

const gitOut = (args, options) => git(args, options).stdout.trim();

/** The one HTTP call the checker makes, with the token in a header and never in an argument. */
async function apiGet(path, token) {
  let response;
  try {
    response = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "paloption-verify-credential",
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { error: `could not reach api.github.com: ${error.message}` };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return {
    status: response.status,
    scopes: response.headers.get("x-oauth-scopes") ?? "",
    expiresAt: response.headers.get("github-authentication-token-expiration") ?? "",
    push: body?.permissions?.push === true,
    message: body?.message ?? "",
  };
}

/* --------------------------------- probing -------------------------------- */

/**
 * A ref name nothing else will be using. Random rather than fixed so two runs —
 * or two people — cannot delete each other's probe.
 */
const probeRef = () => `paloption-credential-probe-${randomBytes(4).toString("hex")}`;

/**
 * Whether a ref is on the remote: false, true, or null when the question could
 * not be asked. Null is not false — a listing that failed would otherwise be
 * reported as evidence that nothing was created.
 */
function refExists(remote, ref) {
  const listed = git(["ls-remote", "--heads", remote, ref], { allowFailure: true });
  if (!listed.ok) return null;
  return listed.stdout.trim() !== "";
}

/**
 * A commit whose only difference from HEAD is a comment appended to one workflow
 * file, built entirely through a temporary index: no branch is created, HEAD does
 * not move, and the working tree is never written to. That matters here more than
 * usual — this checkout is shared.
 */
function probeCommit(workflowPath, message) {
  const dir = mkdtempSync(join(tmpdir(), "paloption-probe-index-"));
  const env = { GIT_INDEX_FILE: join(dir, "index") };
  const original = gitOut(["show", `HEAD:${workflowPath}`]);
  const blob = gitOut(["hash-object", "-w", "--stdin"], {
    input: `${original}\n# credential probe: a comment is the whole change\n`,
  });
  git(["read-tree", "HEAD"], { env });
  git(["update-index", "--add", "--cacheinfo", `100644,${blob},${workflowPath}`], { env });
  const tree = gitOut(["write-tree"], { env });
  rmSync(dir, { recursive: true, force: true });
  const parent = gitOut(["rev-parse", "HEAD"]);
  return gitOut(["commit-tree", tree, "-p", parent, "-m", message]);
}

/** The auth probe: negotiate a push, create nothing. */
function runAuthProbe(remote, branch) {
  // The remote's own commit, so a workflow edit waiting in this checkout cannot
  // turn a write probe into a workflow-permission failure.
  const listed = git(["ls-remote", "--heads", remote, branch], { allowFailure: true });
  const sha = (listed.ok ? listed.stdout.trim().split("\t")[0] : "") || gitOut(["rev-parse", "HEAD"]);
  const ref = probeRef();
  const result = git(["push", "--dry-run", remote, `${sha}:refs/heads/${ref}`], { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  return {
    accepted: result.ok,
    refusal: result.ok ? "none" : classifyRefusal(output),
    detail: result.ok ? "the dry-run push was accepted" : firstMeaningfulLine(output),
    refCreated: refExists(remote, ref),
    output: output.trim(),
  };
}

/** The workflow probe: the real push, then the branch it created is removed. */
function runWorkflowProbe(remote, workflowPath) {
  const ref = probeRef();
  const base = { path: workflowPath, remote, ref };
  let commit;
  try {
    commit = probeCommit(workflowPath, "probe: which credential may commit a workflow file");
  } catch (error) {
    return { ...base, accepted: false, refusal: "other", detail: `could not build the probe commit: ${error.message}`, refRemoved: true };
  }
  const result = git(["push", remote, `${commit}:refs/heads/${ref}`], { allowFailure: true });
  const output = `${result.stdout}\n${result.stderr}`;
  // Kept for the report below: the refusal line names the branch that was not
  // created, which is evidence the probe really tried.
  if (!result.ok) {
    return {
      ...base,
      accepted: false,
      refusal: classifyRefusal(output),
      detail: firstMeaningfulLine(output),
      refRemoved: refExists(remote, ref) === false,
      output: output.trim(),
    };
  }
  const removed = git(["push", remote, "--delete", ref], { allowFailure: true });
  const stillThere = refExists(remote, ref);
  return {
    ...base,
    accepted: true,
    refusal: "none",
    detail: `a commit touching ${workflowPath} was accepted`,
    refRemoved: stillThere === null ? null : !stillThere && removed.ok,
    output: output.trim(),
  };
}

/* ---------------------------------- main ---------------------------------- */

const USAGE = `usage: node tools/verify-credential.mjs [--remote <name>] [--no-workflow]

  --remote <name>   which remote to judge (default origin)
  --no-workflow     skip the probe that pushes a throwaway branch; the workflow
                    permission is then reported as SKIP rather than tested
  --help            this text`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg, index) => arg.startsWith("-") && !["--remote", "--no-workflow", "--help", "-h"].includes(arg));
  if (unknown.length) {
    console.error(`${USAGE}\n\nunknown option: ${unknown.join(", ")}`);
    return 2;
  }
  const remote = argv.includes("--remote") ? argv[argv.indexOf("--remote") + 1] : "origin";
  const skipWorkflow = argv.includes("--no-workflow");

  const top = gitOut(["rev-parse", "--show-toplevel"]);
  process.chdir(top);

  const url = gitOut(["remote", "get-url", remote]);
  const parsed = parseRemote(url);
  const branch = gitOut(["rev-parse", "--abbrev-ref", "HEAD"]);
  const headBefore = gitOut(["rev-parse", "HEAD"]);
  const treeBefore = gitOut(["status", "--porcelain"]);

  console.log(`remote     : ${remote} ${url}`);
  console.log(`branch     : ${branch} at ${headBefore.slice(0, 7)}`);

  const https = parsed && /^https?$/.test((url.match(/^(\w+):\/\//) ?? [])[1] ?? "");
  const onGitHub = parsed?.host === "github.com";
  const canProbe = Boolean(https && onGitHub);

  let credential = null;
  if (canProbe) {
    // No prompt may be attempted: this tool reports, it does not ask a person for
    // a token, and a GUI dialog would hang a non-interactive run.
    const filled = git(["credential", "fill"], {
      input: `protocol=https\nhost=${parsed.host}\n\n`,
      env: { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      allowFailure: true,
    });
    credential = filled.ok ? parseCredential(filled.stdout) : null;
    if (credential && !credential.username) credential.username = parsed.owner;
  }

  let api = null;
  if (credential?.password && parsed) {
    api = await apiGet(`/repos/${parsed.owner}/${parsed.repo}`, credential.password);
  }

  if (credential?.password) {
    console.log(`credential : ${classifyToken(credential.password)} token as ${credential.username}, ${credential.password.length} chars`);
  } else {
    console.log(
      canProbe ? "credential : none found for this host" : "credential : not applicable — this remote does not use the credential store"
    );
  }

  const workflows = canProbe
    ? gitOut(["ls-tree", "-r", "--name-only", "HEAD", "--", WORKFLOWS_DIR], { allowFailure: true })
        .split("\n")
        .filter((line) => /\.ya?ml$/.test(line))
    : [];
  const workflowPath = workflows[0] ?? "";

  let auth = null;
  let workflow = null;
  if (canProbe) {
    auth = runAuthProbe(remote, branch);
    if (!skipWorkflow && credential?.password && workflowPath) {
      console.log(`\nprobing ${WORKFLOWS_DIR}/${workflowPath.split("/").pop()} on a throwaway branch (this is the only write it makes)…`);
      workflow = runWorkflowProbe(remote, workflowPath);
    }
  }

  const checks = assessCredential({
    credential,
    api,
    auth,
    workflow,
    httpsRemote: canProbe,
    worktreeChanged: gitOut(["rev-parse", "HEAD"]) !== headBefore || gitOut(["status", "--porcelain"]) !== treeBefore,
  });

  console.log("");
  for (const check of checks) console.log(`${check.status.toUpperCase().padEnd(4)}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);

  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const skipped = checks.filter((check) => check.status === "skip").length;
  const verdict = failed
    ? "a credential that needs attention"
    : passed
      ? "a credential that does what this repository needs"
      : "nothing to judge for this remote";
  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped — ${verdict}${failed ? " (DEPLOY.md §9)" : ""}`);

  return failed ? 1 : 0;
}

// Only when run as a command: the tests import the pure functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`verify-credential failed: ${error.message}`);
      process.exit(1);
    });
}
