-- Fold rule 2: a pooled swap is attributed pro rata to its contributors, and
-- a position keeps the token units it bought and sold (docs/AGGREGATE-LEDGER.md,
-- "Pooled swaps"; decided 29 Sep 2026). Nothing here changes a figure the
-- live ledger serves: the rule a stream folds under is the stream's own
-- (fold_rule, 1 for every stream that exists when this runs) and never a
-- deployment's default, so the live stream keeps folding under rule 1 until
-- a ledger re-folded from the first launch under rule 2 is swapped in for it
-- (docs/LEDGER-CUTOVER.md). The new columns are zero or null on every row
-- written before, and the constraints rule 2 needs hold over rule 1's rows as
-- they stand. Applied by the tip loop at its start under the writer lock.

-- 1. The stream's rule, fixed when the stream is created; and the moment
--    readers started serving rule 2 from it, which the wallet page discloses
--    as the date pooled sells are attributed from (null until the swap-in).
ALTER TABLE agg_streams
  ADD COLUMN fold_rule smallint NOT NULL DEFAULT 1 CHECK (fold_rule IN (1,2)),
  ADD COLUMN fold_rule_since bigint CHECK (fold_rule_since>=0);

-- 2. Batches: of the attributed swaps, those attributed pro rata.
ALTER TABLE agg_batches
  ADD COLUMN pooled integer NOT NULL DEFAULT 0 CHECK (pooled>=0 AND pooled<=attributed);

-- 3. Positions: the pooled swap counter with its informational flag, and
--    the unit totals, null on a row written before this migration as
--    migration 020's cycle counts are (a total folded from here on would
--    read as the whole history); a position created from here on starts at
--    zero. The units identity holds while the fold never emptied the
--    inventory over an oversell or an outflow above the held quantity, both
--    of which flag unknown_basis.
ALTER TABLE agg_positions
  ADD COLUMN pooled_swaps integer NOT NULL DEFAULT 0 CHECK (pooled_swaps>=0),
  ADD COLUMN bought_raw numeric CHECK (bought_raw>=0 AND scale(bought_raw)=0),
  ADD COLUMN sold_raw numeric CHECK (sold_raw>=0 AND scale(sold_raw)=0),
  ADD CONSTRAINT agg_positions_pooled_flag CHECK ((pooled_swaps>0) = ('pooled_route' = ANY(flags))),
  ADD CONSTRAINT agg_positions_units CHECK (
    (bought_raw IS NULL) = (sold_raw IS NULL)
    AND (bought_raw IS NULL OR 'unknown_basis' = ANY(flags)
      OR quantity_raw = bought_raw + inflow_raw - sold_raw - outflow_raw));

-- 4. The XOR admits pooled_route beside the other informational flags. The
--    constraint in place is found by its definition (migration 022 named it,
--    017 did not) and rebuilt with the one flag added, so a database that
--    has not applied 022 yet keeps 017's rule and gains only the flag.
DO $$
DECLARE old_name text; old_def text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid) INTO old_name, old_def FROM pg_constraint
    WHERE conrelid='agg_positions'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%unattributed_swap_activity%';
  IF old_name IS NULL THEN
    RAISE EXCEPTION 'agg_positions flag constraint not found';
  END IF;
  IF old_def NOT LIKE '%''counterparty_route''::text%' OR old_def LIKE '%pooled_route%' THEN
    RAISE EXCEPTION 'agg_positions flag constraint has an unexpected shape: %', old_def;
  END IF;
  EXECUTE format('ALTER TABLE agg_positions DROP CONSTRAINT %I', old_name);
  EXECUTE format('ALTER TABLE agg_positions ADD CONSTRAINT agg_positions_flags %s',
    replace(old_def, '''counterparty_route''::text', '''counterparty_route''::text, ''pooled_route''::text'));
END $$;

-- 5. A pooled swap is one trade for the pool and one seller (or buyer) per
--    contributor, so an hour's distinct sellers may exceed its sells.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
    WHERE conrelid='agg_pool_hours'::regclass AND contype='c'
      AND (pg_get_constraintdef(oid) LIKE '%buyers <= buys%' OR pg_get_constraintdef(oid) LIKE '%sellers <= sells%')
  LOOP
    EXECUTE format('ALTER TABLE agg_pool_hours DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE agg_pool_hours
  ADD CONSTRAINT agg_pool_hours_buyers CHECK (buyers>=0),
  ADD CONSTRAINT agg_pool_hours_sellers CHECK (sellers>=0);

-- 6. The live ring keeps a pooled swap as one row without a wallet, as it
--    keeps an unattributed one.
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
  ADD CONSTRAINT agg_live_trades_attribution CHECK (attribution IN ('initiator','counterparty','pooled','unattributed')),
  ADD CONSTRAINT agg_live_trades_wallet CHECK ((wallet_ref IS NULL) = (attribution IN ('pooled','unattributed')));

-- 7. The journal's pre-images are what a walk-back restores under these
--    constraints: a position pre-image gains the counter it lacked (zero,
--    since no batch it predates folded a pooled swap); the unit totals stay
--    absent and restore as null, unknown, which is what they are.
UPDATE agg_journal SET before=before||'{"pooled_swaps":0}'::jsonb
  WHERE chain_id=4663 AND "table"='agg_positions' AND before IS NOT NULL AND NOT (before ? 'pooled_swaps');

COMMENT ON COLUMN agg_streams.fold_rule IS 'The attribution rule the stream''s whole history is folded under: 1 leaves a pooled swap unattributed, 2 attributes it pro rata to its contributors. Fixed at creation; a rule change is a re-fold into a fresh ledger, never an update here.';
COMMENT ON COLUMN agg_streams.fold_rule_since IS 'When readers started serving this stream under its rule (unix seconds), set at the swap-in; the wallet page discloses it. Null until then.';
COMMENT ON COLUMN agg_positions.pooled_swaps IS 'Swaps attributed to this position pro rata through a pooled transaction (fold rule 2); pooled_route follows it.';
COMMENT ON COLUMN agg_positions.bought_raw IS 'Token units bought through attributed swaps; null on a position written before the totals were folded.';
COMMENT ON COLUMN agg_positions.sold_raw IS 'Token units sold through attributed swaps; null with bought_raw.';
COMMENT ON COLUMN agg_batches.pooled IS 'Of attributed, the swaps attributed pro rata to several contributors.';
