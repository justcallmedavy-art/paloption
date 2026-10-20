/**
 * The dedicated account: its rule, its provisioning, and the ledger entries it
 * produces.
 *
 * Three separate claims are pinned here, because each can fail on its own:
 *
 *   1. the 70% demo target applies to exactly one account and only in demo;
 *   2. the account is created through the ordinary scrypt path, with $9 of real
 *      money and $10,000 of demo money, and re-running the command cannot reset
 *      a balance;
 *   3. every balance change is written with the balance it produced, so history
 *      explains itself.
 *
 * The end-to-end half — login, 200 settling trades measured through the engine,
 * real/demo switching — lives in tests/postgres/pg-dedicated-account.test.mjs,
 * because it needs a ledger two processes can share.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import {
  rulesForEmail,
  demoWinRateForEmail,
  settleOutcome,
} from "../tools/account-rules.mjs";
import { accountRecord, provisionAccount } from "../tools/provision-account.mjs";
import { createMemoryStore } from "../tools/store.mjs";

const DEDICATED = "smartmind254@gmail.com";

describe("the account's demo win-rate rule", () => {
  test("is keyed by email, case and spacing ignored", () => {
    assert.deepEqual(demoWinRateForEmail(DEDICATED), 0.7);
    assert.deepEqual(demoWinRateForEmail("  SmartMind254@Gmail.com "), 0.7);
    assert.equal(rulesForEmail("someone.else@example.com"), null);
  });

  test("no other account carries a rule", () => {
    for (const email of ["alice@example.com", "demo+abc@example.com", "", null, undefined]) {
      assert.equal(demoWinRateForEmail(email), null, `${email} must settle naturally`);
    }
  });

  test("a demo trade wins 70% of the time at the boundary", () => {
    const at = (value) => settleOutcome({ naturalWin: false, isDemo: true, demoWinRate: 0.7, random: () => value });
    assert.equal(at(0.69), true, "below the rate is a win");
    assert.equal(at(0.7), false, "at the rate is a loss");
    assert.equal(at(0.95), false);
  });

  test("a rule never changes a real trade", () => {
    for (const random of [0, 0.1, 0.69, 0.99]) {
      assert.equal(
        settleOutcome({ naturalWin: false, isDemo: false, demoWinRate: 0.7, random: () => random }),
        false,
        "a real position settles on the market outcome"
      );
      assert.equal(
        settleOutcome({ naturalWin: true, isDemo: false, demoWinRate: 0.7, random: () => random }),
        true
      );
    }
  });

  test("an account with no rule keeps its natural outcome", () => {
    assert.equal(settleOutcome({ naturalWin: true, isDemo: true, demoWinRate: null, random: () => 0.99 }), true);
    assert.equal(settleOutcome({ naturalWin: false, isDemo: true, demoWinRate: null, random: () => 0.01 }), false);
  });
});

describe("provisioning the account", () => {
  // A fixture, deliberately not the operator's password: this file is in a
  // public repository, and the real credential belongs only in the ledger.
  const password = "fixture-pass-9";

  test("creates it with the stated balances and an ordinary scrypt hash", async () => {
    const store = createMemoryStore();
    const { created, user } = await provisionAccount(store, {
      email: DEDICATED,
      name: "Smart Mind",
      password,
      realBalance: 9,
      demoBalance: 10000,
    });

    assert.equal(created, true);
    assert.equal(user.email, DEDICATED);
    assert.equal(user.real_balance, 9);
    assert.equal(user.demo_balance, 10000);
    assert.equal(user.is_demo, true);
    // The same check the login route makes, against the stored salt.
    assert.equal(user.password_hash, scryptSync(password, user.salt, 32).toString("hex"));
    // No field may hold the password itself.
    assert.equal(Object.values(user).some((value) => value === password), false, "the password is never stored");
    assert.equal(user.password_hash.includes(password), false);
  });

  test("re-running cannot reset a balance that has moved", async () => {
    const store = createMemoryStore();
    await provisionAccount(store, { email: DEDICATED, name: "Smart Mind", password, realBalance: 9 });

    const [first] = store.db.users;
    first.real_balance = 4.25;
    first.demo_balance = 1234.5;

    const again = await provisionAccount(store, { email: DEDICATED, name: "Smart Mind", password, realBalance: 9 });
    assert.equal(again.created, false);
    assert.equal(again.user.real_balance, 4.25);
    assert.equal(again.user.demo_balance, 1234.5);
    assert.equal(store.db.users.length, 1, "no duplicate account");
  });

  test("refuses a password the login route would refuse", async () => {
    const store = createMemoryStore();
    await assert.rejects(
      provisionAccount(store, { email: DEDICATED, password: "short" }),
      /at least 6 characters/
    );
    assert.equal(store.db.users.length, 0);
  });

  test("the record it builds is what the register route writes", () => {
    const record = accountRecord({ email: DEDICATED, name: "Smart Mind", password, realBalance: 9 });
    for (const field of ["id", "email", "username", "salt", "password_hash", "is_demo", "demo_balance", "real_balance", "two_factor_enabled", "referral_code", "created_at"]) {
      assert.ok(field in record, `a users row needs ${field}`);
    }
    assert.equal(record.real_balance, 9);
    assert.equal(record.demo_balance, 10000);
  });
});

describe("the ledger records the balance each entry produced", () => {
  const userId = "u_test";

  const fresh = () => {
    const store = createMemoryStore();
    store.db.users.push({
      id: userId,
      email: "trader@example.com",
      demo_balance: 10000,
      real_balance: 9,
      is_demo: true,
    });
    return store;
  };

  test("a trade open records the debited balance", async () => {
    const store = fresh();
    const transaction = { id: "tx_open", user_id: userId, type: "trade_open", amount: -10, is_demo: true };
    await store.debitAndOpenPosition({
      userId,
      balanceKey: "demo_balance",
      stake: 10,
      position: { id: "pos_1", user_id: userId, status: "open", ticks: 1, current_tick: 0, is_demo: true, stake: 10, potential_payout: 19.52 },
      transaction,
    });
    assert.equal(transaction.balance_after, 9990);
  });

  test("a win records the credited balance, and a second settlement credits nothing", async () => {
    const store = fresh();
    await store.debitAndOpenPosition({
      userId,
      balanceKey: "demo_balance",
      stake: 10,
      position: { id: "pos_1", user_id: userId, status: "open", ticks: 1, current_tick: 0, is_demo: true, stake: 10, potential_payout: 19.52 },
      transaction: { id: "tx_open", user_id: userId, type: "trade_open", amount: -10 },
    });

    const win = { id: "tx_win", user_id: userId, type: "trade_win", amount: 9.52 };
    const settled = await store.settlePosition({
      positionId: "pos_1",
      userId,
      balanceKey: "demo_balance",
      credit: 19.52,
      position: { status: "won", exit_price: 1245.6, exit_digit: 0, profit_loss: 9.52, closed_at: new Date().toISOString(), settled_at: Date.now() },
      transaction: win,
    });
    assert.equal(settled.settled, true);
    assert.equal(win.balance_after, 9990 + 19.52);

    // The claim is `settled_at IS NULL`: a replay must not pay again.
    const replay = { id: "tx_win_2", user_id: userId, type: "trade_win", amount: 9.52 };
    const again = await store.settlePosition({
      positionId: "pos_1",
      userId,
      balanceKey: "demo_balance",
      credit: 19.52,
      position: { status: "won", profit_loss: 9.52, settled_at: Date.now() },
      transaction: replay,
    });
    assert.equal(again.settled, false);
    assert.equal(store.db.users[0].demo_balance, 10009.52);
    assert.equal(store.db.transactions.filter((t) => t.id === "tx_win_2").length, 0);
  });

  test("a loss moves no money, so its entry has no resulting balance", async () => {
    const store = fresh();
    await store.debitAndOpenPosition({
      userId,
      balanceKey: "demo_balance",
      stake: 10,
      position: { id: "pos_2", user_id: userId, status: "open", ticks: 1, current_tick: 0, is_demo: true, stake: 10, potential_payout: 19.52 },
      transaction: { id: "tx_open2", user_id: userId, type: "trade_open", amount: -10 },
    });
    const loss = { id: "tx_loss", user_id: userId, type: "trade_loss", amount: -10 };
    await store.settlePosition({
      positionId: "pos_2",
      userId,
      balanceKey: "demo_balance",
      credit: 0,
      position: { status: "lost", profit_loss: -10, closed_at: new Date().toISOString(), settled_at: Date.now() },
      transaction: loss,
    });
    assert.equal(loss.balance_after, 9990, "no credit means the balance is unchanged");
  });
});
