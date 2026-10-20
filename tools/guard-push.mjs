#!/usr/bin/env node
/**
 * Refuse a push that would hand GitHub a change under `.github/workflows/`.
 *
 * WHY THIS EXISTS. One directory in this repository needs a permission the rest
 * does not: `.github/workflows/` is tracked, so a commit that touches it is
 * refused outright unless the credential carries the Workflows permission. That
 * refusal arrives *after* the push has been attempted, reads like an access or
 * network problem rather than a permission one, and — measured on this
 * repository — is identical whether you push `main` or a throwaway branch. The
 * other half of the problem is the opposite case: an edit to CI that nobody
 * meant to ship. A workflow file is executable configuration for a runner, so a
 * stray edit there runs arbitrary steps on GitHub's machines on the next push.
 *
 * So the rule is about the *content* of the outgoing commits, decided locally,
 * before anything is sent:
 *
 *   * an ordinary push is allowed and says nothing;
 *   * a push whose outgoing commits change a path under `.github/workflows/` is
 *     refused unless the change is explicitly authorised, in which case the
 *     authorisation (and the reason for it) is written to an audit line;
 *   * a question that cannot be answered is never answered "yes". An unreadable
 *     hook line, a repository that cannot be read, and a workflow change that
 *     cannot be ruled out on an *existing* remote ref all refuse, with the
 *     remedy named.
 *
 * ONE DELIBERATE EXCEPTION, because the honest answer there is not "no". When
 * the remote has no such ref at all — the first push to a new remote, a fork, a
 * mirror — every commit reachable from it would be new there, so "does this push
 * change CI?" has no local answer: the workflow file it carries is whatever the
 * history being sent contains, which is the repository's own committed file and
 * not an edit made for the push. Refusing that would block the ordinary case of
 * pushing an existing history to a new remote, so it is reported and allowed,
 * with what governs it said out loud: on GitHub the credential's own Workflows
 * permission decides (measured in DEPLOY.md §9 — the refusal applies to a
 * throwaway branch exactly as it does to `main`), and `npm run verify:credential`
 * is what measures that. What is given up is stated rather than glossed over: a
 * workflow edit pushed as a *new* ref on a remote this checkout has never
 * fetched, using a credential that may write workflows, is not caught here.
 *
 * WHAT THIS IS NOT. It does not check the credential and it does not run a
 * probe. A `git push --dry-run` succeeding says the credential can push at all —
 * nothing about whether a change to CI was intended — so authorising on it would
 * be the very mistake this guard exists to prevent. The credential's own
 * two-permission question is a separate, server-side gate measured by
 * `npm run verify:credential` (DEPLOY.md §9). Nothing here reads the credential
 * store, prints a token, asks for one, contacts a remote, or writes a deploy
 * key: every git command it runs is a read, and a test asserts that by recording
 * them all.
 *
 * Usage:
 *   npm run guard:push                    # what the guard would say about this branch
 *   npm run guard:install                 # make this checkout run the hook
 *   npm run guard:status                  # is the guard active here?
 *   npm run guard:audit                   # read the authorisation trail, newest first
 *   node tools/guard-push.mjs --hook <remote> <url>   # what the hook calls; refs on stdin
 *
 * Exit codes: 0 when the push may proceed, 1 when it is refused or the guard
 * could not decide, 2 for a usage error. A refusal is a refusal — there is no
 * third state in which a doubtful push proceeds quietly.
 *
 * THE TRAIL, AND WHAT A RECORD IN IT CLAIMS. Every authorisation is appended to
 * `.git/strategyoption-push-guard.log` as one line, and `--audit` reads that file and
 * nothing else: it never writes, never truncates, and never pushes. A record
 * says the hook let an authorised workflow change leave. It does not say GitHub
 * accepted the push, and it cannot — a pre-push hook runs before anything is
 * sent, so "allowed to proceed" is the strongest claim available here.
 *
 * Refusals are deliberately not recorded: they are reported to whoever is
 * pushing, at the moment they are refused, and the trail exists to say who
 * authorised a change and why. The consequence is stated rather than glossed
 * over — an absence of refused records is not evidence that none happened — and
 * so is the other one: the file lives in `.git`, which anyone who can push can
 * also edit, so this is a local trail and not a tamper-proof control.
 *
 * DEPLOY.md §9 documents all of it: what is blocked, the one environment
 * variable that authorises a workflow change, how to install the hook, and what
 * CI does independently of it.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The one directory a push may not quietly change. */
export const PROTECTED_DIR = ".github/workflows";

/** The variable that authorises a workflow change, and carries the reason. */
export const AUTHORIZATION_ENV = "STRATEGYOPTION_WORKFLOW_PUSH_REASON";

/**
 * How long an authorisation reason has to be. The floor is about the audit line:
 * "1", "yes" and "tmp" read back as nothing six months later, and an override
 * nobody can explain afterwards is not an authorisation, it is a bypass wearing
 * one as a costume.
 */
export const MIN_REASON_CHARS = 12;

/** The audit trail, inside the git directory so it can never be committed. */
export const AUDIT_FILE = "strategyoption-push-guard.log";

/** Where the audit line goes instead, when set. Lets a test point it at a bad path. */
export const AUDIT_PATH_ENV = "STRATEGYOPTION_PUSH_GUARD_LOG";

/** An all-zero object id: git's way of saying "no such ref over there". */
const ZERO_SHA = /^0{40}$|^0{64}$/;
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/* -------------------------------- decisions ------------------------------- */

/**
 * A remote URL with any userinfo removed.
 *
 * GitHub accepts `https://user:token@host/owner/repo.git`, and a token pasted
 * into a remote URL is a real thing people do, so a report that echoed the URL
 * would be a report that printed a credential. Everything from the scheme to the
 * `@` goes; what is left is still enough to recognise the remote. Exported for
 * the tests.
 */
export function redactUrl(url) {
  return String(url ?? "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1<redacted>@");
}

/**
 * The lines git writes to a pre-push hook's stdin, one per ref:
 *
 *   <local ref> <local sha> <remote ref> <remote sha>
 *
 * A deletion arrives as `(delete)` with an all-zero local sha. Ref names cannot
 * contain whitespace, so splitting on runs of whitespace is exact. A line
 * without the four fields is *not* dropped silently: a hook line nobody can read
 * is a push nobody can judge, and the caller refuses on it. Exported for tests.
 */
