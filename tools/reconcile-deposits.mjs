/**
 * Operator CLI for deposit reconciliation.
 *
 * This is the manual, restricted trigger: it needs a shell on the host and a
 * DATABASE_URL, and it refuses without one, because reconciliation against a
 * process-local store would be theatre — the deposits live in the database, and
 * so does the record of what was tried.
 *
 * Nothing here is routed over HTTP, deliberately: a public "reconcile now"
 * endpoint would let anyone drive this server into hammering Safaricom.
 *
 * Usage:
 *   DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --dry-run
 *   DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --once
 *   DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --reference PAL_abc123
 *   DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --watch
 *
 * Credentials come from the environment or .env.local, exactly as the server
 * reads them. They are never printed, and no provider response body is either.
 */
import { createStore } from "./store.mjs";
import { createPaymentRoutes, defaultProviders, config as paymentConfig } from "./payments.mjs";
import { reconcileConfig } from "./reconcile.mjs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1] ?? true;
};

const once = argv.includes("--once") || argv.length === 0;
const watch = argv.includes("--watch");
const dryRun = argv.includes("--dry-run");
const asJson = argv.includes("--json");
const reference = typeof flag("reference") === "string" ? flag("reference") : null;
const limit = Number(flag("limit", 25)) || 25;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set, so there is no ledger to reconcile. This tool will not");
  console.error("pretend a process-local store is the deposit database. Pass it inline:");
  console.error("  DATABASE_URL=postgres://... node tools/reconcile-deposits.mjs --dry-run");
  process.exit(2);
}

const store = await createStore({ production: true });
const reconcileOpts = reconcileConfig();

// The routes own the only crediting path, so the CLI borrows it rather than
// calling settlement itself. `requireUser` is never reached: nothing here is
// served over HTTP.
const payments = createPaymentRoutes({
  store,
  requireUser: async () => {
    throw new Error("the reconciliation CLI authenticates nobody");
  },
  providers: dryRun
    ? {
        ...defaultProviders(),
        darajaStkQuery: async () => {
          throw Object.assign(new Error("dry run: no provider was contacted"), { code: "RECONCILE_DRY_RUN" });
        },
      }
    : defaultProviders(),
  reconcile: reconcileOpts,
  logger: { log: (m) => console.log(m), warn: (m) => console.warn(m), error: (m) => console.error(m) },
});

const reconciler = payments._reconcile;
const daraja = paymentConfig().daraja;

if (!asJson) {
  console.log(`reconciling against ${String(process.env.DATABASE_URL).replace(/:[^:@/]+@/, ":***@")}`);
  console.log(
    `  provider    : Daraja ${daraja.environment}${daraja.configured ? "" : " — NOT CONFIGURED (queries will refuse)"}`
  );
  console.log(
    `  policy      : pending > ${Math.round(reconcileOpts.afterMs / 1000)}s, up to ${reconcileOpts.maxAttempts} attempts,` +
      ` backoff ${Math.round(reconcileOpts.backoffMs / 1000)}s → ${Math.round(reconcileOpts.maxBackoffMs / 1000)}s`
  );
  console.log(dryRun ? "  mode        : DRY RUN — listing due deposits, contacting nothing\n" : "  mode        : live queries\n");
}

/** Lists what the worker would consider, without querying the provider. */
async function listDue() {
  const now = Date.now();
  const due = await store.listReconcilableDeposits({ now, olderThanMs: reconcileOpts.afterMs, limit });
  for (const d of due) {
    console.log(
      `  due  ${d.reference}  $${d.usd_amount}  (${d.settlement_amount} ${d.settlement_currency})` +
        `  checkout ${d.checkout_request_id}  attempts ${d.recon_attempts}  created ${d.created_at}`
    );
  }
  if (!due.length) console.log("  nothing is due");
  return due;
}

/** Reconciles one named deposit, bypassing the age threshold. */
async function reconcileReference(reference) {
  const deposit = await store.findDeposit(reference);
  if (!deposit) {
    console.error(`no deposit matches ${reference}`);
    return 2;
  }
  console.log(
    `  found ${deposit.reference}: status ${deposit.status}, method ${deposit.method}, checkout ${deposit.checkout_request_id || "none"}`
  );
  if (deposit.status !== "pending") {
    console.log(`  a ${deposit.status} deposit is never reconciled automatically — nothing to do`);
    return 0;
  }
  if (!deposit.checkout_request_id) {
    console.error("  this deposit has no CheckoutRequestID, so there is nothing to ask Safaricom about");
    return 2;
  }
  const result = await reconciler.reconcileOne(deposit);
  console.log(`  ${JSON.stringify(result)}`);
  return result.outcome === "error" ? 1 : 0;
}

async function run() {
  if (reference) return reconcileReference(reference);
  if (dryRun) {
    await listDue();
    return 0;
  }
  if (once) {
    const summary = await reconciler.runOnce({ reason: "cli" });
    console.log(asJson ? JSON.stringify(summary, null, 2) : `  ${JSON.stringify(summary)}`);
    return 0;
  }
  return 0;
}

let exitCode = 0;
try {
  if (watch) {
    // Same interval the server uses, so an operator can watch what the worker is
    // doing without guessing. Ctrl-C stops the run in flight first.
    console.log(`  watching every ${Math.round(reconcileOpts.intervalMs / 1000)}s — Ctrl-C to stop\n`);
    reconciler.start();
    const stopAll = async (signal) => {
      console.log(`\n${signal} received — waiting for the run in flight`);
      await reconciler.stop();
      await store.close();
      process.exit(0);
    };
    process.on("SIGINT", () => stopAll("SIGINT"));
    process.on("SIGTERM", () => stopAll("SIGTERM"));
  } else {
    exitCode = await run();
  }
} catch (err) {
  console.error(`reconciliation failed: ${(err && err.message) || err}`);
  exitCode = 1;
} finally {
  if (!watch) await store.close();
}

if (!watch) process.exit(exitCode);
