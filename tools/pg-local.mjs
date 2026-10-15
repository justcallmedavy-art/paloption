/**
 * A disposable local PostgreSQL, for the suites that need a real server.
 *
 * WHY THIS EXISTS. `npm run test:postgres` proves things the in-memory run
 * cannot: that the claim on a deposit is atomic across connections, that a
 * receipt cannot be reused, that a settlement rolls back cleanly. Those are
 * database behaviours, so they need a database — and until now the honest answer
 * on a machine without one was "cannot run".
 *
 * This boots the genuine article rather than an emulation: official PostgreSQL
 * binaries (prebuilt by the same project that produces the containers), started
 * as the current user, in a directory this repository ignores. No installer, no
 * administrator rights, no service registered, nothing in `Program Files`. The
 * data directory lives under `.data/pgdata` (git-ignored) and `stop` or `reset`
 * removes everything this ever created.
 *
 * It is a development convenience, not a deployment path. A deployed instance
 * points DATABASE_URL at a real managed server, exactly as before.
 *
 * Usage:
 *   node tools/pg-local.mjs fetch     # one-time download of the binaries (~23 MB)
 *   node tools/pg-local.mjs start     # initdb if needed, then start, then wait
 *   node tools/pg-local.mjs url       # print PG_TEST_DATABASE_URL, creating the database
 *   node tools/pg-local.mjs status
 *   node tools/pg-local.mjs stop
 *   node tools/pg-local.mjs reset     # drop and recreate the test database
 *
 * Then:
 *   export PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)"
 *   npm run test:postgres
 *
 * Everything is bound to 127.0.0.1 and uses `trust` authentication, which is
 * safe precisely because it listens on loopback only. Never point this at a
 * routable address: with trust authentication, reachability is authorisation.
 */
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PG_DIR = process.env.PG_LOCAL_DIR || join(ROOT, ".tools", "pg");
const DATA_DIR = join(ROOT, ".data", "pgdata");
const LOG_PATH = join(ROOT, ".data", "pg.log");

const PORT = Number(process.env.PG_LOCAL_PORT || 55432);
const HOST = "127.0.0.1";
/** The database the suites create their own throwaway schemas inside. */
const TEST_DB = process.env.PG_LOCAL_DB || "paloption_test";
/** Binaries published per version; the default is the current stable line. */
const PG_VERSION = process.env.PG_LOCAL_VERSION || "16.4.0";
/**
 * Which build to download, or nothing at all off Windows.
 *
 * Matching on `process.arch` alone was wrong: on Linux x64 it selected the
 * Windows artifact, downloaded it, and then failed with a message about a
 * missing executable. The platform is now part of the question, and the answer
 * off Windows is a clear instruction rather than a broken download.
 */
const ARCH =
  process.platform === "win32"
    ? { x64: "windows-amd64", arm64: "windows-arm64v8" }[process.arch]
    : null;

const NON_WINDOWS = [
  `This helper installs the Windows build of PostgreSQL, and this is ${process.platform}.`,
  "",
  "Use a container or a server you already have, and point the suites at it:",
  "  docker run --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16",
  "  PG_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/paloption_test' \\",
  "    npm run test:postgres",
  "",
  'See PAYMENTS.md, "A PostgreSQL for the suites".',
].join("\n");

const binary = (name) => join(PG_DIR, "bin", `${name}.exe`);
const url = (database = TEST_DB) =>
  `postgresql://postgres@${HOST}:${PORT}/${database}`;

/**
 * Progress goes to stderr when stdout is reserved for a captured value.
 *
 * `url` prints one line because the documented way to use it is
 * `PG_TEST_DATABASE_URL="$(node tools/pg-local.mjs url)"`. A status line mixed
 * into that capture produces a connection string that fails somewhere unrelated
 * — the hostname parses as "base" — which is the kind of broken that costs an
 * hour to spot.
 */
let stdoutIsReserved = false;
const say = (msg) => (stdoutIsReserved ? console.error(msg) : console.log(msg));