export function parseRefUpdates(text) {
  const updates = [];
  const unreadable = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 4) {
      unreadable.push(line.slice(0, 120));
      continue;
    }
    const [localRef, localSha, remoteRef, remoteSha] = fields;
    updates.push({
      localRef,
      localSha,
      remoteRef,
      remoteSha,
      deletion: localRef === "(delete)" || ZERO_SHA.test(localSha),
    });
  }
  return { updates, unreadable };
}

/**
 * Whether a path is one the guard protects. A bare `startsWith(PROTECTED_DIR)`
 * would also catch `.github/workflows-notes.md` and `.github/workflows2/x`, so
 * the directory itself and the directory-prefixed form match, and nothing else.
 * Exported for the tests.
 */
export function isProtectedPath(path) {
  const value = String(path ?? "");
  return value === PROTECTED_DIR || value.startsWith(`${PROTECTED_DIR}/`);
}

/**
 * Whether this invocation carries an authorisation, and whether it is usable.
 *
 * The reason *is* the authorisation: an environment variable set to nothing, or
 * to something too short to mean anything later, is reported as not granted with
 * the reason why, rather than being read as consent. Exported for the tests.
 */
export function authorizationFrom(env = {}, cliReason = null) {
  const fromCli = cliReason !== null && cliReason !== undefined;
  const source = fromCli ? "--allow-workflow" : `$${AUTHORIZATION_ENV}`;
  const raw = fromCli ? cliReason : env?.[AUTHORIZATION_ENV];
  if (raw === undefined || raw === null) {
    return {
      granted: false,
      reason: "",
      source: "none",
      detail: `not authorised — set ${AUTHORIZATION_ENV} to why this workflow change is intended, or pass --allow-workflow "<reason>"`,
    };
  }
  const reason = String(raw).trim();
  if (!reason) return { granted: false, reason: "", source, detail: `${source} is set but empty, which authorises nothing` };
  if (reason.length < MIN_REASON_CHARS) {
    return {
      granted: false,
      reason,
      source,
      detail: `${source} is only ${reason.length} character(s) — at least ${MIN_REASON_CHARS} are needed for the audit line to mean anything`,
    };
  }
  return { granted: true, reason, source, detail: `authorised by ${source}` };
}

/**
 * The commits and paths in one `git log --format=%H --name-only` block. Commit
 * ids and paths are told apart by shape; `--no-renames` is what makes a workflow
 * file renamed *away* show up as the deletion it is instead of vanishing behind
 * a rename record. Exported for the tests.
 */
export function parseOutgoingLog(text) {
  const commits = [];
  const paths = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (SHA.test(line)) commits.push(line);
    else paths.push(line);
  }
  return { commits, paths };
}

/**
 * The verdict, separated from the repository so it can be tested against facts
 * rather than against git.
 *
 *   updates      per ref: the hook's four fields plus `outgoing` — either
 *                `{ commits, paths, baseSource }` or `{ unknown: true,
 *                treeHasWorkflow }` when the new commits could not be
 *                established. `treeHasWorkflow` is `false` only when the pushed
 *                tree was read and has no workflow file; `null` means it could
 *                not be read, which is emphatically not the same answer
 *   unreadable   hook lines that could not be parsed
 *
 * Returns the checks, whether the push may proceed, and what the audit line
 * should say. Exported for the tests.
 */
