-- PalOption ledger schema.
--
-- Applied automatically at boot by tools/store.mjs (idempotent), and also
-- usable by hand:  psql "$DATABASE_URL" -f tools/schema.sql
--
-- Two invariants this schema exists to enforce, both of which the previous
-- JSON-file ledger could only hope for:
--
--   1. A deposit is settled exactly once. The unique index on the deposit
--      reference in `transactions` means a second settlement attempt fails the
--      insert instead of crediting a second time, whatever the application
--      layer believes.
--   2. A position is settled exactly once. `settled_at` is checked inside the
--      UPDATE that settles it, so a restart or an overlapping tick cannot
--      double-pay a trade.
--
-- Balances are numeric(14,2), never float, so money arithmetic is exact.

CREATE TABLE IF NOT EXISTS users (
  id                 text PRIMARY KEY,
  email              text NOT NULL UNIQUE,
  username           text NOT NULL,
  salt               text NOT NULL,
  password_hash      text NOT NULL,
  is_demo            boolean NOT NULL DEFAULT true,
  demo_balance       numeric(14,2) NOT NULL DEFAULT 10000,
  real_balance       numeric(14,2) NOT NULL DEFAULT 0,
  two_factor_enabled boolean NOT NULL DEFAULT false,
  referral_code      text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_demo_balance_not_negative  CHECK (demo_balance >= 0),
  CONSTRAINT users_real_balance_not_negative  CHECK (real_balance >= 0)
);

-- Bearer sessions. The token is the primary key, so a token maps to exactly one
-- account and cannot be duplicated.
CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);

-- Second-factor challenges. Single use: consumed with DELETE ... RETURNING, so
-- a replayed code finds nothing.
CREATE TABLE IF NOT EXISTS pending_2fa (
  temp_token text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  id               text PRIMARY KEY,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset            text NOT NULL,
  trade_type       text NOT NULL,
  direction        text NOT NULL,
  target_digit     integer,
  stake            numeric(14,2) NOT NULL,
  potential_payout numeric(14,2) NOT NULL,
  entry_price      numeric(18,4) NOT NULL,
  entry_digit      integer NOT NULL,
  ticks            integer NOT NULL,
  current_tick     integer NOT NULL DEFAULT 0,
  status           text NOT NULL,
  is_demo          boolean NOT NULL DEFAULT false,
  auto             boolean NOT NULL DEFAULT false,
  exit_price       numeric(18,4),
  exit_digit       integer,
  profit_loss      numeric(14,2),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  settled_at       bigint,
  CONSTRAINT positions_status_valid CHECK (status IN ('open', 'won', 'lost', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS positions_user_id_created_at_idx ON positions (user_id, created_at DESC);
-- The tick loop only ever wants the open ones.
CREATE INDEX IF NOT EXISTS positions_open_idx ON positions (id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS transactions (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  amount     numeric(14,2) NOT NULL,
  currency   text NOT NULL DEFAULT 'USD',
  method     text,
  reference  text,
  is_demo    boolean NOT NULL DEFAULT false,
  status     text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_user_id_created_at_idx ON transactions (user_id, created_at DESC);
-- Invariant 1: one ledger entry per settled deposit reference, enforced by the
-- database rather than by a lock in one process.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_deposit_reference_unique
  ON transactions (reference)
  WHERE type = 'deposit' AND reference IS NOT NULL;

CREATE TABLE IF NOT EXISTS deposits (
  id                   text PRIMARY KEY,
  user_id              text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reference            text NOT NULL UNIQUE,
  method               text NOT NULL,
  amount               numeric(14,2) NOT NULL,
  currency             text NOT NULL DEFAULT 'USD',
  usd_amount           numeric(14,2) NOT NULL,
  settlement_currency  text,
  settlement_amount    numeric(18,2),
  settlement_rate      numeric(18,6),
  status               text NOT NULL,
  is_demo              boolean NOT NULL DEFAULT false,
  provider_reference   text,
  checkout_request_id  text,
  merchant_request_id  text,
  mpesa_result_code    integer,
  failure_reason       text,
  verified_amount      numeric(18,2),
  created_at           timestamptz NOT NULL DEFAULT now(),
  completed_at         timestamptz,
  CONSTRAINT deposits_status_valid CHECK (status IN ('pending', 'completed', 'failed', 'cancelled'))
);
CREATE INDEX IF NOT EXISTS deposits_user_id_created_at_idx ON deposits (user_id, created_at DESC);
-- A provider reference identifies one deposit, so a callback carrying it can
-- never be matched to two.
CREATE UNIQUE INDEX IF NOT EXISTS deposits_provider_reference_unique
  ON deposits (provider_reference)
  WHERE provider_reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS deposits_checkout_request_id_idx ON deposits (checkout_request_id);

CREATE TABLE IF NOT EXISTS withdrawals (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     numeric(14,2) NOT NULL,
  currency   text NOT NULL DEFAULT 'USD',
  method     text,
  status     text NOT NULL,
  reference  text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One custody address per account.
CREATE TABLE IF NOT EXISTS trc20_addresses (
  user_id     text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  address     text NOT NULL,
  asset       text NOT NULL DEFAULT 'USDT',
  network     text NOT NULL DEFAULT 'TRC20',
  provider    text,
  assigned_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotency keys are scoped to the account and unique per key, so a replay
-- cannot create a second intent even from two concurrent requests.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        text NOT NULL,
  deposit_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- Raw provider deliveries, kept for audit. Never the source of a credit.
CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id                  text PRIMARY KEY,
  checkout_request_id text,
  merchant_request_id text,
  result_code         integer,
  result_desc         text,
  outcome             text,
  deposit_reference   text,
  user_id             text,
  mpesa_receipt       text,
  settlement_error    text,
  received_at         timestamptz NOT NULL DEFAULT now(),
  payload             jsonb
);
CREATE INDEX IF NOT EXISTS mpesa_callbacks_checkout_request_id_idx ON mpesa_callbacks (checkout_request_id);