/* ------------------------------ provisioning ------------------------------ */

/**
 * Downloads the prebuilt binaries and unpacks them.
 *
 * Two archives deep, which is not obvious: the published artifact is a Maven
 * `.jar`, and inside it is a `.txz`. The outer one is a zip, and Windows ships
 * bsdtar (`System32\tar.exe`) which reads zip — but a GNU tar earlier on PATH
 * would shadow it, so the system one is preferred by full path. The inner one
 * is xz, which GNU tar reads. Hence one of each.
 */
async function fetchBinaries() {
  if (process.platform !== "win32") throw new Error(NON_WINDOWS);
  if (!ARCH) throw new Error(`unsupported architecture: ${process.arch}`);
  await mkdir(join(ROOT, ".tools"), { recursive: true });

  const jar = join(ROOT, ".tools", `pg-${PG_VERSION}.jar`);
  const maven =
    `https://repo1.maven.org/maven2/io/zonky/test/postgres/` +
    `embedded-postgres-binaries-${ARCH}/${PG_VERSION}/` +
    `embedded-postgres-binaries-${ARCH}-${PG_VERSION}.jar`;

  say(`downloading PostgreSQL ${PG_VERSION} binaries…`);
  const res = await fetch(maven);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} from ${maven}`);

  const expected = Number(res.headers.get("content-length")) || 0;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(jar));

  const { size } = await stat(jar);
  if (expected && size !== expected) {
    // A truncated download unpacks into a plausible-looking directory that fails
    // later with a confusing error, so it is caught here instead.
    throw new Error(`incomplete download: ${size} of ${expected} bytes`);
  }

  const unzip = process.platform === "win32"
    ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  await rm(PG_DIR, { recursive: true, force: true });
  await mkdir(PG_DIR, { recursive: true });

  const extract = (archive, cwd) => {
    const r = spawnSync(unzip, ["-xf", archive], { cwd, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`could not extract ${archive}`);
  };
  extract(jar, PG_DIR);

  const inner = join(PG_DIR, "postgres-windows-x86_64.txz");
  extract(inner, PG_DIR);

  await rm(jar, { force: true });
  await rm(join(PG_DIR, "META-INF"), { recursive: true, force: true });
  await rm(inner, { force: true });

  const version = spawnSync(binary("postgres"), ["--version"]);
  if (version.status !== 0) throw new Error("the downloaded binaries do not run");
  say(`installed: ${String(version.stdout).trim()} → ${PG_DIR}`);
}

/* -------------------------------- lifecycle -------------------------------- */

async function ping() {
  const client = new Client({ connectionString: url("postgres"), connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function running() {
  const pid = await readFile(join(DATA_DIR, "postmaster.pid"), "utf8")
    .then((s) => Number(s.split("\n")[0]))
    .catch(() => null);
  if (!pid) return false;
  // A pid file outlives the process it describes when the machine or the shell
  // stops it abruptly, so the answer comes from a connection, not the file.
  return (await ping()) ? pid : false;
}

async function ensureInit() {
  const exists = await stat(join(DATA_DIR, "PG_VERSION")).then(
    () => true,
    () => false
  );
  if (exists) return;
  if (!(await stat(binary("initdb")).then(() => true, () => false))) {
    throw new Error(`no PostgreSQL binaries in ${PG_DIR}. Run: node tools/pg-local.mjs fetch`);
  }
  say(`initialising a new cluster in ${DATA_DIR}…`);
  await mkdir(dirname(DATA_DIR), { recursive: true });
  const r = spawnSync(
    binary("initdb"),
    ["-D", DATA_DIR, "-U", "postgres", "--auth=trust", "--encoding=UTF8", "--locale=C"],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
  if (r.status !== 0) throw new Error("initdb failed");
}

async function start() {
  if (await running()) {
    say(`already running on ${HOST}:${PORT}`);
    return;
  }
  await ensureInit();

  // `detached` with stdio on files is what lets the server outlive the shell
  // that started it: without it, closing the terminal takes the database with
  // it and the next test run fails for a reason that looks like a test bug.
  //
  // The descriptor has to be opened synchronously: spawn needs a number, and a
  // write stream that has not been opened yet has no `fd`, which spawn rejects.
  await mkdir(dirname(LOG_PATH), { recursive: true });
  const out = openSync(LOG_PATH, "a");
  let child;
  try {
    child = spawn(
      binary("postgres"),
      ["-D", DATA_DIR, "-p", String(PORT), "-c", `listen_addresses=${HOST}`],
      { detached: true, stdio: ["ignore", out, out], windowsHide: true }
    );
  } finally {
    closeSync(out);
  }
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (await ping()) {
      say(`started on ${HOST}:${PORT} (pid ${child.pid}), logs in ${LOG_PATH}`);
      return;
    }
    if (child.exitCode !== null) break;
  }
  throw new Error(`the server did not accept connections within 30s — see ${LOG_PATH}`);
}

async function stop() {
  const pid = await readFile(join(DATA_DIR, "postmaster.pid"), "utf8")
    .then((s) => Number(s.split("\n")[0]))
    .catch(() => null);
  if (!pid) {
    say("not running");
    return;
  }
  const r = spawnSync(binary("pg_ctl"), ["-D", DATA_DIR, "-m", "fast", "-w", "stop"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    // pg_ctl can fail if the pid file is stale; saying so is better than
    // reporting a stop that did not happen.
    say(`pg_ctl reported failure (exit ${r.status}); the cluster may already be down`);
    process.exitCode = 1;
    return;
  }
  say("stopped");
}

/** Creates the test database if it is missing. Idempotent, so `url` is safe to call. */
async function ensureDatabase() {
  await start();
  const client = new Client({ connectionString: url("postgres") });
  await client.connect();
  try {
    const { rows } = await client.query("select 1 from pg_database where datname = $1", [TEST_DB]);
    if (rows.length === 0) {
      // No parameters are possible in CREATE DATABASE, so the identifier is
      // quoted rather than interpolated raw. TEST_DB comes from the environment.
      await client.query(`CREATE DATABASE "${TEST_DB.replace(/"/g, '""')}"`);
      say(`created database ${TEST_DB}`);
    }
  } finally {
    await client.end();
  }
}