export function assessPush({ remote = "origin", url = "", updates = [], unreadable = [], authorization }) {
  const checks = [];
  const record = (name, status, detail) => checks.push({ name, status, detail });
  const authorisation = authorization ?? authorizationFrom({});
  // The destination, redacted once and used everywhere a person will read it.
  // git passes a *URL* as the remote's name when a push names one, so a token in
  // it would otherwise be printed by whichever message happens to mention the
  // remote — and a report is the thing people paste into an issue.
  const destination = redactUrl(remote);

  const pushed = updates.filter((update) => !update.deletion);
  const deletions = updates.filter((update) => update.deletion);
  const refList = updates.map((update) => update.remoteRef).join(", ");
  const protectedFiles = new Set();
  const commits = new Set();
  const unknown = [];

  for (const update of updates) {
    if (update.deletion) continue;
    const outgoing = update.outgoing ?? { unknown: true, treeHasWorkflow: true };
    if (outgoing.unknown) {
      // `undefined` means the gatherer did not say, which is not the same as
      // saying there is none: only an explicit `false` clears a push on content.
      unknown.push({ update, treeHasWorkflow: outgoing.treeHasWorkflow === undefined ? true : outgoing.treeHasWorkflow });
      continue;
    }
    for (const sha of outgoing.commits ?? []) commits.add(sha);
    for (const path of outgoing.paths ?? []) if (isProtectedPath(path)) protectedFiles.add(path);
  }

  /**
   * An unknown outgoing set comes in two shapes, and they are not the same
   * question. `createsRef` is a ref the remote does not have (so the push makes
   * it); the other kind is a ref the remote *does* have, whose value this
   * checkout never fetched — and that one `git fetch` genuinely answers.
   */
  const createsRef = (update) => !update.remoteSha || ZERO_SHA.test(update.remoteSha);
  const unknownCreates = unknown.filter((entry) => createsRef(entry.update));
  const unknownExisting = unknown.filter((entry) => !createsRef(entry.update));
  const list = (entries) => entries.map((entry) => entry.update.remoteRef).join(", ");

  /** Whether the pushed tree can be cleared of the protected directory outright. */
  const treeOnly = unknown.every((entry) => entry.treeHasWorkflow === false);

  /* 1. The hook's input is the only description of the push there is. */
  if (unreadable.length) {
    record(
      "git's pre-push input was readable",
      "fail",
      `${unreadable.length} line(s) were not in git's four-field form (first: ${JSON.stringify(unreadable[0])}) — which commits are leaving cannot be established from a line that cannot be read`
    );
  } else if (!updates.length) {
    record("git's pre-push input was readable", "pass", "no ref updates, which is a push with nothing to send");
  } else {
    record("git's pre-push input was readable", "pass", `${updates.length} ref update(s)`);
  }

  /* 2. The destination is printed rather than assumed. */
  record(
    "the destination was identified",
    "pass",
    `${destination} ${url ? redactUrl(url) : "(no URL — this remote is not configured; every commit is judged as new)"} → ${refList || "nothing"}`
  );

  /* 3. Which commits are actually leaving. */
  if (!updates.length) {
    record("the outgoing commits were identified", "pass", "there is nothing to send");
  } else if (unreadable.length) {
    record("the outgoing commits were identified", "skip", "the input could not be read, so this was not established");
  } else if (unknown.length) {
    const parts = [];
    if (unknownCreates.length) parts.push(`${list(unknownCreates)} does not exist on ${destination} yet, so this push creates it and every commit reachable from it would be new there`);
    if (unknownExisting.length) {
      parts.push(`${list(unknownExisting)} exists there and this checkout has no value for it, so which commits are new cannot be told — \`git fetch ${destination}\` answers that for the next push`);
    }
    record("the outgoing commits were identified", "skip", parts.join("; "));
  } else if (!pushed.length) {
    record("the outgoing commits were identified", "pass", `only ${deletions.length} ref deletion(s), which send no commits — no file can change`);
  } else if (!commits.size) {
    record(
      "the outgoing commits were identified",
      "pass",
      `nothing new — every commit reachable from ${pushed.map((update) => update.remoteRef).join(", ")} is already on ${destination}`
    );
  } else {
    const sources = [...new Set(pushed.map((update) => update.outgoing?.baseSource).filter(Boolean))].join("; ");
    record(
      "the outgoing commits were identified",
      "pass",
      `${commits.size} commit(s) not already on ${destination} (${sources || "against the ref's current value"})`
    );
  }

  /* 4. What the outgoing commits carry, in full. A fact, so it never fails —
        the question of whether the push may leave is check 5's, and a fact that
        is fine once authorised must not refuse a push on its own. */
  const protectedList = [...protectedFiles].sort().join(", ");
  if (!updates.length) {
    record("the outgoing commits and their files were established", "pass", "there is nothing to send");
  } else if (unreadable.length) {
    record("the outgoing commits and their files were established", "skip", "the input could not be read, so this was not established");
  } else if (unknown.length && treeOnly) {
    record(
      "the outgoing commits and their files were established",
      "pass",
      `the tree being pushed contains no ${PROTECTED_DIR}/ file at all, so no commit in it can change one — which commits are new could not be told, and it does not matter here`
    );
  } else if (unknown.length) {
    const unreadableTrees = unknown.filter((entry) => entry.treeHasWorkflow === null).map((entry) => entry.update.remoteRef);
    const tree = unreadableTrees.length
      ? `the tree being pushed could not be read for ${unreadableTrees.join(", ")}`
      : `the tree being pushed does contain ${PROTECTED_DIR}/`;
    const why = unknownExisting.length
      ? `which commits are new cannot be told for ${list(unknownExisting)}`
      : `every commit reachable from ${list(unknownCreates)} would be new there`;
    record("the outgoing commits and their files were established", "skip", `cannot be told: ${why}, and ${tree}`);
  } else {
    const sources = [...new Set(pushed.map((update) => update.outgoing?.baseSource).filter(Boolean))].join("; ");
    record(
      "the outgoing commits and their files were established",
      "pass",
      `${commits.size} commit(s) not already on ${destination} (${sources || "against the ref's current value"})${
        protectedFiles.size ? ` — ${protectedFiles.size} of them change ${protectedList}` : ` — none changes ${PROTECTED_DIR}/`
      }`
    );
  }

  /* 5. The one gate: an explicit, recorded reason, or nothing leaves. Unknown
        only counts against the push when the remote has something to compare
        against; see the note at the top of this file for what that gives up. */
  const needsAuthorisation = protectedFiles.size > 0 || (unknownExisting.length > 0 && !treeOnly);
  if (!needsAuthorisation) {
    record(
      "no unauthorised change under " + PROTECTED_DIR + "/ is leaving",
      "skip",
      unknownCreates.length
        ? `${list(unknownCreates)} does not exist on ${destination} yet, so this push creates it: the workflow file it carries is whatever the history being sent contains, not an edit this checkout made. On GitHub the credential's Workflows permission is what decides that — \`npm run verify:credential\` measures it — and a local or SSH remote has no CI to protect`
        : `nothing under ${PROTECTED_DIR}/ is being pushed, so there is nothing to authorise`
    );
  } else {
    const what = protectedFiles.size
      ? `the push changes ${protectedList}`
      : `whether this push changes ${PROTECTED_DIR}/ could not be ruled out here (${list(unknownExisting)})`;
    record(
      "no unauthorised change under " + PROTECTED_DIR + "/ is leaving",
      authorisation.granted ? "pass" : "fail",
      `${what} — ${authorisation.detail}${authorisation.granted ? `: ${JSON.stringify(authorisation.reason)}` : ""}`
    );
  }

  /* 6. Said out loud, because probing the remote is the tempting shortcut. */
  record(
    "nothing was probed to decide this",
    "pass",
    "the verdict comes from the commits alone: no push, no --dry-run, no credential read. Whether the credential may write a workflow file is GitHub's own check, and `npm run verify:credential` is what measures it"
  );

  return {
    checks,
    allowed: !checks.some((check) => check.status === "fail"),
    audit: {
      kind: "authorised",
      needed: needsAuthorisation && authorisation.granted,
      remote: destination,
      refs: updates.map((update) => update.remoteRef).join(" "),
      commits: commits.size,
      files: [...protectedFiles].sort().join(","),
      reason: authorisation.reason,
      source: authorisation.source,
    },
  };
}

/**
 * The audit line. The values that come from outside are JSON-quoted, because a
 * reason containing a newline would otherwise forge entries in the log.
 * Exported for the tests.
 */
export function auditLine({ kind = "authorised", when = new Date().toISOString(), remote, refs, commits, files, reason, source }) {
  return [
    when,
    `kind=${JSON.stringify(kind)}`,
    // Redacted at the writer, which is the one place a line is produced. The
    // remote name can be a URL — `git push https://user:token@host/o/r.git`
    // hands the hook exactly that string as $1 — so the credential would
    // otherwise be written to a file that outlives the push.
    `remote=${JSON.stringify(redactUrl(remote))}`,
    `refs=${JSON.stringify(refs)}`,
    `commits=${commits}`,
    `files=${JSON.stringify(files)}`,
    `source=${JSON.stringify(source)}`,
    `reason=${JSON.stringify(reason)}`,
  ].join(" ");
}

/* -------------------------- the authorisation trail ----------------------- */

/**
 * The kinds of record the trail can hold.
 *
 * `authorised` is the only kind this tool writes: a workflow change that was let
 * through is recorded with the reason for it. `refused` is read so that a record
 * carrying it is classified rather than guessed at — a refusal is reported to
 * whoever is pushing and is not appended (see the note at the top of this file)
 * — and so that a trail written by something else is never silently misread as
 * an authorisation.
 */
export const AUDIT_KINDS = ["authorised", "refused"];

