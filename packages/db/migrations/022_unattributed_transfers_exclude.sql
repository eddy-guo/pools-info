-- A transfer the ledger did not attribute to a swap excludes the position
-- (decided 18 Sep 2026). Tokens that arrived without a swap have no basis
-- the ledger can vouch for, and a later sale of them booked its whole
-- proceeds as profit: on the 24h board of 18 Sep, 58 of the top 100 rested
-- on a cost under one percent of their realized figure, sybil receivers of
-- creator-run farms. Tokens that left without a swap took their basis to a
-- disposition the ledger never saw (the same farms' buying wallets: buy,
-- fan out, the receivers sell), so that position's outcome is unknown rather
-- than the sales it did see. The fold (packages/core/src/ledger.ts) now
-- treats `zero_cost_inflow` and the new `unattributed_outflow` as excluding
-- flags beside `unknown_basis` and `unattributed_swap_activity`; this
-- migration brings every row written under the old rule to the new one and
-- rebuilds the windows from the hours, so the board is re-ranked rather
-- than filtered. It runs at the tip loop's start under the writer lock, in
-- one transaction with the constraints that enforce the rule from here on;
-- the api only reads while it runs.

-- 0. Migration 017's XOR names zero_cost_inflow as a flag a supported
--    position may carry and would refuse step 1; it goes first and step 4
--    puts the new rule in its place. 017 left it unnamed, so it is found by
--    its definition. The table stays locked against every other session
--    until the transaction commits (an ALTER TABLE's lock), which is the
--    point: nothing reads or writes a position between the two rules.
DO $$
DECLARE old_name text;
BEGIN
  SELECT conname INTO old_name FROM pg_constraint
    WHERE conrelid='agg_positions'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%unattributed_swap_activity%';
  IF old_name IS NULL THEN
    RAISE EXCEPTION 'agg_positions flag constraint from migration 017 not found';
  END IF;
  EXECUTE format('ALTER TABLE agg_positions DROP CONSTRAINT %I', old_name);
END $$;

-- 1. Every position with an inflow or an outflow is excluded; one with an
--    outflow gains the flag the fold now derives from outflow_raw > 0, kept
--    in the fold's own order (byte order, as JavaScript sorts it). Finances
--    of an excluded position stay on the row (readers serve null for them),
--    as for the two other excluding flags.
UPDATE agg_positions SET supported=false,
    flags=CASE WHEN outflow_raw>0
      THEN array(SELECT f FROM unnest(flags||'{unattributed_outflow}'::text[]) AS f ORDER BY f COLLATE "C")
      ELSE flags END
  WHERE chain_id=4663 AND ((supported AND 'zero_cost_inflow'=ANY(flags)) OR outflow_raw>0);

-- 2. Their hour rows keep counts and volume and lose their finances, exactly
--    as the writer zeroes them when a position is excluded mid-stream. Rows
--    of positions excluded earlier are already zero, so the join is over the
--    counters rather than over step 1's result and the update is idempotent.
UPDATE agg_wallet_hours h
  SET realized_wei=0,disposed_cost_wei=0,proceeds_wei=0,spent_wei=0,supported_trades=0,
    wins=0,losses=0,closures=0,hold_seconds=0,flash_closures=0,best_wei=NULL
  FROM agg_positions p
  WHERE h.chain_id=4663 AND p.chain_id=4663 AND p.wallet_ref=h.wallet_ref AND p.pool_ref=h.pool_ref
    AND (p.inflow_raw>0 OR p.outflow_raw>0)
    AND (h.realized_wei<>0 OR h.disposed_cost_wei<>0 OR h.proceeds_wei<>0 OR h.spent_wei<>0
      OR h.supported_trades<>0 OR h.wins<>0 OR h.losses<>0 OR h.closures<>0 OR h.hold_seconds<>0
      OR h.flash_closures IS DISTINCT FROM 0 OR h.best_wei IS NOT NULL);

-- 3. The journal's pre-images are what a walk-back restores, so they must
--    satisfy the new rule too: a position pre-image with an inflow or an
--    outflow becomes excluded (and gains the outflow flag), and an hour
--    pre-image whose position had either at that batch's start (its
--    pre-image in the same batch; every hour row a batch journals has its
--    position journaled with it) loses its finances. A position whose
--    transfer came later is left as it was, since it was supported at that
--    point under either rule.
UPDATE agg_journal SET before=before
    ||'{"supported":false}'::jsonb
    ||CASE WHEN (before->>'outflow_raw')::numeric>0
      THEN jsonb_build_object('flags',(SELECT jsonb_agg(f ORDER BY f COLLATE "C") FROM jsonb_array_elements_text(before->'flags'||'["unattributed_outflow"]'::jsonb) AS f))
      ELSE '{}'::jsonb END
  WHERE chain_id=4663 AND "table"='agg_positions' AND before IS NOT NULL
    AND (((before->>'supported')::boolean AND before->'flags' ? 'zero_cost_inflow') OR (before->>'outflow_raw')::numeric>0);
