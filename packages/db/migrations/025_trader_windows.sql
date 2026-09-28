-- The trader board leaves out a wallet's own launches and every contract
-- (decided 28 Sep 2026). On the 7d board of 27 Sep, 51 of the top 100 traded
-- only tokens they had launched themselves: each bought inside its own
-- launch transaction and sold to the buyers who followed, at a 100 percent
-- win rate. That is a creator's take, and the creators board already credits
-- it. All-time #29 was a market-making contract many wallets call. Nothing
-- the ledger folded changes: a wallet's own row (agg_wallet_windows) keeps
-- every position and stays its profile, and the new trader row
-- (agg_trader_windows) is the same sums without the positions in pools the
-- wallet launched, which the board ranks and serves. The writer's rank stays
-- on the wallet's own row as a snapshot. A wallet with no own launch has the same trader row
-- as its own row, so every such wallet keeps its figures and its order.

CREATE TABLE agg_trader_windows (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  "window" text NOT NULL CHECK ("window" IN ('1h','6h','24h','7d','30d','All')),
  wallet_ref integer NOT NULL REFERENCES agg_wallets,
  realized_wei numeric NOT NULL CHECK (scale(realized_wei)=0),
  net_wei numeric NOT NULL CHECK (scale(net_wei)=0),
  volume_wei numeric NOT NULL CHECK (volume_wei>=0 AND scale(volume_wei)=0),
  disposed_cost_wei numeric NOT NULL CHECK (disposed_cost_wei>=0 AND scale(disposed_cost_wei)=0),
  trades integer NOT NULL CHECK (trades>=0),
  supported_trades integer NOT NULL CHECK (supported_trades>=0),
  wins integer NOT NULL CHECK (wins>=0),
  losses integer NOT NULL CHECK (losses>=0),
  closures integer NOT NULL CHECK (closures>=0),
  hold_seconds bigint NOT NULL CHECK (hold_seconds>=0),
  flash_closures integer CHECK (flash_closures>=0 AND flash_closures<=closures),
  best_wei numeric CHECK (scale(best_wei)=0),
  last_timestamp bigint CHECK (last_timestamp>=0),
  supported_positions integer NOT NULL CHECK (supported_positions>=0),
  excluded_positions integer NOT NULL CHECK (excluded_positions>=0),
  window_start integer NOT NULL CHECK (window_start>=0),
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, "window", wallet_ref)
);
-- The board's two orders over its eligible rows, as migrations 020 and 023
-- served them from the wallet rows, which no read orders any longer.
CREATE INDEX agg_trader_windows_realized ON agg_trader_windows (chain_id, "window", realized_wei DESC)
  WHERE supported_trades>=10 AND supported_positions>0;
CREATE INDEX agg_trader_windows_net ON agg_trader_windows (chain_id, "window", net_wei DESC)
  WHERE supported_trades>=10 AND supported_positions>0;
CREATE INDEX agg_trader_windows_gate_realized ON agg_trader_windows
  (chain_id, "window", (least(supported_trades,999)) DESC, realized_wei DESC)
  WHERE supported_positions>0;
CREATE INDEX agg_trader_windows_gate_net ON agg_trader_windows
  (chain_id, "window", (least(supported_trades,999)) DESC, net_wei DESC)
  WHERE supported_positions>0;
DROP INDEX agg_wallet_windows_realized;
DROP INDEX agg_wallet_windows_net;

-- The code at an address, as the api's census of the board's candidates read
-- it through the explorer (eth_getCode at the latest block). A contract is
-- code that is not an EIP-7702 delegation designator (0xef0100 followed by
-- the 20-byte delegate): such an account is still an externally owned
-- wallet, however its transactions are sent. Only wallets the ledger never
-- saw initiate a swap are read, since a deployed contract never sends a
-- transaction. A dated observation, not ledger data: a walk-back never
-- touches it.
CREATE TABLE wallet_code_observations (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  address bytea NOT NULL CHECK (octet_length(address)=20),
  kind text NOT NULL CHECK (kind IN ('contract','none')),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, address)
);