/**
 * Every field a record carries, in the order the writer emits them. `kind` is
 * the one a record written before it existed legitimately lacks — every other
 * one is required, and a record missing one is reported as incomplete rather
 * than read as an authorisation.
 */
export const AUDIT_FIELDS = ["kind", "remote", "refs", "commits", "files", "source", "reason"];

/** How many records `--audit` lists when `--limit` is not given. */
export const AUDIT_DEFAULT_LIMIT = 20;

/** The timestamp form the writer has always emitted, and the only one that is not a warning. */
const AUDIT_WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `key="json"` or `key=bare`, sticky, so a field has to begin where the last one ended. */
const AUDIT_FIELD = /\s([a-z_]+)=("(?:[^"\\]|\\.)*"|[^\s"]*)/y;

/**
 * A value with every control character escaped, for printing.
 *
 * The writer keeps a newline out of the *file* by JSON-quoting, but reading the
 * value back turns `\n` into a real newline again — and a report that printed it
 * raw would show a line the record never had, which is the same forging problem
 * one layer further out. Exported for the tests.
 */
export function inOneLine(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/**
 * One line of the trail, read as a record.
 *
 * Four answers, not two. A record that cannot be read (`malformed`) and one that
 * is readable but does not say everything it must (`incomplete`) are different
 * failures, and neither is ever reported as an authorisation — the whole point
 * of reading a trail is to be able to say "this line is not evidence", which is
 * a third thing to say. Warnings sit beside the status rather than in it: a
 * legacy record, a reason below the floor the guard accepts, a remote value
 * carrying userinfo, a path this guard never protects. Each makes a record worth
 * questioning without making it unreadable, and `--check` turns the ones that
 * matter into a failure of its own.
 *
 * `terminated` is whether the line ended with a newline, which every line the
 * writer emits does: a final line without one is an append cut short mid-line,
 * and is reported as incomplete rather than read as a whole record.
 * Exported for the tests.
 */
export function parseAuditRecord(line, { index = 1, terminated = true } = {}) {
  const record = {
    index,
    when: "",
    at: null,
    kind: null,
    status: "malformed",
    legacy: false,
    credential: false,
    unprotected: [],
    // `null` is "this field is not here", which is not the same answer as the
    // empty string a record can legitimately carry — `files=""` is what an
    // authorisation over a ref this checkout has never fetched looks like.
    remote: null,
    refs: null,
    commits: null,
    files: null,
    source: null,
    reason: null,
    problems: [],
    incomplete: [],
    warnings: [],
    raw: String(line ?? ""),
  };

  const text = String(line ?? "").trim();
  if (!text) {
    record.problems.push("the line is empty, and one line per record is what the writer emits — nothing was ever recorded as a blank line");
    return record;
  }

  const gap = text.search(/\s/);
  record.when = gap === -1 ? text : text.slice(0, gap);
  const milliseconds = Date.parse(record.when);
  if (!Number.isFinite(milliseconds)) {
    record.problems.push(`the timestamp ${JSON.stringify(record.when)} is not a date`);
  } else {
    record.at = new Date(milliseconds);
    if (!AUDIT_WHEN.test(record.when) || record.at.toISOString() !== record.when) {
      record.warnings.push(
        `the timestamp is not this tool's own UTC form (${JSON.stringify(record.at.toISOString())}), so the line was not written by the guard as it stands`
      );
    }
  }

  if (gap === -1) {
    record.problems.push(`nothing follows the timestamp, and a record without ${AUDIT_FIELDS.slice(1).join("/")} says nothing`);
    return record;
  }

  const fields = new Map();
  const duplicated = [];
  const rest = text.slice(gap);
  let at = 0;
  while (at < rest.length) {
    AUDIT_FIELD.lastIndex = at;
    const match = AUDIT_FIELD.exec(rest);
    if (!match) break;
    if (fields.has(match[1])) duplicated.push(match[1]);
    fields.set(match[1], match[2]);
    at = AUDIT_FIELD.lastIndex;
  }
  const stray = rest.slice(at).trim();
  if (duplicated.length) record.problems.push(`the field(s) ${[...new Set(duplicated)].join(", ")} appear(s) twice, so the record says two things`);
  if (stray) record.problems.push(`text that is not a field: ${JSON.stringify(stray.slice(0, 80))}`);

  for (const key of AUDIT_FIELDS) {
    if (!fields.has(key)) {
      if (key !== "kind") record.incomplete.push(key);
      continue;
    }
    const raw = fields.get(key);
    if (raw === "") {
      record.problems.push(`${key}= has no value at all`);
      continue;
    }
    if (key === "commits") {
      const digits = raw.replace(/^"/, "").replace(/"$/, "");
      if (!/^\d+$/.test(digits)) record.problems.push(`commits=${JSON.stringify(raw)} is not a count`);
      else record.commits = Number(digits);
      continue;
    }
    if (!raw.startsWith('"')) {
      record[key] = raw;
      record.problems.push(`${key}=${JSON.stringify(raw)} is a bare token, and the writer quotes every text value`);
      continue;
    }
    try {
      record[key] = JSON.parse(raw);
    } catch {
      record.problems.push(`${key} is not a readable quoted value: ${JSON.stringify(raw.slice(0, 80))}`);
    }
  }

  if (fields.has("kind")) {
    if (typeof record.kind === "string" && !AUDIT_KINDS.includes(record.kind)) {
      record.problems.push(`kind=${JSON.stringify(record.kind)} is not one of ${AUDIT_KINDS.join(", ")}, so what this record claims happened is not something this tool records`);
    }
  } else {
    record.legacy = true;
    record.warnings.push("written before the kind= field existed, so it is read as an authorisation — the only event this tool has ever recorded");
  }

  if (!terminated) record.incomplete.push("the line has no terminator, so the append that wrote it was cut short mid-line");

  if (fields.has("reason") && typeof record.reason === "string" && record.reason.trim().length < MIN_REASON_CHARS) {
    record.warnings.push(
      `the reason is ${record.reason.trim().length} character(s), below the ${MIN_REASON_CHARS} this guard accepts, so the record was not written by it as it stands`
    );
  }
  if (typeof record.remote === "string" && record.remote && record.remote !== redactUrl(record.remote)) {
    record.credential = true;
    record.warnings.push(
      `the remote value carries userinfo, which is where a credential would be; it is printed as ${inOneLine(redactUrl(record.remote))}, and removing the line is yours to do — this tool never rewrites the trail`
    );
  }
  if (typeof record.files === "string" && record.files) {
    record.unprotected = record.files
      .split(",")
      .map((path) => path.trim())
      .filter((path) => path && !isProtectedPath(path));
    if (record.unprotected.length) {
      record.warnings.push(`the record names ${record.unprotected.join(", ")}, which is not under ${PROTECTED_DIR}/ — a guard authorisation covers nothing else`);
    }
  }

  record.status = record.problems.length
    ? "malformed"
    : record.incomplete.length
      ? "incomplete"
      : record.kind === "refused"
        ? "refused"
        : "authorised";
  return record;
}

/**
 * A whole trail file, as records.
 *
 * A trailing newline is the file's shape rather than a record — the writer ends
 * every line with one — so it is not read as a blank record. A blank line *in*
 * the middle is: the writer cannot produce one, so it is reported rather than
 * skipped. Exported for the tests.
 */
export function readAuditTrail(text) {
  const source = String(text ?? "");
  if (!source.trim()) return { records: [], empty: true, terminated: true };
  const parts = source.split("\n");
  const terminated = parts[parts.length - 1] === "";
  if (terminated) parts.pop();
  const records = parts.map((line, index) =>
    parseAuditRecord(line, { index: index + 1, terminated: index < parts.length - 1 || terminated })
  );
  return { records, empty: false, terminated };
}

/**
 * The counts, the span, and the one ordering fact a reader can establish.
 *
 * Out-of-order timestamps are reported rather than failed: each record is one
 * append, and two pushes at the same moment can be appended in either order, so
 * a trailing timestamp does not by itself mean the file was edited. Exported for
 * the tests.
 */
export function summariseAudit(records) {
  const of = (status) => records.filter((record) => record.status === status).length;
  const dated = records.filter((record) => record.at);
  const outOfOrder = [];
  for (let index = 1; index < dated.length; index += 1) {
    if (dated[index].at.getTime() < dated[index - 1].at.getTime()) outOfOrder.push(dated[index].index);
  }
  return {
    total: records.length,
    authorised: of("authorised"),
    refused: of("refused"),
    malformed: of("malformed"),
    incomplete: of("incomplete"),
    legacy: records.filter((record) => record.legacy).length,
    credentials: records.filter((record) => record.credential).length,
    unprotected: records.filter((record) => record.unprotected.length).length,
    warnings: records.reduce((total, record) => total + record.warnings.length, 0),
    outOfOrder,
    first: dated.length ? dated[0].at : null,
    last: dated.length ? dated[dated.length - 1].at : null,
    undated: records.length - dated.length,
  };
}

/* --------------------------------- reading -------------------------------- */

/** One git read, with its stdout trimmed. Throws when git refuses. */
const gitOut = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** One git read that is allowed to fail: the answer is the shape, not an exception. */
const gitTry = (args) => {
  try {
    return { ok: true, stdout: gitOut(args) };
  } catch (error) {
    return { ok: false, stdout: (error.stdout?.toString() ?? "").trim(), stderr: (error.stderr?.toString() ?? "").trim() };
  }
};

/**
 * What is leaving, for every ref in one push.
 *
 * The new commits are established against, in order: the remote's own current
 * value for that ref (the fourth field of the hook line, which is exact when the
 * object is in the checkout), then the refs this checkout tracks under
 * `refs/remotes/<remote>`. When neither exists the answer is `unknown` rather
 * than a guess — and the cheap guess ("everything reachable from the new sha is
 * new") is wrong in the expensive direction, because it would block ordinary
 * pushes from any checkout that has not been fetched, and this repository's own
 * history changes `.github/workflows/`.
 *
 * `run` is injectable so a test can record every git command the guard issues
 * while still deciding on a real repository.
 */
export function gatherPush({ remote, refUpdates = [], run = gitOut } = {}) {
  const attempt = (args) => {
    try {
      return { ok: true, stdout: String(run(args) ?? "") };
    } catch (error) {
      return { ok: false, stdout: (error.stdout?.toString() ?? "").trim() };
    }
  };

  const updates = [];
  for (const update of refUpdates) {
    if (update.deletion) {
      updates.push({ ...update, outgoing: { commits: [], paths: [], baseSource: "a deletion sends no commits" } });
      continue;
    }

    let bases = null;
    let baseSource = "";

    const remoteSha = update.remoteSha ?? "";
    if (remoteSha && !ZERO_SHA.test(remoteSha)) {
      // `cat-file -e` is the question the fallback depends on: a sha the hook
      // reports but this checkout has never fetched cannot be diffed against.
      if (attempt(["cat-file", "-e", `${remoteSha}^{commit}`]).ok) {
        bases = [remoteSha];
        baseSource = `the remote's current ${remoteSha.slice(0, 7)} is in this checkout`;
      }
    }

    if (!bases) {
      const tracking = attempt(["for-each-ref", "--format=%(objectname)", `refs/remotes/${remote}`]);
      const shas = [...new Set(tracking.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => SHA.test(line)))];
      if (tracking.ok && shas.length) {
        bases = shas;
        baseSource = `${shas.length} ref(s) tracked under refs/remotes/${remote}`;
      }
    }

    if (!bases) {
      // Three answers, not two: a tree that was read and has no workflow file
      // (`false`) allows the push on content alone, and a tree that could not be
      // read (`null`) is a question that failed — never the same answer as "no".
      const tree = attempt(["ls-tree", "-r", "--name-only", update.localSha, "--", PROTECTED_DIR]);
      updates.push({
        ...update,
        outgoing: {
          unknown: true,
          treeHasWorkflow: tree.ok ? tree.stdout !== "" : null,
          commits: [],
          paths: [],
          baseSource: "",
        },
      });
      continue;
    }

    const log = attempt(["log", "--format=%H", "--name-only", "--no-renames", update.localSha, "--not", ...bases]);
    if (!log.ok) throw new Error(`git log in this checkout failed: ${log.stdout || "no output"}`);
    const { commits, paths } = parseOutgoingLog(log.stdout);
    updates.push({ ...update, outgoing: { commits, paths, baseSource } });
  }
  return { updates };
}

