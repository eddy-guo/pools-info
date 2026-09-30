-- Fold rule 2: a pooled sell is attributed pro rata to its contributors, and
-- a position keeps the token units it bought and sold (docs/AGGREGATE-LEDGER.md,
-- "Pooled swaps"; decided 29 Sep 2026). Nothing here changes a figure the
-- live ledger serves: the rule a stream folds under is the stream's own
-- (fold_rule, 1 for every stream that exists when this runs) and never a
-- deployment's default, so the live stream keeps folding under rule 1 until
-- a ledger re-folded from the first launch under rule 2 is swapped in for it.
-- The new columns are zero or null on every row
-- written before, and the constraints rule 2 needs hold over rule 1's rows as
-- they stand. Applied by the tip loop at its start under the writer lock.
-- Every constraint on an existing table is added NOT VALID: the rows already
-- there satisfy it by construction (no pooled swap,
-- null unit totals, 017's stricter hour and ring rules), and validating would
-- scan agg_positions under the ACCESS EXCLUSIVE lock the ALTER takes, which
-- the api's readers queue behind for the whole scan. New and updated rows
-- are checked all the same; a ledger re-folded under rule 2 writes every row
-- under them.

-- 1. The stream's rule, fixed when the stream is created; and the moment
--    readers started serving rule 2 from it, which the wallet page discloses
--    as the date pooled sells are attributed from (null until the swap-in).
ALTER TABLE agg_streams
  ADD COLUMN fold_rule smallint NOT NULL DEFAULT 1 CHECK (fold_rule IN (1,2)),
  ADD COLUMN fold_rule_since bigint CHECK (fold_rule_since>=0);

-- 2. Batches: of the attributed swaps, those attributed pro rata.
ALTER TABLE agg_batches
  ADD COLUMN pooled integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT agg_batches_pooled CHECK (pooled>=0 AND pooled<=attributed) NOT VALID;

-- 3. Positions: the pooled swap counter and
--    the unit totals, null on a row written before this migration as
--    migration 020's cycle counts are (a total folded from here on would
--    read as the whole history); a position created from here on starts at
--    zero. The units identity holds while the fold never emptied the
--    inventory over an oversell or an outflow above the held quantity, both
--    of which flag unknown_basis.
ALTER TABLE agg_positions
  ADD COLUMN pooled_swaps integer NOT NULL DEFAULT 0,
  ADD COLUMN bought_raw numeric,
  ADD COLUMN sold_raw numeric,
  ADD CONSTRAINT agg_positions_pooled_swaps CHECK (pooled_swaps>=0) NOT VALID,
  ADD CONSTRAINT agg_positions_bought_raw CHECK (bought_raw>=0 AND scale(bought_raw)=0) NOT VALID,
  ADD CONSTRAINT agg_positions_sold_raw CHECK (sold_raw>=0 AND scale(sold_raw)=0) NOT VALID,
  ADD CONSTRAINT agg_positions_units CHECK (
    (bought_raw IS NULL) = (sold_raw IS NULL)
    AND (bought_raw IS NULL OR 'unknown_basis' = ANY(flags)
      OR quantity_raw = bought_raw + inflow_raw - sold_raw - outflow_raw)) NOT VALID;

-- 4. A pooled sell is one trade for the pool and one seller per
--    contributor, so an hour's distinct sellers may exceed its sells.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='agg_pool_hours'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%sellers <= sells%'
  LOOP
    EXECUTE format('ALTER TABLE agg_pool_hours DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE agg_pool_hours
  ADD CONSTRAINT agg_pool_hours_sellers CHECK (sellers>=0) NOT VALID;

-- 5. The live ring keeps a pooled swap as one row without a wallet, as it
--    keeps an unattributed one, and with its contributors' refs, which count
--    them as the rolling hour's active traders.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='agg_live_trades'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%unattributed%'
  LOOP
    EXECUTE format('ALTER TABLE agg_live_trades DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE agg_live_trades
  ADD COLUMN pooled_wallet_refs integer[],
  ADD CONSTRAINT agg_live_trades_pooled_wallets CHECK ((pooled_wallet_refs IS NOT NULL) = (attribution='pooled')) NOT VALID,
  ADD CONSTRAINT agg_live_trades_attribution CHECK (attribution IN ('initiator','counterparty','pooled','unattributed')) NOT VALID,
  ADD CONSTRAINT agg_live_trades_wallet CHECK ((wallet_ref IS NULL) = (attribution IN ('pooled','unattributed'))) NOT VALID;

-- 6. The journal's pre-images are what a walk-back restores under these
--    constraints: a position pre-image gains the counter it lacked (zero,
--    since no batch it predates folded a pooled swap); the unit totals stay
--    absent and restore as null, unknown, which is what they are.
UPDATE agg_journal SET before=before||'{"pooled_swaps":0}'::jsonb
  WHERE chain_id=4663 AND "table"='agg_positions' AND before IS NOT NULL AND NOT (before ? 'pooled_swaps');

COMMENT ON COLUMN agg_streams.fold_rule IS 'The attribution rule the stream''s whole history is folded under: 1 leaves a pooled sell unattributed, 2 attributes it pro rata to its contributors. Pooled buys stay unattributed. Fixed at creation; a rule change is a re-fold into a fresh ledger, never an update here.';
COMMENT ON COLUMN agg_streams.fold_rule_since IS 'When readers started serving this stream under its rule (unix seconds), set at the swap-in; the wallet page discloses it. Null until then.';
COMMENT ON COLUMN agg_positions.pooled_swaps IS 'Sells attributed to this position pro rata through a pooled transaction (fold rule 2).';
COMMENT ON COLUMN agg_positions.bought_raw IS 'Token units bought through attributed swaps; null on a position written before the totals were folded.';
COMMENT ON COLUMN agg_positions.sold_raw IS 'Token units sold through attributed swaps; null with bought_raw.';
COMMENT ON COLUMN agg_live_trades.pooled_wallet_refs IS 'A pooled swap''s contributors (fold rule 2); null on every other row.';
COMMENT ON COLUMN agg_batches.pooled IS 'Of attributed, the swaps attributed pro rata to several contributors.';