-- Read-only board spot-check on 27 Sep 2026 found this unverified 15,739-byte
-- contract created by 0x3408...E859; eth_getCode returned its bytecode on 28 Sep.
INSERT INTO wallet_code_observations(chain_id,address,kind,observed_at)
VALUES (4663,decode('91f99c026126f60a35c4306cb288388848b48faf','hex'),'contract',clock_timestamp());

CREATE TYPE trader_servable_row AS (wallet_ref integer, address bytea, metric numeric, gate integer);
CREATE FUNCTION trader_servable_refs(selected_window text, selected_metric text)
RETURNS SETOF integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  current_gate integer;
  floor_metric numeric := '-Infinity';
  top_rows trader_servable_row[] := ARRAY[]::trader_servable_row[];
  ordered_column text;
BEGIN
  IF selected_metric NOT IN ('realized','net') THEN RAISE EXCEPTION 'invalid metric'; END IF;
  ordered_column := selected_metric || '_wei';
  SELECT max(least(supported_trades,999)) INTO current_gate FROM agg_trader_windows
    WHERE chain_id=4663 AND "window"=selected_window AND supported_positions>0;
  WHILE current_gate IS NOT NULL LOOP
    EXECUTE format('SELECT coalesce(array_agg(ROW(wallet_ref,address,metric,gate)::trader_servable_row ORDER BY metric DESC,address),ARRAY[]::trader_servable_row[])
      FROM (SELECT wallet_ref,address,metric,gate FROM (
        SELECT t.wallet_ref,t.address,t.metric,t.gate FROM unnest($1) t
        UNION ALL
        SELECT x.wallet_ref,w.address,x.%I,$2 FROM agg_trader_windows x JOIN agg_wallets w USING (wallet_ref)
        WHERE x.chain_id=4663 AND x."window"=$3 AND x.supported_positions>0
          AND least(x.supported_trades,999)=$2 AND x.%I >= $4
          AND NOT EXISTS (SELECT 1 FROM wallet_code_observations c WHERE c.chain_id=4663 AND c.address=w.address AND c.kind=''contract'')
        ORDER BY 3 DESC,2 LIMIT 100
      ) merged ORDER BY metric DESC,address LIMIT 100) ranked',ordered_column,ordered_column)
      INTO top_rows USING top_rows,current_gate,selected_window,floor_metric;
    RETURN QUERY SELECT t.wallet_ref FROM unnest(top_rows) t WHERE t.gate=current_gate;
    IF cardinality(top_rows)=100 THEN floor_metric := (top_rows[100]).metric; END IF;
    EXECUTE format('SELECT least(x.supported_trades,999) FROM agg_trader_windows x
      WHERE x.chain_id=4663 AND x."window"=$1 AND x.supported_positions>0
        AND least(x.supported_trades,999)<$2 AND x.%I >= $3
      ORDER BY least(x.supported_trades,999) DESC,x.%I DESC LIMIT 1',ordered_column,ordered_column)
      INTO current_gate USING selected_window,current_gate,floor_metric;
  END LOOP;
END $$;

-- The trader rows at each window's refreshed start and the ranks from them,
-- in this same transaction, so no read ever sees ranks without the rows they
-- rank. The statements are packages/db/src/ledger-windows.ts's rebuild
-- (windowRows in the trader scope, rankWindow) as of this migration;
-- ledger-trader-windows.test.ts asserts the writer's own rebuild reproduces
-- these rows. A window without a refresh row is rebuilt by the next refresh.
DO $$
DECLARE
  w record;
  v_ranked integer;
BEGIN
  SET LOCAL work_mem='256MB';
  FOR w IN SELECT "window" AS name,window_start FROM agg_window_refreshes WHERE chain_id=4663 LOOP
    INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,trades,supported_trades,wins,losses,closures,hold_seconds,flash_closures,best_wei,last_timestamp,supported_positions,excluded_positions,window_start,refreshed_at)
    SELECT 4663,w.name,h.wallet_ref,h.realized,h.net,h.volume,h.disposed,h.trades,h.supported_trades,h.wins,h.losses,h.closures,h.hold_seconds,
      CASE WHEN h.untimed THEN NULL ELSE h.flash END,h.best,p.last_timestamp,coalesce(p.supported,0),coalesce(p.excluded,0),w.window_start,clock_timestamp()
    FROM (
      SELECT wallet_ref,sum(realized_wei) AS realized,sum(proceeds_wei)-sum(spent_wei) AS net,sum(volume_wei) AS volume,
        sum(disposed_cost_wei) AS disposed,sum(buys+sells)::int AS trades,sum(supported_trades)::int AS supported_trades,
        sum(wins)::int AS wins,sum(losses)::int AS losses,sum(closures)::int AS closures,sum(hold_seconds)::bigint AS hold_seconds,
        coalesce(sum(flash_closures),0)::int AS flash,bool_or(flash_closures IS NULL AND closures>0) AS untimed,max(best_wei) AS best
      FROM agg_wallet_hours h WHERE chain_id=4663 AND hour>=w.window_start
        AND NOT EXISTS (SELECT 1 FROM indexed_pools i JOIN agg_wallets o ON o.address=decode(substr(i.launch_sender,3),'hex')
          WHERE i.chain_id=4663 AND i.pool_ref=h.pool_ref AND o.wallet_ref=h.wallet_ref)
      GROUP BY wallet_ref
    ) h
    LEFT JOIN (
      SELECT wallet_ref,count(*) FILTER (WHERE supported AND buys+sells>0)::int AS supported,
        count(*) FILTER (WHERE NOT supported)::int AS excluded,
        (max(last_timestamp) FILTER (WHERE buys+sells>0))::bigint AS last_timestamp
      FROM agg_positions a WHERE chain_id=4663
        AND NOT EXISTS (SELECT 1 FROM indexed_pools i JOIN agg_wallets o ON o.address=decode(substr(i.launch_sender,3),'hex')
          WHERE i.chain_id=4663 AND i.pool_ref=a.pool_ref AND o.wallet_ref=a.wallet_ref)
      GROUP BY wallet_ref
    ) p USING (wallet_ref);
  END LOOP;
  ANALYZE agg_trader_windows;
  UPDATE agg_wallet_windows SET rank=NULL WHERE chain_id=4663 AND rank IS NOT NULL;
  FOR w IN SELECT "window" AS name FROM agg_window_refreshes WHERE chain_id=4663 LOOP
    WITH top AS (
      SELECT x.wallet_ref,row_number() OVER (ORDER BY x.realized_wei DESC,a.address) AS rn
      FROM agg_trader_windows x JOIN agg_wallets a USING (wallet_ref)
      WHERE x.chain_id=4663 AND x."window"=w.name AND x.supported_trades>=10 AND x.supported_positions>0
      ORDER BY x.realized_wei DESC,a.address LIMIT 100
    )
    UPDATE agg_wallet_windows x SET rank=top.rn FROM top
      WHERE x.chain_id=4663 AND x."window"=w.name AND x.wallet_ref=top.wallet_ref;
    GET DIAGNOSTICS v_ranked=ROW_COUNT;
    UPDATE agg_window_refreshes SET ranked=v_ranked WHERE chain_id=4663 AND "window"=w.name;
  END LOOP;
END $$;

COMMENT ON TABLE agg_trader_windows IS 'Wallet totals per window without the positions in pools the wallet launched itself (its launch sender), summed from the same hours as agg_wallet_windows and refreshed with it; the trader board ranks and serves these rows, a contract never.';
COMMENT ON COLUMN agg_wallet_windows.rank IS 'The wallet''s place on the trader board: its agg_trader_windows row among the eligible non-contract rows by realized (address breaks ties), kept for the top 100 only.';
COMMENT ON TABLE wallet_code_observations IS 'Code classification at an address the trader board might rank, read by the api''s census at observed_at: contract (code that is not an EIP-7702 designator) or none (empty code or a 7702 designator). A contract is never ranked; the others are read again after a week.';
