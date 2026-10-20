/**
 * Account-specific trading rules, keyed by the account's email address.
 *
 * There is deliberately no column for this. A rule that changes what a trade
 * pays is code, not data: it ships with the server, it is reviewed like the
 * rest of the engine, and no request can reach it. The client is never told the
 * rate, so there is nothing in a browser to tamper with — a demo settlement is
 * decided here, after the position has already been written.
 *
 * ONLY demo positions are affected. A real trade for the same account settles
 * on the market outcome like every other account's, because the whole point of
 * a target win rate is to make a demo legible, not to sell a losing trade as a
 * winning one.
 *
 * The password is not here, and must never be: it exists only as a scrypt hash
 * in the users table (see tools/provision-account.mjs).
 */

/** @type {Map<string, { demoWinRate: number, label: string }>} */
const RULES = new Map([
  [
    "smartmind254@gmail.com",
    { demoWinRate: 0.7, label: "dedicated account" },
  ],
]);

const normalise = (email) => String(email || "").trim().toLowerCase();

/** The rule for an account, or null. Case and surrounding space are ignored. */
export function rulesForEmail(email) {
  return RULES.get(normalise(email)) || null;
}

/**
 * The demo target win rate for an account, or null when it settles naturally.
 * A rate outside 0..1 is treated as absent rather than as a coin flip that
 * always wins or always loses.
 */
export function demoWinRateForEmail(email) {
  const rule = rulesForEmail(email);
  if (!rule) return null;
  const rate = Number(rule.demoWinRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  return rate;
}

/**
 * The outcome of one position.
 *
 * Pure, with the random source injected, so the rule can be tested without a
 * running engine — and so a test can assert both sides of the boundary rather
 * than hoping 400 real rolls land in the right bucket.
 *
 * `random` returns [0, 1). A rate of 0.7 therefore wins 70% of the time.
 */
export function settleOutcome({ naturalWin, isDemo, demoWinRate, random = Math.random }) {
  if (isDemo && demoWinRate != null) return random() < demoWinRate;
  return naturalWin;
}
