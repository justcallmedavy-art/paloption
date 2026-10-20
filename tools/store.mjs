/**
 * Ledger storage.
 *
 * One API, two implementations:
 *
 *   createMemoryStore()       arrays in this process — used by the test suite
 *                             and by a local run with no database configured
 *   createPostgresStore(...)  the real thing: every write is a SQL statement and
 *                             every multi-step write is one transaction
 *
 * `createStore()` picks Postgres whenever DATABASE_URL is set, and refuses to
 * start in production without it, so a deployed instance cannot silently fall
 * back to process-local state.
 *
 * Two things moved into the database that used to live in application code:
 *
 *   - A deposit is settled exactly once. The appeal to a mutex (which only ever
 *     guarded one process) is gone; the bank's own unique index on the deposit
 *     reference rejects a second ledger entry.
 *   - A position is settled exactly once, claimed by `WHERE settled_at IS NULL`
 *     inside the settling UPDATE, so a restart mid-trade cannot double-pay.
 *
 * Reads hand back the same plain objects the old JSON store did, so callers
 * need not care which implementation is in use. Writes go through the store —
 * mutating a returned object no longer persists anything, deliberately.
 *
 * Usage:
 *   const store = await createStore({ logger: console });
 *   await store.tx(async (t) => { ... });
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, "schema.sql");

/** Money is cents-exact everywhere; never let float drift into a balance. */
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const iso = (v) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const num = (v) => (v == null ? null : Number(v));

/**
 * Managed providers require TLS; a local Postgres usually refuses it. Inferring
 * this from the host keeps one connection string working in both places.
 *
 * Railway needs both answers, which is why the two hostnames are not one
 * pattern: its internal address (`*.railway.internal`) is on the project's
 * private network and does not offer TLS, while the public proxy it hands out
 * for reaching the database from outside (`*.proxy.rlwy.net`, and the older
 * `*.railway.app`) refuses a plaintext connection. Matching only the public ones
 * is what lets a project use either without editing anything.
 */
export const needsSsl = (connectionString) =>
  /sslmode=require|neon\.tech|render\.com|amazonaws\.com|supabase\.|cockroachlabs\.cloud|timescale\.com|rlwy\.net|railway\.app/.test(
    String(connectionString || "")
  );

const BALANCE_COLUMNS = new Set(["demo_balance", "real_balance"]);
function balanceColumn(key) {
  if (!BALANCE_COLUMNS.has(key)) throw new Error(`Not a balance column: ${key}`);
  return key;
}

/* ------------------------------ row mapping ------------------------------ */

const userFromRow = (r) =>
  r && {
    id: r.id,
    email: r.email,
    username: r.username,
    salt: r.salt,
    password_hash: r.password_hash,
    is_demo: r.is_demo,
    demo_balance: Number(r.demo_balance),
    real_balance: Number(r.real_balance),
    two_factor_enabled: r.two_factor_enabled,
    referral_code: r.referral_code,
    created_at: iso(r.created_at),
  };

const positionFromRow = (r) =>
  r && {
    id: r.id,
    user_id: r.user_id,
    asset: r.asset,
    trade_type: r.trade_type,
    direction: r.direction,
    target_digit: r.target_digit == null ? null : Number(r.target_digit),
    stake: Number(r.stake),
    potential_payout: Number(r.potential_payout),
    entry_price: Number(r.entry_price),
    entry_digit: Number(r.entry_digit),
    ticks: Number(r.ticks),
    current_tick: Number(r.current_tick),
    status: r.status,
    is_demo: r.is_demo,
    auto: r.auto,
    exit_price: r.exit_price == null ? null : Number(r.exit_price),
    exit_digit: r.exit_digit == null ? null : Number(r.exit_digit),
    profit_loss: r.profit_loss == null ? null : Number(r.profit_loss),
    created_at: iso(r.created_at),
    closed_at: iso(r.closed_at),
    settled_at: r.settled_at == null ? null : Number(r.settled_at),
  };

const transactionFromRow = (r) =>
  r && {
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    method: r.method,
    reference: r.reference,
    is_demo: r.is_demo,
    status: r.status,
    balance_after: r.balance_after == null ? null : Number(r.balance_after),
    created_at: iso(r.created_at),
  };

const depositFromRow = (r) =>
  r && {
    id: r.id,
    user_id: r.user_id,
    reference: r.reference,
    method: r.method,
    // Null for a method with no provider environment (cards today), and the
    // provider's own name for M-Pesa.
    environment: r.environment ?? null,
    // The number the prompt went to, already masked on the way in.
    msisdn_masked: r.msisdn_masked ?? null,
    amount: Number(r.amount),
    currency: r.currency,
    usd_amount: Number(r.usd_amount),
    settlement_currency: r.settlement_currency,
    settlement_amount: num(r.settlement_amount),
    settlement_rate: num(r.settlement_rate),
    status: r.status,
    is_demo: r.is_demo,
    provider_reference: r.provider_reference,
    checkout_request_id: r.checkout_request_id,
    merchant_request_id: r.merchant_request_id,
    mpesa_result_code: r.mpesa_result_code == null ? null : Number(r.mpesa_result_code),
    failure_reason: r.failure_reason,
    verified_amount: num(r.verified_amount),
    recon_attempts: r.recon_attempts == null ? 0 : Number(r.recon_attempts),
    last_reconciled_at: iso(r.last_reconciled_at),
    next_reconcile_at: iso(r.next_reconcile_at),
    recon_outcome: r.recon_outcome ?? null,
    created_at: iso(r.created_at),
    completed_at: iso(r.completed_at),
  };