UPDATE agg_journal h
  SET before=h.before||'{"realized_wei":0,"disposed_cost_wei":0,"proceeds_wei":0,"spent_wei":0,"supported_trades":0,"wins":0,"losses":0,"closures":0,"hold_seconds":0,"flash_closures":0,"best_wei":null}'::jsonb
  FROM agg_journal p
  WHERE h.chain_id=4663 AND h."table"='agg_wallet_hours' AND h.before IS NOT NULL
    AND p.chain_id=h.chain_id AND p.stream_key=h.stream_key AND p.batch_end=h.batch_end AND p."table"='agg_positions'
    AND p.key->>'wallet_ref'=h.key->>'wallet_ref' AND p.key->>'pool_ref'=h.key->>'pool_ref'
    AND p.before IS NOT NULL AND ((p.before->>'inflow_raw')::numeric>0 OR (p.before->>'outflow_raw')::numeric>0);

-- 4. The XOR the database enforces from here on: a supported position
--    carries only informational flags, an excluded one an excluding flag;
--    and the outflow flag follows its counter as the inflow flag does
--    (migration 017). Validated over every row, so a position step 1 missed
--    would refuse the migration rather than stand supported.
ALTER TABLE agg_positions
  ADD CONSTRAINT agg_positions_flags CHECK (
    (supported AND flags <@ ARRAY['wrapper_route','counterparty_route'])
    OR (NOT supported AND (flags && ARRAY['zero_cost_inflow','unattributed_outflow','unknown_basis','unattributed_swap_activity']))),
  ADD CONSTRAINT agg_positions_outflow_flag CHECK ((outflow_raw>0) = ('unattributed_outflow' = ANY(flags)));

-- 5. The windows, rebuilt from the hour rows and re-ranked, in this same
--    transaction, so no read ever sees the old sums beside the new
--    positions or a window without its refresh row. The statements are
--    packages/db/src/ledger-windows.ts's rebuild (windowRows, rankWindow and
--    the refresh row) as of this migration; ledger-windows.test.ts asserts
--    the writer's own rebuild reproduces these rows. Nothing to rebuild
--    where the ledger has no cursor (a database the pass never ran on).
DO $$
DECLARE
  v_cursor bigint;
  v_cursor_timestamp bigint;
  w record;
  v_start integer;
  v_wallets integer;
  v_ranked integer;
