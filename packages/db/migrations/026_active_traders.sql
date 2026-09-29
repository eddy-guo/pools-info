CREATE TABLE agg_active_trader_counts (
  chain_id integer PRIMARY KEY CHECK (chain_id=4663),
  through_block bigint,
  through_timestamp bigint CHECK (through_timestamp>=0),
  crowd_block bigint,
  crowd_hash bytea,
  instant_traders bigint NOT NULL CHECK (instant_traders>=0),
  all_traders bigint NOT NULL CHECK (all_traders>=instant_traders),
  CHECK ((through_block IS NULL) = (through_timestamp IS NULL)),
  CHECK ((crowd_block IS NULL) = (crowd_hash IS NULL))
);
CREATE INDEX agg_wallet_hours_pool_wallet ON agg_wallet_hours (chain_id,pool_ref,wallet_ref);

WITH cursors AS (
  SELECT m.start_block,m.cursor_block,m.cursor_timestamp,
    c.cursor_block AS crowd_block,c.cursor_hash AS crowd_hash
  FROM (SELECT start_block,cursor_block,cursor_timestamp FROM agg_streams
    WHERE chain_id=4663 AND stream_key='ledger:agg:v1') m
  LEFT JOIN agg_streams c ON c.chain_id=4663 AND c.stream_key='ledger:crowd:v1'
), eligible AS (
  SELECT p.pool_ref,p.launch_type
  FROM indexed_pools p CROSS JOIN cursors c
  LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
  WHERE p.chain_id=4663 AND p.launch_block BETWEEN c.start_block AND c.cursor_block
    AND (a.through_block IS NULL OR c.cursor_block>=a.through_block)
    AND EXISTS (SELECT 1 FROM pool_launch_sources ps
      WHERE ps.chain_id=4663 AND ps.pool_id=p.pool_id AND (
        ps.stream_key='launches:agg:v1' AND ps.batch_end<=c.cursor_block OR
        ps.stream_key='launches:crowd:v1' AND ps.batch_end<=c.crowd_block))
), wallets AS (
  SELECT h.wallet_ref,bool_or(e.launch_type='instant') AS instant
  FROM agg_wallet_hours h JOIN eligible e USING(pool_ref)
  WHERE h.chain_id=4663 GROUP BY h.wallet_ref
)
INSERT INTO agg_active_trader_counts
  (chain_id,through_block,through_timestamp,crowd_block,crowd_hash,instant_traders,all_traders)
SELECT 4663,c.cursor_block,c.cursor_timestamp,c.crowd_block,c.crowd_hash,
  (SELECT count(*) FROM wallets WHERE instant),(SELECT count(*) FROM wallets)
FROM cursors c
UNION ALL
SELECT 4663,NULL,NULL,NULL,NULL,0,0 WHERE NOT EXISTS (SELECT 1 FROM cursors);
