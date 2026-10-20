/**
 * Creates one account through the same authentication path every other account
 * uses: a random salt and a scrypt hash, stored in the users table. Nothing
 * here invents a second way to log in, and nothing here writes the password
 * anywhere — not to the database, not to a log, not to a file.
 *
 * It is idempotent in the direction that matters for money: if the account
 * already exists it is left exactly as it is. Re-running the command can
 * therefore never reset a balance a trader has been using.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node tools/provision-account.mjs \
 *     --email smartmind254@gmail.com --name "Smart Mind" --real 9 --demo 10000
 *
 * The password is read from the terminal with echo off, or from stdin when it
 * is redirected:
 *   node tools/provision-account.mjs --email ... < password.txt
 *
 * The demo win rate is not set here. It is a server-side rule keyed by email
 * (tools/account-rules.mjs), so the browser never receives it and no request
 * can change it.
 */
import crypto from "node:crypto";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createStore } from "./store.mjs";
import { demoWinRateForEmail } from "./account-rules.mjs";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** The same hash the register route produces, so login verifies it unchanged. */
const hash = (password, salt) => crypto.scryptSync(password, salt, 32).toString("hex");

/** A complete users row, without touching the store. Exported for the tests. */
export function accountRecord({ email, name, password, realBalance = 9, demoBalance = 10000 }) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: `u_${crypto.randomBytes(6).toString("hex")}`,
    email: String(email || "").trim().toLowerCase(),
    username: String(name || "").trim() || "Trader",
    salt,
    password_hash: hash(password, salt),
    is_demo: true,
    demo_balance: Number(demoBalance),
    real_balance: Number(realBalance),
    two_factor_enabled: false,
    referral_code: crypto.randomBytes(3).toString("hex").toUpperCase(),
    created_at: new Date().toISOString(),
  };
}

/**
 * Creates the account if it is absent. Returns `{ created, user }`; `created`
 * is false when the account was already there, in which case no field — and no
 * balance — has been touched.
 */
export async function provisionAccount(store, { email, name, password, realBalance = 9, demoBalance = 10000 }) {
  const clean = String(email || "").trim().toLowerCase();
  if (!EMAIL.test(clean)) throw new Error(`Not an email address: ${email}`);
  if (!password || String(password).length < 6) throw new Error("Password must be at least 6 characters");
  if (!(Number(realBalance) >= 0) || !(Number(demoBalance) >= 0)) {
    throw new Error("Balances must be zero or greater");
  }

  const existing = await store.findUserByEmail(clean);
  if (existing) return { created: false, user: existing };

  const user = await store.createUser(
    accountRecord({ email: clean, name, password, realBalance, demoBalance })
  );
  return { created: true, user };
}

/* ------------------------------- command ------------------------------- */

function parseArgs(argv) {
  const out = { real: 9, demo: 10000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--email") out.email = take();
    else if (arg === "--name") out.name = take();
    else if (arg === "--real") out.real = Number(take());
    else if (arg === "--demo") out.demo = Number(take());
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

const USAGE = `usage: node tools/provision-account.mjs --email <address> [--name <display name>]
                                          [--real 9] [--demo 10000]

DATABASE_URL must name the ledger to create the account in. The password is
read from the terminal (echo off) or from stdin. Re-running is safe: an existing
account is reported and left untouched.`;

/** Echo off on a terminal, first line of stdin when it is redirected. */
function readPassword() {
  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      const write = rl._writeToOutput.bind(rl);
      // Mask the keystrokes, but not the Enter that submits them.
      rl._writeToOutput = (text) => write(/[\r\n]/.test(text) ? text : "*");
      rl.question("Password: ", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
    });
  }
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(String(data).split(/\r?\n/)[0]));
  });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.email) {
    console.error(`--email is required\n\n${USAGE}`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — provisioning an in-memory ledger would create nothing durable.");
    process.exit(2);
  }

  const password = await readPassword();
  const store = await createStore({ production: false });
  try {
    const { created, user } = await provisionAccount(store, {
      email: args.email,
      name: args.name,
      password,
      realBalance: args.real,
      demoBalance: args.demo,
    });
    const rate = demoWinRateForEmail(user.email);
    if (!created) {
      console.log(`${user.email} already exists — left untouched (demo ${user.demo_balance}, real ${user.real_balance}).`);
    } else {
      console.log(`created ${user.email} (${user.id})`);
      console.log(`  demo balance : ${user.demo_balance}`);
      console.log(`  real balance : ${user.real_balance}`);
    }
    console.log(rate == null ? "  demo rule    : none (settles naturally)" : `  demo rule    : ${Math.round(rate * 100)}% target win rate`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