BEGIN
  SELECT cursor_block,cursor_timestamp INTO v_cursor,v_cursor_timestamp FROM agg_streams
    WHERE chain_id=4663 AND stream_key='ledger:agg:v1';
  IF v_cursor IS NULL THEN RETURN; END IF;
  SET LOCAL work_mem='256MB';
  DELETE FROM agg_wallet_windows WHERE chain_id=4663;
  FOR w IN SELECT * FROM (VALUES ('1h',3600),('6h',21600),('24h',86400),('7d',604800),('30d',2592000),('All',NULL)) AS v(name,seconds) LOOP
    v_start := CASE WHEN w.seconds IS NULL THEN 0
      ELSE greatest(0,(v_cursor_timestamp/3600)::integer-w.seconds/3600+1) END;
    INSERT INTO agg_wallet_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,trades,supported_trades,wins,losses,closures,hold_seconds,flash_closures,best_wei,last_timestamp,supported_positions,excluded_positions,rank,window_start,refreshed_at)
    SELECT 4663,w.name,h.wallet_ref,h.realized,h.net,h.volume,h.disposed,h.trades,h.supported_trades,h.wins,h.losses,h.closures,h.hold_seconds,
      CASE WHEN h.untimed THEN NULL ELSE h.flash END,h.best,p.last_timestamp,coalesce(p.supported,0),coalesce(p.excluded,0),NULL,v_start,clock_timestamp()
    FROM (
      SELECT wallet_ref,sum(realized_wei) AS realized,sum(proceeds_wei)-sum(spent_wei) AS net,sum(volume_wei) AS volume,
        sum(disposed_cost_wei) AS disposed,sum(buys+sells)::int AS trades,sum(supported_trades)::int AS supported_trades,
        sum(wins)::int AS wins,sum(losses)::int AS losses,sum(closures)::int AS closures,sum(hold_seconds)::bigint AS hold_seconds,
        coalesce(sum(flash_closures),0)::int AS flash,bool_or(flash_closures IS NULL AND closures>0) AS untimed,max(best_wei) AS best
      FROM agg_wallet_hours WHERE chain_id=4663 AND hour>=v_start
      GROUP BY wallet_ref
    ) h
    LEFT JOIN (
      SELECT wallet_ref,count(*) FILTER (WHERE supported AND buys+sells>0)::int AS supported,
        count(*) FILTER (WHERE NOT supported)::int AS excluded,
        (max(last_timestamp) FILTER (WHERE buys+sells>0))::bigint AS last_timestamp
      FROM agg_positions WHERE chain_id=4663 GROUP BY wallet_ref
    ) p USING (wallet_ref);
  END LOOP;
  ANALYZE agg_wallet_windows;
  FOR w IN SELECT * FROM (VALUES ('1h',3600),('6h',21600),('24h',86400),('7d',604800),('30d',2592000),('All',NULL)) AS v(name,seconds) LOOP
    v_start := CASE WHEN w.seconds IS NULL THEN 0
      ELSE greatest(0,(v_cursor_timestamp/3600)::integer-w.seconds/3600+1) END;
    SELECT count(*) INTO v_wallets FROM agg_wallet_windows WHERE chain_id=4663 AND "window"=w.name;
    WITH top AS (
      SELECT x.wallet_ref,row_number() OVER (ORDER BY x.realized_wei DESC,a.address) AS rn
      FROM agg_wallet_windows x JOIN agg_wallets a USING (wallet_ref)
      WHERE x.chain_id=4663 AND x."window"=w.name AND x.supported_trades>=10 AND x.supported_positions>0
      ORDER BY x.realized_wei DESC,a.address LIMIT 100
    )
    UPDATE agg_wallet_windows x SET rank=top.rn FROM top
      WHERE x.chain_id=4663 AND x."window"=w.name AND x.wallet_ref=top.wallet_ref;
    GET DIAGNOSTICS v_ranked=ROW_COUNT;
    INSERT INTO agg_window_refreshes(chain_id,stream_key,"window",through_block,through_timestamp,window_start,wallets,ranked,refreshed_at)
      VALUES (4663,'ledger:agg:v1',w.name,v_cursor,v_cursor_timestamp,v_start,v_wallets,v_ranked,clock_timestamp())
      ON CONFLICT (chain_id,"window") DO UPDATE SET stream_key=EXCLUDED.stream_key,through_block=EXCLUDED.through_block,
        through_timestamp=EXCLUDED.through_timestamp,window_start=EXCLUDED.window_start,wallets=EXCLUDED.wallets,
        ranked=EXCLUDED.ranked,refreshed_at=EXCLUDED.refreshed_at;
  END LOOP;
END $$;

COMMENT ON CONSTRAINT agg_positions_flags ON agg_positions IS 'A supported position carries only informational flags; zero_cost_inflow, unattributed_outflow, unknown_basis and unattributed_swap_activity each exclude.';