async function reset() {
  await start();
  const client = new Client({ connectionString: url("postgres") });
  await client.connect();
  try {
    const name = `"${TEST_DB.replace(/"/g, '""')}"`;
    await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${name}`);
    say(`recreated database ${TEST_DB}`);
  } finally {
    await client.end();
  }
}

async function status() {
  const pid = await running();
  if (!pid) {
    say(`not running (or not reachable) on ${HOST}:${PORT}`);
    process.exitCode = 1;
    return;
  }
  const version = spawnSync(binary("postgres"), ["--version"]);
  say(`running on ${HOST}:${PORT} (pid ${pid})`);
  say(`  ${String(version.stdout).trim()}`);
  say(`  data: ${DATA_DIR}`);
  say(`  url : ${url()}`);
}

/* ---------------------------------- CLI ---------------------------------- */

const command = process.argv[2] || "status";

// Said once, up front, rather than after a download or a start that cannot work.
if (process.platform !== "win32") {
  console.error(NON_WINDOWS);
  process.exit(1);
}

try {
  if (command === "fetch") await fetchBinaries();
  else if (command === "init") await ensureInit();
  else if (command === "start") await start();
  else if (command === "stop") await stop();
  else if (command === "status") await status();
  else if (command === "reset") await reset();
  else if (command === "url") {
    stdoutIsReserved = true;
    await ensureDatabase();
    // Bare URL on stdout: this is meant to be captured in a shell.
    console.log(url());
  } else {
    console.error(`unknown command: ${command}`);
    console.error("usage: node tools/pg-local.mjs [fetch|init|start|stop|status|reset|url]");
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