/* ----------------------------------- cli ---------------------------------- */

const USAGE = `usage: node tools/guard-push.mjs [--hook <remote> <url> | --explain | --audit] [options]

  --hook <remote> <url>   what .githooks/pre-push calls: the refs being pushed
                          arrive on stdin, one per line, in git's own format
  --explain               report what the guard would say about pushing the
                          current branch, without pushing
  --remote <name>         which remote --explain should judge (default origin)
  --allow-workflow <why>  authorise a ${PROTECTED_DIR}/ change in this invocation
  --install               point this checkout's core.hooksPath at .githooks
  --uninstall             undo --install
  --status                report whether the guard is active in this checkout
  --audit                 read the authorisation trail, newest first; never
                          writes it, never truncates it, never pushes
  --limit <n|all>         with --audit: how many records to list (default
                          ${AUDIT_DEFAULT_LIMIT})
  --outcome <which>       with --audit: authorised, refused or all (default all)
  --check                 with --audit: verify every record in the file, and
                          exit 1 when that verification fails
  --help                  this text

  A workflow change is otherwise authorised by
  ${AUTHORIZATION_ENV}="<what it does and why it is intended>".

Exit codes: 0 the push may proceed, 1 refused (or the guard could not decide),
2 a usage error. --audit follows the same rule: 0 when the trail is readable,
1 when a record is not — and 2 for a usage error.`;