const callbackFromRow = (r) =>
  r && {
    id: r.id,
    checkout_request_id: r.checkout_request_id,
    merchant_request_id: r.merchant_request_id,
    result_code: r.result_code == null ? null : Number(r.result_code),
    result_desc: r.result_desc,
    outcome: r.outcome,
    deposit_reference: r.deposit_reference,
    user_id: r.user_id,
    mpesa_receipt: r.mpesa_receipt,
    settlement_error: r.settlement_error,
    received_at: iso(r.received_at),
  };

const emptyDb = () => ({
  users: [],
  sessions: {},
  pending2fa: {},
  positions: [],
  transactions: [],
  deposits: [],
  withdrawals: [],
  trc20_addresses: {},
  idempotency: {},
  mpesa_callbacks: [],
});

/* --------------------------- memory implementation --------------------------- */

/**
 * Arrays in this process. Correct for a single process, which is what the tests
 * and a local run are — it is NOT the production store, and `createStore()`
 * refuses to hand it out in production.
 *
 * `tx()` snapshots and restores, so a throw mid-transaction leaves nothing
 * behind — the same guarantee Postgres gives, so tests written against one
 * behaviour hold for the other.
 */
export function createMemoryStore({ db = emptyDb() } = {}) {
  const state = db;
  state.users ||= [];
  state.sessions ||= {};
  state.pending2fa ||= {};
  state.positions ||= [];
  state.transactions ||= [];
  state.deposits ||= [];
  state.withdrawals ||= [];
  state.trc20_addresses ||= {};
  state.idempotency ||= {};
  state.mpesa_callbacks ||= [];

  let writes = 0;
  let failWrites = false;

  const gate = () => {
    if (failWrites) throw new Error("store write failed (injected)");
    writes += 1;
  };
  const insufficient = () => Object.assign(new Error("Insufficient balance"), { code: "INSUFFICIENT_BALANCE" });

  /**
   * Snapshots state without breaking object identity.
   *
   * Each row is remembered as [reference, fields] rather than as a copy, so a
   * rollback restores the very objects callers may be holding. Replacing them
   * with clones would silently detach every existing reference — the failure
   * mode that made a rolled-back settlement look like an uncredited wallet.
   */
  const snapshotState = () => {
    const snap = {};
    for (const [key, value] of Object.entries(state)) {
      if (Array.isArray(value)) {
        snap[key] = value.map((row) => (row && typeof row === "object" ? [row, { ...row }] : row));
      } else if (value && typeof value === "object") {
        snap[key] = {};
        for (const [k, v] of Object.entries(value)) snap[key][k] = v && typeof v === "object" ? [v, { ...v }] : v;
      } else {
        snap[key] = value;
      }
    }
    return snap;
  };

  /** Puts a snapshot back, in place, keeping every object identity. */
  const restoreState = (snap) => {
    for (const [key, saved] of Object.entries(snap)) {
      if (Array.isArray(saved)) {
        const list = state[key];
        list.length = 0;
        for (const row of saved) {
          if (Array.isArray(row)) {
            const [ref, fields] = row;
            for (const field of Object.keys(ref)) delete ref[field];
            Object.assign(ref, fields);
            list.push(ref);
          } else list.push(row);
        }
      } else if (saved && typeof saved === "object") {
        const map = state[key];
        for (const k of Object.keys(map)) if (!(k in saved)) delete map[k];
        for (const [k, v] of Object.entries(saved)) {
          if (Array.isArray(v)) {
            const [ref, fields] = v;
            for (const field of Object.keys(ref)) delete ref[field];
            Object.assign(ref, fields);
            map[k] = ref;
          } else map[k] = v;
        }
      } else {
        state[key] = saved;
      }
    }
  };

  const api = {
    kind: "memory",
    db: state,
    get writes() {
      return writes;
    },
    get failWrites() {
      return failWrites;
    },
    set failWrites(v) {
      failWrites = v;
    },

    async init() {},
    async close() {},

    async tx(fn) {
      const snapshot = snapshotState();
      try {
        return await fn(api);
      } catch (err) {
        restoreState(snapshot);
        throw err;
      }
    },

    /* users */
    async findUserByEmail(email) {
      return state.users.find((u) => u.email === String(email || "").trim().toLowerCase()) || null;
    },
    async findUserById(id) {
      return state.users.find((u) => u.id === id) || null;
    },
    async createUser(user) {
      gate();
      state.users.push(user);
      return user;
    },
    async updateUser(id, patch) {
      gate();
      const user = state.users.find((u) => u.id === id);
      if (!user) return null;
      Object.assign(user, patch);
      return user;
    },
    async debitAndOpenPosition({ userId, balanceKey, stake, position, transaction }) {
      gate();
      const column = balanceColumn(balanceKey);
      const user = state.users.find((u) => u.id === userId);
      if (!user) throw new Error("Account not found");
      if (Number(user[column] || 0) < Number(stake)) throw insufficient();
      user[column] = round2(Number(user[column]) - Number(stake));
      if (transaction) transaction.balance_after = user[column];
      state.positions.unshift(position);
      state.transactions.unshift(transaction);
      return { settled: true, balance: user[column] };
    },

    /* sessions */
    async createSession(token, userId) {
      gate();
      state.sessions[token] = userId;
    },
    async userIdForToken(token) {
      return state.sessions[token] || null;
    },
    async deleteSession(token) {
      gate();
      delete state.sessions[token];
    },

    /* second factor */
    async savePending2fa(tempToken, { userId, code }) {
      gate();
      state.pending2fa[tempToken] = { userId, code, ts: Date.now() };
    },
    async findPending2fa(tempToken) {
      return state.pending2fa[tempToken] || null;
    },
    async takePending2fa(tempToken) {
      gate();
      const pending = state.pending2fa[tempToken];
      delete state.pending2fa[tempToken];
      return pending || null;
    },

    /* positions */
    async listPositionsByUser(userId) {
      return state.positions.filter((p) => p.user_id === userId);
    },
    async openPositions() {
      return state.positions.filter((p) => p.status === "open");
    },
    async bumpTicks(ids) {
      if (!ids.length) return [];
      gate();
      const touched = [];
      for (const id of ids) {
        const p = state.positions.find((x) => x.id === id && x.status === "open");
        if (!p) continue;
        p.current_tick = Number(p.current_tick || 0) + 1;
        touched.push({ ...p });
      }
      return touched;
    },
    /**
     * Claim and settle one position. The `settled_at` test is the claim: a
     * second call for the same position returns `settled: false` without
     * touching a balance.
     */
    async settlePosition({ positionId, userId, balanceKey, credit, position, transaction }) {
      gate();
      const column = balanceColumn(balanceKey);
      const existing = state.positions.find((p) => p.id === positionId);
      if (!existing || existing.settled_at) return { settled: false };
      Object.assign(existing, position);
      const user = state.users.find((u) => u.id === userId);
      if (user && credit) user[column] = round2(Number(user[column] || 0) + Number(credit));
      if (transaction) transaction.balance_after = user ? user[column] : null;
      if (transaction) state.transactions.unshift(transaction);
      return { settled: true, position: { ...existing }, balance: user ? user[column] : null };
    },

    /* transactions */
    async listTransactionsByUser(userId, limit = 200) {
      return state.transactions.filter((t) => t.user_id === userId).slice(0, limit);
    },
    async latestTransactionByUser(userId) {
      return state.transactions.find((t) => t.user_id === userId) || null;
    },
    async insertTransaction(transaction) {
      gate();
      state.transactions.unshift(transaction);
      return transaction;
    },

    /* deposits */
    async insertDeposit(deposit) {
      gate();
      // Reconciliation bookkeeping is present from birth here, exactly as the
      // column defaults make it in Postgres, so a row has the same shape
      // whichever store handed it back.
      deposit.recon_attempts ??= 0;
      deposit.last_reconciled_at ??= null;
      deposit.next_reconcile_at ??= null;
      deposit.recon_outcome ??= null;
      deposit.environment ??= null;
      deposit.msisdn_masked ??= null;
      state.deposits.unshift(deposit);
      return deposit;
    },
    async findDeposit(reference) {
      return (
        state.deposits.find(
          (d) => d.reference === reference || d.provider_reference === reference || d.id === reference
        ) || null
      );
    },
    /** Same lookup, but inside a transaction the caller holds the row. */
    async lockDeposit(reference) {
      return api.findDeposit(reference);
    },
    /** balance = balance + amount, so a stale copy can never overwrite a debit. */
    async creditBalance({ userId, balanceKey, amount }) {
      gate();
      const column = balanceColumn(balanceKey);
      const user = state.users.find((u) => u.id === userId);
      if (!user) throw new Error("Account not found");
      user[column] = round2(Number(user[column] || 0) + Number(amount));
      return user[column];
    },
    async findDepositByCheckoutId(checkoutRequestId) {
      return state.deposits.find((d) => d.checkout_request_id === checkoutRequestId) || null;
    },
    async updateDeposit(id, patch) {
      gate();
      const deposit = state.deposits.find((d) => d.id === id);
      if (!deposit) return null;
      Object.assign(deposit, patch);
      return deposit;
    },
    /**
     * Fails a deposit only while it is still pending. Returns null otherwise.
     *
     * A late or duplicated provider result must never un-pay money that has
     * already been credited. Flipping a settled deposit back to `failed` leaves
     * the ledger and the deposit row disagreeing, and the depositor is shown
     * "failed" for a payment their own handset confirms they made.
     */
    async failDepositIfUnsettled(id, patch) {
      gate();
      const deposit = state.deposits.find((d) => d.id === id);
      if (!deposit || deposit.status !== "pending") return null;
      Object.assign(deposit, patch);
      return deposit;
    },
    async listDepositsByUser(userId, limit = 100) {
      return state.deposits.filter((d) => d.user_id === userId).slice(0, limit);
    },

    /**
     * The reconciliation scan: pending M-Pesa deposits that are old enough to
     * have missed a callback and are due to be queried. Mirrors the SQL below
     * field for field, including the terminal-outcome exclusion.
     */
    async listReconcilableDeposits({ now, olderThanMs, limit = 25 } = {}) {
      const cutoff = Number(now) - Number(olderThanMs);
      return state.deposits
        .filter((d) =>
          d.status === "pending" &&
          d.method === "mpesa" &&
          !d.is_demo &&
          d.checkout_request_id &&
          !d.recon_outcome &&
          Date.parse(d.created_at) <= cutoff &&
          (!d.next_reconcile_at || Date.parse(d.next_reconcile_at) <= Number(now))
        )
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, limit);
    },

    /**
     * Claims one deposit for a query attempt, incrementing the attempt count and
     * pushing the next attempt out. Returns null when the deposit is no longer
     * claimable, which is what stops two workers doing the same work.
     *
     * The checks and the write happen with no `await` between them, so within
     * this process the claim is atomic. Across processes it is NOT — that
     * guarantee comes from the guarded single UPDATE in Postgres, which is the
     * only deployment shape where two workers exist.
     */
    async claimDepositForReconciliation(id, { now, nextAt } = {}) {
      gate();
      const deposit = state.deposits.find((d) => d.id === id);
      if (!deposit) return null;
      if (deposit.status !== "pending") return null;
      if (deposit.recon_outcome) return null;
      if (deposit.next_reconcile_at && Date.parse(deposit.next_reconcile_at) > Number(now)) return null;
      deposit.recon_attempts = Number(deposit.recon_attempts || 0) + 1;
      deposit.last_reconciled_at = new Date(Number(now)).toISOString();
      deposit.next_reconcile_at = new Date(Number(nextAt)).toISOString();
      return deposit;
    },

    /* idempotency */
    async findIdempotentKey(userId, key) {
      return state.idempotency[`${userId}:${key}`] || null;
    },
    async rememberIdempotentKey(userId, key, depositId) {
      gate();
      state.idempotency[`${userId}:${key}`] = depositId;
    },

    /* custody addresses */
    async getTrc20Address(userId) {
      return state.trc20_addresses[userId] || null;
    },
    async setTrc20Address(userId, record) {
      gate();
      state.trc20_addresses[userId] = record;
      return record;
    },

    /* provider deliveries */
    async insertMpesaCallback(entry) {
      gate();
      state.mpesa_callbacks.unshift(entry);
      return entry;
    },
    async updateMpesaCallback(id, patch) {
      gate();
      const entry = state.mpesa_callbacks.find((c) => c.id === id);
      if (!entry) return null;
      Object.assign(entry, patch);
      return entry;
    },
    async listMpesaCallbacks(limit = 100) {
      return state.mpesa_callbacks.slice(0, limit);
    },

    /**
     * The ledger is in this process's arrays, so it is trivially reachable and
     * there is nothing to release. These exist so the server can ask a health
     * question and shut down without caring which store it was handed.
     */
    async ping() {
      return true;
    },
    async close() {
      return true;
    },

    /* exposed so a test can seed a row without going through a route */
    _state: state,
  };

  return api;
}

