/**
 * Refuses to let a test command report success having run no tests.
 *
 * WHY THIS EXISTS. `node --test <glob>` exits 0 when the glob matches nothing.
 * That is not a theory: renaming `tests/postgres` and running
 * `npm run test:postgres` prints `tests 0 / pass 0` and **succeeds**. On a
 * developer's machine that is a curiosity. In CI it is the failure mode that
 * matters most, because CI only ever sees *committed* files — a suite that is
 * written but uncommitted produces a green pipeline that executed none of it,
 * and a green pipeline nobody can trust is worse than no pipeline.
 *
 * So each test command runs this first:
 *
 *   node tools/check-suites.mjs postgres && node --test tests/postgres/*.test.mjs
 *
 * It is also useful on its own — `node tools/check-suites.mjs` answers "are all
 * three suites actually here?" before a release, without running anything.
 *
 * Usage:
 *   node tools/check-suites.mjs              # every group
 *   node tools/check-suites.mjs postgres     # just the database suites
 *   node tools/check-suites.mjs postgres stress
 *
 * Exit codes: 0 when every requested group has at least one test file, 2 for an
 * unknown group name, 1 when a group is empty.
 */
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A group is a directory and the file pattern the runner is pointed at. Not
 * recursive: `tests` deliberately does not include the subdirectories, because
 * `npm test` does not either.
 */
const GROUPS = {
  memory: { dir: "tests", description: "in-memory suites (npm test)" },
  postgres: { dir: "tests/postgres", description: "PostgreSQL suites (test:postgres)" },
  stress: { dir: "tests/postgres/stress", description: "contention suites (test:postgres:stress)" },
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(GROUPS);

const unknown = names.filter((name) => !GROUPS[name]);
if (unknown.length) {
  console.error(`unknown group(s): ${unknown.join(", ")}`);
  console.error(`known groups: ${Object.keys(GROUPS).join(", ")}`);
  process.exit(2);
}

const empty = [];
for (const name of names) {
  const { dir, description } = GROUPS[name];
  let entries = [];
  try {
    entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  } catch {
    // A group whose directory is missing is the loudest case, not an error to
    // swallow: it means the suite was never written, or never committed.
  }
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".test.mjs"))
    .map((e) => e.name)
    .sort();

  if (files.length === 0) {
    empty.push(`${name} (${dir}/): ${description}`);
  } else {
    console.log(`  ${name.padEnd(9)} ${String(files.length).padStart(2)} file(s) — ${files.join(", ")}`);
  }
}

if (empty.length) {
  console.error("");
  for (const line of empty) console.error(`no test files found for ${line}`);
  console.error("");
  console.error("The command that follows would run nothing and still exit 0, reporting success");
  console.error("for tests that never executed. Refusing instead.");
  console.error("");
  console.error("If the files exist locally but not here, they are uncommitted — and a CI");
  console.error("checkout only ever contains committed files.");
  process.exit(1);
}