/** The hook's arguments plus git's ref updates on stdin. */
function hookFacts({ remote, url }) {
  if (process.stdin.isTTY) {
    throw new Error("--hook expects git's ref updates on stdin; `npm run guard:push` answers the same question about the current branch");
  }
  const { updates, unreadable } = parseRefUpdates(readFileSync(0, "utf8"));
  return { remote, url, updates, unreadable };
}

/** `--explain`: the current branch against the ref this checkout tracks for it. */
function explainFacts({ remote }) {
  const branch = gitTry(["symbolic-ref", "--short", "-q", "HEAD"]).stdout;
  if (!branch) throw new Error("HEAD is detached, so there is no branch to explain; the hook judges whatever ref git is pushing");
  const tracked = gitTry(["rev-parse", "-q", "--verify", `refs/remotes/${remote}/${branch}`]);
  return {
    remote,
    url: gitTry(["remote", "get-url", remote]).stdout,
    updates: [
      {
        localRef: `refs/heads/${branch}`,
        localSha: gitOut(["rev-parse", "HEAD"]),
        remoteRef: `refs/heads/${branch}`,
        remoteSha: tracked.ok ? tracked.stdout : "0".repeat(40),
        deletion: false,
      },
    ],
    unreadable: [],
  };
}

function installHooks() {
  const existing = gitTry(["config", "--get", "core.hooksPath"]).stdout;
  if (existing === ".githooks") {
    console.log("the guard is already installed: core.hooksPath is .githooks");
    return 0;
  }
  if (existing) {
    console.error(`refusing to overwrite core.hooksPath, which is already ${existing}.`);
    console.error("Two hook paths cannot both be active, so this one is yours to reconcile:");
    console.error("  git config core.hooksPath .githooks      # use this repository's hooks instead");
    console.error("The guard also works with no hook at all: run `npm run guard:push` before pushing.");
    return 1;
  }
  const result = gitTry(["config", "core.hooksPath", ".githooks"]);
  if (!result.ok) {
    console.error(`could not set core.hooksPath: ${result.stderr || "git refused"}`);
    return 1;
  }
  const hook = join(gitOut(["rev-parse", "--show-toplevel"]), ".githooks", "pre-push");
  console.log("installed: core.hooksPath is now .githooks, so every push runs .githooks/pre-push.");
  console.log(existsSync(hook) ? `hook       : ${hook}` : `WARNING: ${hook} is missing`);
  console.log("This is a local setting, not a committed one — a fresh clone has to run this again.");
  console.log("undo with: git config --unset core.hooksPath");
  return 0;
}

function uninstallHooks() {
  const existing = gitTry(["config", "--get", "core.hooksPath"]).stdout;
  if (!existing) {
    console.log("nothing to undo: core.hooksPath is not set in this checkout.");
    return 0;
  }
  if (existing !== ".githooks") {
    console.log(`leaving core.hooksPath alone: it is ${existing}, not .githooks.`);
    return 0;
  }
  gitTry(["config", "--unset", "core.hooksPath"]);
  console.log("uninstalled: core.hooksPath is unset, so pushes no longer run the guard.");
  return 0;
}

/**
 * Whether the hook is executable *where it matters*: the index, because that is
 * what a clone receives. A working-tree check would answer the wrong question on
 * Windows, where every file reports the same mode and git runs hooks through its
 * own `sh` regardless of the bit.
 */
function hookExecutable(present, indexMode, hook) {
  if (!present) return "n/a — the hook file is missing";
  if (indexMode === "100755") return "yes — 100755 in the index, so every clone gets the bit";
  if (indexMode) return `no — ${indexMode} in the index, and a POSIX checkout skips a hook without the executable bit`;
  if (process.platform === "win32") return "this file is not tracked in this checkout; Windows runs hooks through sh and ignores the bit";
  return statSync(hook).mode & 0o111 ? "yes, in this working tree" : "no — git skips a hook that is not executable";
}

function status() {
  const top = gitOut(["rev-parse", "--show-toplevel"]);
  const configured = gitTry(["config", "--get", "core.hooksPath"]).stdout;
  const hook = join(top, ".githooks", "pre-push");
  const present = existsSync(hook);
  const indexMode = (gitTry(["ls-files", "-s", "--", ".githooks/pre-push"]).stdout.split(/\s+/)[0] ?? "").trim();
  console.log(`checkout      : ${top}`);
  console.log(`core.hooksPath: ${configured || "(unset — the guard is not active in this checkout)"}`);
  console.log(`hook file     : ${present ? hook : `${hook} (missing)`}`);
  console.log(`executable    : ${hookExecutable(present, indexMode, hook)}`);
  console.log(configured === ".githooks" ? "the guard runs on every push from this checkout." : "enable it with: npm run guard:install");
  console.log("with no hook the guard still works: run `npm run guard:push` before pushing.");
  return 0;
}

/**
 * `--audit`: read the trail, and never write it.
 *
 * The trail is the one artifact here that a person has to be able to *read back*,
 * so this mode exists to answer "what was authorised, by whom, and why" without
 * anyone opening the file in an editor. It is read-only by construction — there
 * is no write call in it, the file is opened for reading, and the path it reads
 * is reported before anything else — and it reports the difference a reader has
 * to keep straight: a record says the hook allowed a push to proceed, which is
 * not the same as GitHub accepting it, and refusals are not in the file at all.
 */