/* -------------------------- postgres implementation -------------------------- */

/**
 * The production store. Every method is one statement or one transaction; no
 * method reads a row into memory and writes it back later, which is how the
 * JSON ledger lost updates under concurrency.
 */
export async function createPostgresStore({ connectionString, ssl, poolSize = 10, logger = console }) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({
    connectionString,
    max: poolSize,
    ssl: ssl === undefined ? (needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined) : ssl,
  });
  pool.on("error", (err) => logger.error("[store] idle client error:", err.message));

  const schema = await readFile(SCHEMA_PATH, "utf8");

  /** Binds every query to a pool client, or to a transaction's client. */
  function makeApi(runner, { inTransaction }) {
    const q = (text, params) => runner.query(text, params);

    const api = {
      kind: inTransaction ? "postgres:tx" : "postgres",

      async init() {
        await q(schema);
      },
      async close() {
        if (!inTransaction) await pool.end();
      },

      /**
       * One connection, one transaction. Everything the callback does on `t`
       * commits together or not at all.
       */
      async tx(fn) {
        if (inTransaction) return fn(api);
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(makeApi(client, { inTransaction: true }));
          await client.query("COMMIT");
          return result;
        } catch (err) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackErr) {
            logger.error("[store] rollback failed:", rollbackErr.message);
          }
          throw err;
        } finally {
          client.release();
        }
      },

      /* users */
      async findUserByEmail(email) {
        const { rows } = await q("SELECT * FROM users WHERE email = $1", [String(email || "").trim().toLowerCase()]);
        return userFromRow(rows[0]);
      },
      async findUserById(id) {
        const { rows } = await q("SELECT * FROM users WHERE id = $1", [id]);
        return userFromRow(rows[0]);
      },
      async createUser(user) {
        const { rows } = await q(
          `INSERT INTO users (id, email, username, salt, password_hash, is_demo, demo_balance, real_balance, two_factor_enabled, referral_code, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
           ON CONFLICT (email) DO NOTHING
           RETURNING *`,
          [
            user.id, user.email, user.username, user.salt, user.password_hash,
            !!user.is_demo, user.demo_balance ?? 10000, user.real_balance ?? 0,
            !!user.two_factor_enabled, user.referral_code, user.created_at ?? null,
          ]
        );
        if (!rows[0]) throw Object.assign(new Error("An account with this email already exists"), { code: "EMAIL_TAKEN" });
        return userFromRow(rows[0]);
      },
      async updateUser(id, patch) {
        const allowed = ["is_demo", "two_factor_enabled", "demo_balance", "real_balance", "username", "password_hash", "salt"];
        const sets = [];
        const params = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key)) continue;
          params.push(value);
          sets.push(`${key} = $${params.length}`);
        }
        if (!sets.length) return this.findUserById(id);
        const { rows } = await q(`UPDATE users SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
        return userFromRow(rows[0]);
      },

      /**
       * Debits the stake and creates the position and ledger entry together.
       * The balance test is inside the UPDATE, so two concurrent trades cannot
       * both pass a check and overdraw the account.
       */
      async debitAndOpenPosition({ userId, balanceKey, stake, position, transaction }) {
        const column = balanceColumn(balanceKey);
        const { rows } = await q(
          `UPDATE users SET ${column} = ${column} - $2::numeric
            WHERE id = $1 AND ${column} >= $2::numeric
            RETURNING ${column} AS balance`,
          [userId, Number(stake)]
        );
        if (!rows[0]) {
          const exists = await this.findUserById(userId);
          if (!exists) throw new Error("Account not found");
          throw Object.assign(new Error("Insufficient balance"), { code: "INSUFFICIENT_BALANCE" });
        }
        await q(
          `INSERT INTO positions (id, user_id, asset, trade_type, direction, target_digit, stake, potential_payout,
                                  entry_price, entry_digit, ticks, current_tick, status, is_demo, auto, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, COALESCE($16::timestamptz, now()))`,
          [
            position.id, position.user_id, position.asset, position.trade_type, position.direction,
            position.target_digit, position.stake, position.potential_payout, position.entry_price,
            position.entry_digit, position.ticks, position.current_tick ?? 0, position.status,
            !!position.is_demo, !!position.auto, position.created_at ?? null,
          ]
        );
        if (transaction) {
          await q(
            `INSERT INTO transactions (id, user_id, type, amount, currency, method, reference, is_demo, status, balance_after, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))`,
            [
              transaction.id, transaction.user_id, transaction.type, transaction.amount,
              transaction.currency || "USD", transaction.method ?? null, transaction.reference ?? null,
              !!transaction.is_demo, transaction.status || "completed", Number(rows[0].balance),
              transaction.created_at ?? null,
            ]
          );
        }
        return { settled: true, balance: Number(rows[0].balance) };
      },

      /* sessions */
      async createSession(token, userId) {
        await q("INSERT INTO sessions (token, user_id) VALUES ($1,$2) ON CONFLICT (token) DO NOTHING", [token, userId]);
      },
      async userIdForToken(token) {
        const { rows } = await q("SELECT user_id FROM sessions WHERE token = $1", [token]);
        return rows[0] ? rows[0].user_id : null;
      },
      async deleteSession(token) {
        await q("DELETE FROM sessions WHERE token = $1", [token]);
      },

      /* second factor */
      async savePending2fa(tempToken, { userId, code }) {
        await q("INSERT INTO pending_2fa (temp_token, user_id, code) VALUES ($1,$2,$3)", [tempToken, userId, String(code)]);
      },
      async findPending2fa(tempToken) {
        const { rows } = await q("SELECT user_id, code FROM pending_2fa WHERE temp_token = $1", [tempToken]);
        return rows[0] ? { userId: rows[0].user_id, code: rows[0].code } : null;
      },
      /** Single use: the row is returned and removed in one statement. */
      async takePending2fa(tempToken) {
        const { rows } = await q("DELETE FROM pending_2fa WHERE temp_token = $1 RETURNING user_id, code", [tempToken]);
        return rows[0] ? { userId: rows[0].user_id, code: rows[0].code } : null;
      },

      /* positions */
      async listPositionsByUser(userId, limit = 200) {
        const { rows } = await q(
          "SELECT * FROM positions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
          [userId, limit]
        );
        return rows.map(positionFromRow);
      },
      async openPositions() {
        const { rows } = await q("SELECT * FROM positions WHERE status = 'open' ORDER BY created_at DESC");
        return rows.map(positionFromRow);
      },
      async bumpTicks(ids) {
        if (!ids.length) return [];
        const { rows } = await q(
          `UPDATE positions SET current_tick = current_tick + 1
            WHERE id = ANY($1::text[]) AND status = 'open'
            RETURNING *`,
          [ids]
        );
        return rows.map(positionFromRow);
      },
      /**
       * Claims the position with `settled_at IS NULL` and credits the payout in
       * the same transaction. A second call for the same position updates no
       * rows and credits nothing.
       */
      async settlePosition({ positionId, userId, balanceKey, credit, position, transaction }) {
        const column = balanceColumn(balanceKey);
        const { rows } = await q(
          `UPDATE positions
              SET status = $2, exit_price = $3, exit_digit = $4, profit_loss = $5,
                  closed_at = COALESCE($6::timestamptz, now()), settled_at = $7
            WHERE id = $1 AND settled_at IS NULL
            RETURNING *`,
          [
            positionId, position.status, position.exit_price, position.exit_digit,
            position.profit_loss, position.closed_at ?? null, position.settled_at,
          ]
        );
        if (!rows[0]) return { settled: false };
        // The ledger row records the balance it left behind, so the history
        // explains itself. A win reads it from the UPDATE that credited it; a
        // loss moved nothing, so it reads the (unchanged) balance directly —
        // either way the number is the database's, not this process's.
        let balanceAfter = null;
        if (credit) {
          const credited = await q(
            `UPDATE users SET ${column} = ${column} + $2::numeric WHERE id = $1 RETURNING ${column} AS balance`,
            [userId, Number(credit)]
          );
          balanceAfter = credited.rows[0] ? Number(credited.rows[0].balance) : null;
        } else {
          const { rows: held } = await q(`SELECT ${column} AS balance FROM users WHERE id = $1`, [userId]);
          balanceAfter = held[0] ? Number(held[0].balance) : null;
        }
        if (transaction) {
          await q(
            `INSERT INTO transactions (id, user_id, type, amount, currency, method, reference, is_demo, status, balance_after, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now()))
             ON CONFLICT (id) DO NOTHING`,
            [
              transaction.id, transaction.user_id, transaction.type, transaction.amount,
              transaction.currency || "USD", transaction.method ?? null, transaction.reference ?? null,
              !!transaction.is_demo, transaction.status || "completed", balanceAfter,
              transaction.created_at ?? null,
            ]
          );
        }
        return { settled: true, position: positionFromRow(rows[0]) };
      },

      /* transactions */
      async listTransactionsByUser(userId, limit = 200) {
        const { rows } = await q(
          "SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
          [userId, limit]
        );
        return rows.map(transactionFromRow);
      },
      async latestTransactionByUser(userId) {
        const { rows } = await q(
          "SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
          [userId]
        );
        return transactionFromRow(rows[0]);
      },
      async insertTransaction(transaction) {
        const { rows } = await q(
          `INSERT INTO transactions (id, user_id, type, amount, currency, method, reference, is_demo, status, balance_after, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, now())) RETURNING *`,
          [
            transaction.id, transaction.user_id, transaction.type, transaction.amount,
            transaction.currency || "USD", transaction.method ?? null, transaction.reference ?? null,
            !!transaction.is_demo, transaction.status || "completed",
            transaction.balance_after == null ? null : Number(transaction.balance_after),
            transaction.created_at ?? null,
          ]
        );
        return transactionFromRow(rows[0]);
      },

      /* deposits */
      async insertDeposit(deposit) {
        const { rows } = await q(
          `INSERT INTO deposits (id, user_id, reference, method, environment, msisdn_masked, amount, currency,
                                 usd_amount, settlement_currency, settlement_amount, settlement_rate, status, is_demo,
                                 provider_reference, checkout_request_id, merchant_request_id, failure_reason, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, COALESCE($19::timestamptz, now()))
           RETURNING *`,
          [
            deposit.id, deposit.user_id, deposit.reference, deposit.method, deposit.environment ?? null,
            deposit.msisdn_masked ?? null,
            deposit.amount, deposit.currency || "USD", deposit.usd_amount ?? deposit.amount,
            deposit.settlement_currency ?? null, deposit.settlement_amount ?? null,
            deposit.settlement_rate ?? null, deposit.status, !!deposit.is_demo,
            deposit.provider_reference ?? null, deposit.checkout_request_id ?? null,
            deposit.merchant_request_id ?? null, deposit.failure_reason ?? null, deposit.created_at ?? null,
          ]
        );
        return depositFromRow(rows[0]);
      },
      async findDeposit(reference) {
        const { rows } = await q(
          "SELECT * FROM deposits WHERE reference = $1 OR provider_reference = $1 OR id = $1 LIMIT 1",
          [reference]
        );
        return depositFromRow(rows[0]);
      },
      async findDepositByCheckoutId(checkoutRequestId) {
        const { rows } = await q(
          "SELECT * FROM deposits WHERE checkout_request_id = $1 LIMIT 1",
          [checkoutRequestId]
        );
        return depositFromRow(rows[0]);
      },
      /**
       * The settlement read. FOR UPDATE takes a row lock, so a second settlement
       * of the same deposit blocks here and then sees the committed status
       * rather than the pending one it would otherwise have raced on.
       */
      async lockDeposit(reference) {
        const { rows } = await q(
          "SELECT * FROM deposits WHERE reference = $1 OR provider_reference = $1 OR id = $1 LIMIT 1 FOR UPDATE",
          [reference]
        );
        return depositFromRow(rows[0]);
      },
      /** balance = balance + amount in the database, never read-modify-write. */
      async creditBalance({ userId, balanceKey, amount }) {
        const column = balanceColumn(balanceKey);
        const { rows } = await q(
          `UPDATE users SET ${column} = ${column} + $2::numeric WHERE id = $1 RETURNING ${column} AS balance`,
          [userId, Number(amount)]
        );
        if (!rows[0]) throw new Error("Account not found");
        return Number(rows[0].balance);
      },
      async updateDeposit(id, patch) {
        const allowed = [
          "status", "provider_reference", "checkout_request_id", "merchant_request_id",
          "mpesa_result_code", "failure_reason", "verified_amount", "completed_at",
          "settlement_amount", "settlement_rate", "settlement_currency",
          "recon_attempts", "last_reconciled_at", "next_reconcile_at", "recon_outcome",
        ];
        const sets = [];
        const params = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key)) continue;
          params.push(value);
          sets.push(`${key} = $${params.length}`);
        }
        if (!sets.length) return null;
        const { rows } = await q(`UPDATE deposits SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
        return depositFromRow(rows[0]);
      },
      /**
       * Fails a deposit only while it is still pending — the guard is in the
       * WHERE clause, so it is one atomic statement and cannot lose a race
       * against a concurrent settlement. Returns null if it was not pending.
       */
      async failDepositIfUnsettled(id, patch) {
        const allowed = [
          "status", "provider_reference", "checkout_request_id", "merchant_request_id",
          "mpesa_result_code", "failure_reason", "verified_amount", "completed_at",
          "settlement_amount", "settlement_rate", "settlement_currency",
          "recon_attempts", "last_reconciled_at", "next_reconcile_at", "recon_outcome",
        ];
        const sets = [];
        const params = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key)) continue;
          params.push(value);
          sets.push(`${key} = $${params.length}`);
        }
        if (!sets.length) return null;
        const { rows } = await q(
          `UPDATE deposits SET ${sets.join(", ")} WHERE id = $1 AND status = 'pending' RETURNING *`,
          params
        );
        return depositFromRow(rows[0]);
      },
      async listDepositsByUser(userId, limit = 100) {
        const { rows } = await q(
          "SELECT * FROM deposits WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
          [userId, limit]
        );
        return rows.map(depositFromRow);
      },

      /**
       * The reconciliation scan. Oldest first, so the deposit that has been
       * stuck longest is queried first, and bounded by the caller's batch size.
       * Demo deposits are excluded: no real money moved for them.
       */
      async listReconcilableDeposits({ now, olderThanMs, limit = 25 } = {}) {
        const { rows } = await q(
          `SELECT * FROM deposits
            WHERE status = 'pending'
              AND method = 'mpesa'
              AND is_demo = false
              AND checkout_request_id IS NOT NULL
              AND recon_outcome IS NULL
              AND created_at <= $1::timestamptz
              AND (next_reconcile_at IS NULL OR next_reconcile_at <= $2::timestamptz)
            ORDER BY created_at ASC
            LIMIT $3`,
          [new Date(Number(now) - Number(olderThanMs)).toISOString(), new Date(Number(now)).toISOString(), limit]
        );
        return rows.map(depositFromRow);
      },

      /**
       * Claims one deposit for a query attempt.
       *
       * One statement, so the guard cannot be read and then invalidated: the
       * row is locked, `next_reconcile_at` moves into the future, and a second
       * worker's identical UPDATE matches zero rows. That is what makes
       * concurrent workers safe rather than merely unlikely to collide.
       */
      async claimDepositForReconciliation(id, { now, nextAt } = {}) {
        const stamp = new Date(Number(now)).toISOString();
        const { rows } = await q(
          `UPDATE deposits
              SET recon_attempts = recon_attempts + 1,
                  last_reconciled_at = $1::timestamptz,
                  next_reconcile_at = $2::timestamptz
            WHERE id = $3
              AND status = 'pending'
              AND recon_outcome IS NULL
              AND (next_reconcile_at IS NULL OR next_reconcile_at <= $1::timestamptz)
          RETURNING *`,
          [stamp, new Date(Number(nextAt)).toISOString(), id]
        );
        return depositFromRow(rows[0]);
      },

      /* idempotency */
      async findIdempotentKey(userId, key) {
        const { rows } = await q("SELECT deposit_id FROM idempotency_keys WHERE user_id = $1 AND key = $2", [userId, String(key)]);
        return rows[0] ? rows[0].deposit_id : null;
      },
      async rememberIdempotentKey(userId, key, depositId) {
        await q(
          "INSERT INTO idempotency_keys (user_id, key, deposit_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, key) DO NOTHING",
          [userId, String(key), depositId]
        );
      },

      /* custody addresses */
      async getTrc20Address(userId) {
        const { rows } = await q("SELECT * FROM trc20_addresses WHERE user_id = $1", [userId]);
        if (!rows[0]) return null;
        return {
          address: rows[0].address,
          asset: rows[0].asset,
          network: rows[0].network,
          provider: rows[0].provider,
          assigned_at: iso(rows[0].assigned_at),
        };
      },
      async setTrc20Address(userId, record) {
        await q(
          `INSERT INTO trc20_addresses (user_id, address, asset, network, provider, assigned_at)
           VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()))
           ON CONFLICT (user_id) DO UPDATE
             SET address = EXCLUDED.address, asset = EXCLUDED.asset, network = EXCLUDED.network,
                 provider = EXCLUDED.provider, assigned_at = EXCLUDED.assigned_at`,
          [userId, record.address, record.asset || "USDT", record.network || "TRC20", record.provider ?? null, record.assigned_at ?? null]
        );
        return record;
      },

      /* provider deliveries */
      async insertMpesaCallback(entry) {
        const { rows } = await q(
          `INSERT INTO mpesa_callbacks (id, checkout_request_id, merchant_request_id, result_code, result_desc,
                                        outcome, deposit_reference, user_id, received_at, mpesa_receipt,
                                        settlement_error, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()), $10, $11, $12::jsonb)
           RETURNING *`,
          [
            entry.id, entry.checkout_request_id ?? null, entry.merchant_request_id ?? null,
            entry.result_code ?? null, entry.result_desc ?? null, entry.outcome ?? null,
            entry.deposit_reference ?? null, entry.user_id ?? null, entry.received_at ?? null,
            entry.mpesa_receipt ?? null, entry.settlement_error ?? null,
            entry.payload ? JSON.stringify(entry.payload) : null,
          ]
        );
        return callbackFromRow(rows[0]);
      },
      async updateMpesaCallback(id, patch) {
        const allowed = ["outcome", "deposit_reference", "user_id", "result_desc", "result_code"];
        const sets = [];
        const params = [id];
        for (const [key, value] of Object.entries(patch)) {
          if (!allowed.includes(key)) continue;
          params.push(value);
          sets.push(`${key} = $${params.length}`);
        }
        if (!sets.length) return null;
        const { rows } = await q(`UPDATE mpesa_callbacks SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
        return callbackFromRow(rows[0]);
      },
      async listMpesaCallbacks(limit = 100) {
        const { rows } = await q("SELECT * FROM mpesa_callbacks ORDER BY received_at DESC LIMIT $1", [limit]);
        return rows.map(callbackFromRow);
      },

      /**
       * Reaches the database, so a health check can tell "the process is up"
       * from "the ledger is up". A deployment whose pool has lost its server
       * must not keep accepting trades it cannot record.
       */
      async ping() {
        await q("SELECT 1");
        return true;
      },

      /**
       * Releases the pool on shutdown. The transaction-scoped handle shares the
       * pool with its parent, so it must not end it.
       */
      async close() {
        if (!inTransaction) await pool.end();
        return true;
      },
    };

    return api;
  }

  const api = makeApi(pool, { inTransaction: false });
  await api.init();
  return api;
}

/* -------------------------------- factory -------------------------------- */

/**
 * Picks the store for this process.
 *
 * Production without DATABASE_URL is a hard failure: running the ledger in
 * memory there would look like it worked and lose every trade on restart.
 */
export async function createStore({ connectionString = process.env.DATABASE_URL, production = process.env.NODE_ENV === "production" || process.env.REQUIRE_DATABASE_URL === "1", logger = console } = {}) {
  if (connectionString) {
    const store = await createPostgresStore({ connectionString, logger });
    logger.log("  storage     : postgres");
    return store;
  }
  if (production) {
    throw new Error(
      "DATABASE_URL is not set. The ledger must not run in memory in production — see README.md (Deploy)."
    );
  }
  logger.log("  storage     : in-memory (set DATABASE_URL for the Postgres ledger)");
  return createMemoryStore();
}
