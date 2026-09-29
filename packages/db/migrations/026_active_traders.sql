-- Lifetime distinct wallets with an attributed trade. The wallet-hours table
-- is the source of truth; the fold advances this one-row total in the same
-- transaction as its cursor. The API can therefore read it at the exact cut
-- without scanning every hour on each request.
CREATE TABLE agg_active_trader_counts (
  chain_id integer PRIMARY KEY CHECK (chain_id=4663),
  through_block bigint,
  through_timestamp bigint CHECK (through_timestamp>=0),
  active_traders bigint NOT NULL CHECK (active_traders>=0),
  CHECK ((through_block IS NULL) = (through_timestamp IS NULL))
);

INSERT INTO agg_active_trader_counts(chain_id,through_block,through_timestamp,active_traders)
SELECT 4663,s.cursor_block,s.cursor_timestamp,
  (SELECT count(DISTINCT wallet_ref) FROM agg_wallet_hours WHERE chain_id=4663)
FROM (SELECT cursor_block,cursor_timestamp FROM agg_streams
  WHERE chain_id=4663 AND stream_key='ledger:agg:v1') s
UNION ALL
SELECT 4663,NULL,NULL,0 WHERE NOT EXISTS
  (SELECT 1 FROM agg_streams WHERE chain_id=4663 AND stream_key='ledger:agg:v1');

COMMENT ON TABLE agg_active_trader_counts IS 'Distinct wallets in agg_wallet_hours through the stamped main ledger cursor; maintained with every fold and walk-back under the writer lock.';