function auditCommand(argv) {
  let limit = String(AUDIT_DEFAULT_LIMIT);
  let outcome = "all";
  let check = false;

  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === "--audit") continue;
    if (arg === "--check") {
      check = true;
      continue;
    }
    if (arg === "--limit") {
      limit = argv[(at += 1)];
      continue;
    }
    if (arg === "--outcome") {
      outcome = argv[(at += 1)];
      continue;
    }
    console.error(`${USAGE}\n\nunknown option for --audit: ${arg}`);
    return 2;
  }

  if (limit === undefined || (limit !== "all" && !/^\d+$/.test(limit))) {
    console.error(`${USAGE}\n\n--audit --limit takes a count or "all".`);
    return 2;
  }
  if (!["all", "authorised", "refused"].includes(outcome)) {
    console.error(`${USAGE}\n\n--audit --outcome takes authorised, refused or all.`);
    return 2;
  }

  // A trail named outright needs no repository, which is what makes this
  // readable from anywhere — a copy of the file, or a checkout whose .git has
  // already been taken away.
  const configured = process.env[AUDIT_PATH_ENV];
  const gitDir = gitTry(["rev-parse", "--absolute-git-dir"]).stdout;
  if (!configured && !gitDir) {
    console.error("refused: there is no trail to read — this is not a git working tree, and");
    console.error(`${AUDIT_PATH_ENV} is not set either, so where the trail lives cannot be established.`);
    console.error(`In a checkout it is <git dir>/${AUDIT_FILE}, which appears the first time a workflow change is authorised.`);
    return 1;
  }
  const trailPath = configured || join(gitDir, AUDIT_FILE);

  if (!existsSync(trailPath)) {
    console.log(`trail    : ${trailPath}`);
    console.log("records  : none — there is no file there, so nothing has been authorised from this checkout.");
    if (check) console.log("check    : PASS — nothing is recorded, so there is nothing to verify.");
    return 0;
  }

  let text = "";
  let size = 0;
  let lastWritten = "unknown";
  try {
    const stat = statSync(trailPath);
    size = stat.size;
    lastWritten = stat.mtime.toISOString();
    text = readFileSync(trailPath, "utf8");
  } catch (error) {
    console.error(`refused: ${trailPath} could not be read — ${error.message}`);
    console.error("Nothing was read, so nothing was reported, checked or changed.");
    return 1;
  }

  const { records, empty } = readAuditTrail(text);
  const summary = summariseAudit(records);

  console.log(`trail    : ${trailPath}`);
  console.log(`file     : ${size} byte(s), last written ${lastWritten}${empty ? ", and empty" : ""}`);
  if (!records.length) {
    console.log("records  : none — the file exists but holds no record, so no authorisation has been written here.");
    if (check) console.log("check    : PASS — nothing is recorded, so there is nothing to verify.");
    return 0;
  }

  console.log(
    `records  : ${summary.total} — authorised ${summary.authorised}, refused ${summary.refused}, malformed ${summary.malformed}, incomplete ${summary.incomplete}`
  );
  if (summary.first) console.log(`span     : ${summary.first.toISOString()} → ${summary.last.toISOString()}`);

  // A malformed or incomplete record is always listed whatever the filter says:
  // a filter is for the events somebody meant to record, and hiding a line that
  // could not be read is how a trail becomes a story.
  const kept = records.filter(
    (record) => outcome === "all" || record.status === outcome || record.status === "malformed" || record.status === "incomplete"
  );
  const newestFirst = [...kept].reverse();
  const shown = limit === "all" ? newestFirst : newestFirst.slice(0, Number(limit));

  // A missing field and an empty one are printed differently, because a reader
  // has to be able to tell "the record does not say" from "the record says there
  // was nothing" — and `files=""` is a real shape, not a gap. The remote is
  // redacted on the way out as well as on the way in: a record written before
  // the writer redacted it must not have its credential printed back at whoever
  // is reading the trail to find out what happened.
  const value = (field, fallback) => (field === null || field === undefined ? "(missing)" : inOneLine(field) || fallback);
  const destinations = (record) => (record.remote === null ? "(missing)" : inOneLine(redactUrl(record.remote)) || "(none)");

  console.log("");
  if (!shown.length) console.log(`no record matches --outcome ${outcome}.`);
  for (const record of shown) {
    console.log(`#${record.index}  ${inOneLine(record.when) || "(no timestamp)"}  ${inOneLine(record.status)}${record.legacy ? " (legacy record)" : ""}`);
    if (record.status === "malformed") {
      for (const problem of record.problems) console.log(`     ${inOneLine(problem)}`);
      console.log(`     the line, verbatim: ${inOneLine(record.raw).slice(0, 200)}`);
      continue;
    }
    if (record.status === "incomplete") {
      for (const missing of record.incomplete) console.log(`     ${inOneLine(missing)}`);
    }
    console.log(`     remote ${destinations(record)} → ${value(record.refs, "(no ref named)")}`);
    console.log(`     files  ${value(record.files, "(none named — the change it covered was not established)")}`);
    console.log(`     ${value(record.commits, "(missing)")} commit(s), authorised by ${value(record.source, "(no source named)")}`);
    // Quoted by hand rather than with JSON.stringify, which would escape the
    // backslash `inOneLine` has just added and print every control character as
    // two of them.
    console.log(`     reason ${record.reason === null ? "(missing)" : `"${inOneLine(record.reason)}"`}`);
    for (const warning of record.warnings) console.log(`     note: ${inOneLine(warning)}`);
  }
  if (shown.length < kept.length) {
    console.log(`\n… ${kept.length - shown.length} more record(s) not listed — \`--limit all\` lists every one.`);
  }

  console.log("");
  console.log("A record here says the hook let an authorised workflow change leave. It does not say GitHub");
  console.log("accepted the push, and it cannot: a pre-push hook runs before anything is sent. Refusals are");
  console.log("not recorded — they are reported to whoever is pushing — so an absence of refused records is");
  console.log("not evidence that none happened. The file is inside .git, which anyone who can push can also");
  console.log("edit: it is a local trail, not a tamper-proof control.");

  if (!check) return 0;

  const failures = [];
  const verify = (name, bad, pass, fail) => {
    console.log(`${bad ? "FAIL" : "PASS"}  ${name} — ${bad ? fail : pass}`);
    if (bad) failures.push(name);
  };
  console.log("");
  verify(
    "every record could be read",
    summary.malformed,
    `all ${summary.total} record(s)`,
    `${summary.malformed} record(s) cannot be read as a record, and a line that cannot be read is not evidence`
  );
  verify(
    "every record is complete",
    summary.incomplete,
    `all ${summary.total} record(s)`,
    `${summary.incomplete} record(s) are missing a field or were cut short mid-write`
  );
  verify(
    "no record stores a credential",
    summary.credentials,
    "no remote value carries userinfo",
    `${summary.credentials} record(s) hold a remote value with userinfo — remove those lines, and see DEPLOY.md §9 for why they can exist at all`
  );
  verify(
    `every recorded path is under ${PROTECTED_DIR}/`,
    summary.unprotected,
    "every named path is protected, or none is named",
    `${summary.unprotected} record(s) name a path a guard authorisation cannot cover`
  );
  console.log("");
  console.log(`checked all ${summary.total} record(s) in the file, not only the ${shown.length} listed.`);
  if (summary.legacy) console.log(`note: ${summary.legacy} record(s) predate the kind= field and are read as authorisations.`);
  if (summary.outOfOrder.length) {
    console.log(
      `note: the record(s) at line ${summary.outOfOrder.join(", ")} are out of timestamp order. Reported, not failed: each record is one append, and two pushes at the same moment can be appended either way round.`
    );
  }
  if (summary.warnings) console.log(`note: ${summary.warnings} warning(s) across the file, listed above with the record they belong to.`);
  console.log("not checked: whether any push was accepted (a hook cannot see that), and refusals, which are not recorded.");
  console.log(
    failures.length
      ? `FAILED — ${failures.length} check(s): ${failures.join("; ")}`
      : "PASSED — every record is readable, complete, and names only what a guard authorisation can name."
  );
  return failures.length ? 1 : 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }

  if (argv.includes("--install")) return installHooks();
  if (argv.includes("--uninstall")) return uninstallHooks();
  if (argv.includes("--status")) return status();
  if (argv.includes("--audit")) return auditCommand(argv);

  const takesValue = ["--hook", "--remote", "--allow-workflow"];
  const known = [...takesValue, "--explain"];
  const unknown = argv.filter((arg, index) => arg.startsWith("-") && !known.includes(arg) && !takesValue.includes(argv[index - 1]));
  if (unknown.length) {
    console.error(`${USAGE}\n\nunknown option: ${unknown.join(", ")}`);
    return 2;
  }

  const mode = argv.includes("--hook") ? "hook" : argv.includes("--explain") ? "explain" : null;
  if (!mode) {
    console.error(`${USAGE}\n\nchoose --hook (what the pre-push hook calls) or --explain.`);
    return 2;
  }

  const remote = argv.includes("--remote")
    ? argv[argv.indexOf("--remote") + 1]
    : mode === "hook"
      ? argv[argv.indexOf("--hook") + 1]
      : "origin";
  if (!remote) {
    console.error(`${USAGE}\n\n--hook needs the remote's name, which git passes to the hook as its first argument.`);
    return 2;
  }

  const wantsCliReason = argv.includes("--allow-workflow");
  const cliReason = wantsCliReason ? (argv[argv.indexOf("--allow-workflow") + 1] ?? null) : null;
  if (wantsCliReason && cliReason === null) {
    console.error(`${USAGE}\n\n--allow-workflow needs the reason as its argument.`);
    return 2;
  }

  const top = gitTry(["rev-parse", "--show-toplevel"]).stdout;
  if (!top) {
    console.error("refused: this is not a git working tree, so no push can be judged here.");
    return 1;
  }
  process.chdir(top);

  const facts =
    mode === "hook"
      ? hookFacts({
          remote,
          url: argv[argv.indexOf("--hook") + 2] ?? gitTry(["remote", "get-url", remote]).stdout,
        })
      : explainFacts({ remote });

  const gathered = gatherPush({ remote, refUpdates: facts.updates });
  const result = assessPush({
    remote,
    url: facts.url,
    updates: gathered.updates,
    unreadable: facts.unreadable,
    authorization: authorizationFrom(process.env, cliReason),
  });

  const auditPath = process.env[AUDIT_PATH_ENV] || join(gitOut(["rev-parse", "--absolute-git-dir"]), AUDIT_FILE);
  let auditCheck;
  if (result.audit.needed && mode === "hook") {
    try {
      appendFileSync(auditPath, `${auditLine(result.audit)}\n`, { encoding: "utf8" });
      auditCheck = {
        name: "the authorisation was recorded",
        status: "pass",
        detail: `${auditPath} — ${JSON.stringify(result.audit.reason)}`,
      };
    } catch (error) {
      auditCheck = {
        name: "the authorisation was recorded",
        status: "fail",
        detail: `could not write ${auditPath} (${error.message}) — an authorisation that cannot be recorded is not one`,
      };
    }
  } else {
    auditCheck = {
      name: "the authorisation was recorded",
      status: "skip",
      detail:
        mode === "explain"
          ? "this is --explain: it reports what would happen, and the audit line is written when the hook lets a real push through"
          : "no workflow change was authorised, so there is nothing to record",
    };
  }

  const allowed = result.allowed && auditCheck.status !== "fail";
  const checks = [...result.checks, auditCheck];
  console.log(`remote     : ${redactUrl(remote)} ${redactUrl(facts.url) || "(no URL)"}`);
  console.log(
    `pushing    : ${
      facts.updates
        .map((update) =>
          update.deletion
            ? `${update.remoteRef} (delete)`
            : `${update.localRef} → ${update.remoteRef} ← ${update.localSha.slice(0, 7)}`
        )
        .join(", ") || "nothing"
    }`
  );
  console.log("");
  for (const check of checks) console.log(`${check.status.toUpperCase().padEnd(4)}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const skipped = checks.filter((check) => check.status === "skip").length;
  console.log("");
  console.log(
    `${passed} passed, ${failed} failed, ${skipped} skipped — ${allowed ? "no unauthorised workflow change is leaving" : "refused, nothing was pushed"}`
  );
  if (!allowed) {
    console.log("");
    console.log(`To authorise a ${PROTECTED_DIR}/ change, say why, and it will be recorded:`);
    console.log(`  ${AUTHORIZATION_ENV}="<what this change does and why it is intended>" git push`);
    console.log(`The line goes to ${join(gitTry(["rev-parse", "--absolute-git-dir"]).stdout, AUDIT_FILE)} — inside .git, so it can never be committed.`);
    console.log("`git push --no-verify` skips this hook entirely, and CI does not check this for you (DEPLOY.md §9).");
  } else if (mode === "explain") {
    console.log("\nThis was --explain: nothing was pushed, and no audit line was written.");
  }
  return allowed ? 0 : 1;
}

// Only when run as a command: the tests import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main());
  } catch (error) {
    // Fail closed: a guard that cannot decide must not be indistinguishable from
    // one that decided "go".
    console.error(`refused: the push guard could not decide — ${error.message}`);
    console.error("Nothing was checked, so nothing was allowed. DEPLOY.md §9 has the rules and the remedy.");
    process.exit(1);
  }
}
