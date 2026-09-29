-- The explorer credential's daily credit budget, shared by every process
-- that holds the key (the api's instances during a rolling deploy, a
-- one-off job): one row per credential name and UTC day, reserved
-- atomically per attempted paid call under the row's lock and never reset by
-- a process restart. `spent` counts every attempted call, failed ones
-- included; `reserved` is the cost of calls admitted but not yet settled
-- (a process that dies mid-call leaves its reservation counted for the rest
-- of the day, which only ever refuses more, never spends more).
-- `consumers` keeps the same two figures per named consumer of the key
-- (`history`, `following`, `census`), whose own daily allocations are policy
-- in apps/api/src/explorer-budget.ts. `account_remaining` is the key's
-- balance as the explorer last stated it (`x-credits-remaining`), lowered by
-- every attempted call since, so that the account floor below which no
-- reader spends holds across processes and while answers carry no header.
-- The row is keyed by the credential's name, never by the key's value, so a
-- rotated key inherits the day's spend.
CREATE TABLE explorer_credit_budget (
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9_-]{0,31}$'),
  day date NOT NULL,
  spent integer NOT NULL DEFAULT 0 CHECK (spent >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  consumers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(consumers) = 'object'),
  account_remaining integer CHECK (account_remaining IS NULL OR account_remaining >= 0),
  account_observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, day),
  CHECK ((account_remaining IS NULL) = (account_observed_at IS NULL))
);
COMMENT ON TABLE explorer_credit_budget IS 'Daily credit budget of an explorer credential, one row per credential name and UTC day, shared by every process holding the key: spent counts every attempted call, reserved the calls admitted but not yet settled, consumers the same per named reader, account_remaining the balance the explorer last stated lowered by every attempt since. Admission policy lives in the api; no user data.';
