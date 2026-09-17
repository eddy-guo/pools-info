-- The aggregate ledger (docs/AGGREGATE-LEDGER.md, design report section 6).
-- Every table is new; nothing in 001 to 016 changes. Amounts are integer-exact
-- numerics, addresses and hashes are bytea at rest, chain_id is checked on
-- every row, and the accounting identities are enforced here, not in code.

-- Catalog identity is unchanged. pool_ref is the integer surrogate the ledger
-- tables reference; decimals is read by the pass and is null until then.
ALTER TABLE indexed_pools
  ADD COLUMN pool_ref integer GENERATED ALWAYS AS IDENTITY UNIQUE,
  ADD COLUMN decimals smallint CHECK (decimals BETWEEN 0 AND 36);

CREATE TABLE agg_wallets (
  wallet_ref integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  address bytea NOT NULL UNIQUE CHECK (octet_length(address)=20),
  first_block bigint NOT NULL CHECK (first_block>=0)
);

-- One row: the ledger stream. mode 'pass' is the one-time history pass,
-- 'tip' the live loop; both write through the same applyBatch.
CREATE TABLE agg_streams (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='ledger:agg:v1'),
  start_block bigint NOT NULL CHECK (start_block=23467030),
  cursor_block bigint CHECK (cursor_block>=start_block),
  cursor_hash bytea CHECK (octet_length(cursor_hash)=32),
  cursor_timestamp bigint CHECK (cursor_timestamp>=0),
  head_block bigint CHECK (head_block>=0),
  head_timestamp bigint CHECK (head_timestamp>=0),
  checked_at timestamptz,
  mode text NOT NULL CHECK (mode IN ('pass','tip')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream_key),
  CHECK ((cursor_block IS NULL)=(cursor_hash IS NULL) AND (cursor_block IS NULL)=(cursor_timestamp IS NULL)),
  CHECK ((head_block IS NULL)=(head_timestamp IS NULL))
);

-- One row per committed range: the checkpoint list. The 128-block lag is
-- proven per batch by archive_height; the content hash (section 6.1) is the
-- SHA-256 of the canonical serialisation of the rows the batch consumed.
CREATE TABLE agg_batches (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL,
  to_block bigint NOT NULL,
  from_block bigint NOT NULL CHECK (from_block<=to_block),
  from_parent_hash bytea NOT NULL CHECK (octet_length(from_parent_hash)=32),
  block_hash bytea NOT NULL CHECK (octet_length(block_hash)=32),
  to_timestamp bigint NOT NULL CHECK (to_timestamp>=0),
  archive_height bigint NOT NULL CHECK (archive_height>=to_block+128),
  registry_pools integer NOT NULL CHECK (registry_pools>=0),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash)=32),
  query jsonb NOT NULL,
  pages jsonb NOT NULL,
  swaps integer NOT NULL CHECK (swaps>=0),
  transfers integer NOT NULL CHECK (transfers>=0),
  launches integer NOT NULL CHECK (launches>=0),
  attributed integer NOT NULL CHECK (attributed>=0),
  unattributed integer NOT NULL CHECK (unattributed>=0),
  unregistered_swaps integer NOT NULL CHECK (unregistered_swaps>=0),
  requests integer NOT NULL CHECK (requests>=0),
  bytes bigint NOT NULL CHECK (bytes>=0),
  collected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream_key, to_block),
  FOREIGN KEY (chain_id, stream_key) REFERENCES agg_streams ON DELETE CASCADE,
  CHECK (attributed+unattributed+unregistered_swaps=swaps)
);

-- One row per (pool, wallet) that ever held or traded the token. The
-- identities replace the per-sale realized = eth - disposed_cost rule at the
-- position level; the XOR is kept: a supported position carries only
-- informational flags, an excluded one carries an excluding flag and its
-- finances are never served.
CREATE TABLE agg_positions (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  wallet_ref integer NOT NULL REFERENCES agg_wallets,
  quantity_raw numeric NOT NULL CHECK (quantity_raw>=0 AND scale(quantity_raw)=0),
  cost_wei numeric NOT NULL CHECK (cost_wei>=0 AND scale(cost_wei)=0),
  invested_wei numeric NOT NULL CHECK (invested_wei>=0 AND scale(invested_wei)=0),
  proceeds_wei numeric NOT NULL CHECK (proceeds_wei>=0 AND scale(proceeds_wei)=0),
  disposed_cost_wei numeric NOT NULL CHECK (disposed_cost_wei>=0 AND scale(disposed_cost_wei)=0),
  realized_wei numeric NOT NULL CHECK (scale(realized_wei)=0),
  inflow_raw numeric NOT NULL CHECK (inflow_raw>=0 AND scale(inflow_raw)=0),
  outflow_raw numeric NOT NULL CHECK (outflow_raw>=0 AND scale(outflow_raw)=0),
  outflow_cost_wei numeric NOT NULL CHECK (outflow_cost_wei>=0 AND scale(outflow_cost_wei)=0),
  buys integer NOT NULL CHECK (buys>=0),
  sells integer NOT NULL CHECK (sells>=0),
  wrapper_swaps integer NOT NULL CHECK (wrapper_swaps>=0),
  counterparty_swaps integer NOT NULL CHECK (counterparty_swaps>=0),
  cycle_opened_at bigint CHECK (cycle_opened_at>=0),
  cycle_gain_wei numeric CHECK (scale(cycle_gain_wei)=0),
  first_block bigint NOT NULL CHECK (first_block>=0),
  last_block bigint NOT NULL CHECK (last_block>=first_block),
  last_timestamp bigint NOT NULL CHECK (last_timestamp>=0),
  supported boolean NOT NULL,
  flags text[] NOT NULL,
  PRIMARY KEY (chain_id, pool_ref, wallet_ref),
  CHECK (realized_wei = proceeds_wei - disposed_cost_wei),
  CHECK (invested_wei = cost_wei + disposed_cost_wei + outflow_cost_wei),
  CHECK ((supported AND cardinality(flags)=0)
    OR (supported AND flags <@ ARRAY['zero_cost_inflow','wrapper_route','counterparty_route'])
    OR (NOT supported AND (flags && ARRAY['unknown_basis','unattributed_swap_activity']))),
  CHECK ((inflow_raw>0) = ('zero_cost_inflow' = ANY(flags))),
  CHECK ((wrapper_swaps>0) = ('wrapper_route' = ANY(flags))),
  CHECK ((counterparty_swaps>0) = ('counterparty_route' = ANY(flags))),
  CHECK ((cycle_opened_at IS NULL) = (cycle_gain_wei IS NULL)),
  CHECK ((quantity_raw>0) = (cycle_opened_at IS NOT NULL))
);
CREATE INDEX agg_positions_wallet ON agg_positions (chain_id, wallet_ref) INCLUDE (realized_wei, supported);
CREATE INDEX agg_positions_holders ON agg_positions (chain_id, pool_ref) WHERE quantity_raw>0;

-- Realized PnL per wallet per pool per UTC hour (hour = floor(timestamp/3600)).
-- Keyed per pool so that a position excluded later has exactly its own rows
-- zeroed, and so each row witnesses one distinct buyer or seller of its pool
-- hour. Finances come from supported positions only; buys, sells and volume
-- count every attributed swap.
CREATE TABLE agg_wallet_hours (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  wallet_ref integer NOT NULL REFERENCES agg_wallets,
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  hour integer NOT NULL CHECK (hour>=0),
  realized_wei numeric NOT NULL CHECK (scale(realized_wei)=0),
  disposed_cost_wei numeric NOT NULL CHECK (disposed_cost_wei>=0 AND scale(disposed_cost_wei)=0),
  proceeds_wei numeric NOT NULL CHECK (proceeds_wei>=0 AND scale(proceeds_wei)=0),
  spent_wei numeric NOT NULL CHECK (spent_wei>=0 AND scale(spent_wei)=0),
  volume_wei numeric NOT NULL CHECK (volume_wei>=0 AND scale(volume_wei)=0),
  buys integer NOT NULL CHECK (buys>=0),
  sells integer NOT NULL CHECK (sells>=0),
  supported_trades integer NOT NULL CHECK (supported_trades>=0 AND supported_trades<=buys+sells),
  wins integer NOT NULL CHECK (wins>=0),
  losses integer NOT NULL CHECK (losses>=0),
  closures integer NOT NULL CHECK (closures>=wins+losses),
  hold_seconds bigint NOT NULL CHECK (hold_seconds>=0),
  best_wei numeric CHECK (scale(best_wei)=0),
  PRIMARY KEY (chain_id, wallet_ref, pool_ref, hour),
  CHECK (realized_wei = proceeds_wei - disposed_cost_wei),
  CHECK (buys+sells>0)
);
CREATE INDEX agg_wallet_hours_hour ON agg_wallet_hours (chain_id, hour) INCLUDE (wallet_ref, realized_wei, supported_trades);

-- Materialised per window; rebuilt by the tip loop (phase 3). rank is the
-- dense rank by realized among eligible wallets, null otherwise.
CREATE TABLE agg_wallet_windows (
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
  best_wei numeric CHECK (scale(best_wei)=0),
  last_timestamp bigint CHECK (last_timestamp>=0),
  supported_positions integer NOT NULL CHECK (supported_positions>=0),
  excluded_positions integer NOT NULL CHECK (excluded_positions>=0),
  rank integer CHECK (rank>=1),
  window_start integer NOT NULL CHECK (window_start>=0),
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, "window", wallet_ref)
);
CREATE INDEX agg_wallet_windows_rank ON agg_wallet_windows (chain_id, "window", rank) WHERE rank IS NOT NULL;

-- Pool activity per UTC hour with the OHLC of sqrtPriceX96 in log order.
CREATE TABLE agg_pool_hours (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  hour integer NOT NULL CHECK (hour>=0),
  trades integer NOT NULL CHECK (trades>0),
  buys integer NOT NULL CHECK (buys>=0),
  sells integer NOT NULL CHECK (sells>=0),
  unattributed integer NOT NULL CHECK (unattributed>=0 AND unattributed<=trades),
  volume_wei numeric NOT NULL CHECK (volume_wei>=0 AND scale(volume_wei)=0),
  buyers integer NOT NULL CHECK (buyers>=0 AND buyers<=buys),
  sellers integer NOT NULL CHECK (sellers>=0 AND sellers<=sells),
  open_sqrt_price_x96 numeric NOT NULL CHECK (open_sqrt_price_x96>=0 AND scale(open_sqrt_price_x96)=0),
  close_sqrt_price_x96 numeric NOT NULL CHECK (close_sqrt_price_x96>=0 AND scale(close_sqrt_price_x96)=0),
  high_sqrt_price_x96 numeric NOT NULL CHECK (high_sqrt_price_x96>=0 AND scale(high_sqrt_price_x96)=0),
  low_sqrt_price_x96 numeric NOT NULL CHECK (low_sqrt_price_x96>=0 AND scale(low_sqrt_price_x96)=0),
  close_block bigint NOT NULL CHECK (close_block>=0),
  close_log_index integer NOT NULL CHECK (close_log_index>=0),
  PRIMARY KEY (chain_id, pool_ref, hour),
  CHECK (buys+sells=trades),
  CHECK (low_sqrt_price_x96<=high_sqrt_price_x96),
  CHECK (open_sqrt_price_x96 BETWEEN low_sqrt_price_x96 AND high_sqrt_price_x96),
  CHECK (close_sqrt_price_x96 BETWEEN low_sqrt_price_x96 AND high_sqrt_price_x96)
);
CREATE INDEX agg_pool_hours_hour ON agg_pool_hours (chain_id, hour) INCLUDE (pool_ref, trades, volume_wei);

-- One row per pool with a swap: the screener's latest values. holders is the
-- count of positions with a positive quantity, recomputed by the writer.
CREATE TABLE agg_pool_state (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  trades bigint NOT NULL CHECK (trades>0),
  volume_wei numeric NOT NULL CHECK (volume_wei>=0 AND scale(volume_wei)=0),
  holders integer NOT NULL CHECK (holders>=0),
  sqrt_price_x96 numeric NOT NULL CHECK (sqrt_price_x96>=0 AND scale(sqrt_price_x96)=0),
  liquidity numeric NOT NULL CHECK (liquidity>=0 AND scale(liquidity)=0),
  tick integer NOT NULL,
  price_block bigint NOT NULL CHECK (price_block>=0),
  price_log_index integer NOT NULL CHECK (price_log_index>=0),
  price_tx bytea NOT NULL CHECK (octet_length(price_tx)=32),
  price_timestamp bigint NOT NULL CHECK (price_timestamp>=0),
  first_trade_timestamp bigint NOT NULL CHECK (first_trade_timestamp>=0),
  last_trade_timestamp bigint NOT NULL CHECK (last_trade_timestamp>=first_trade_timestamp),
  PRIMARY KEY (chain_id, pool_ref)
);

-- Bounded ring for the live feed and a pool page's recent trades: 24 hours or
-- 250,000 rows, pruned by the writer; a walked-back batch takes its rows.
CREATE TABLE agg_live_trades (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='ledger:agg:v1'),
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  wallet_ref integer REFERENCES agg_wallets,
  tx_hash bytea NOT NULL CHECK (octet_length(tx_hash)=32),
  log_index integer NOT NULL CHECK (log_index>=0),
  block_number bigint NOT NULL CHECK (block_number>=0),
  block_hash bytea NOT NULL CHECK (octet_length(block_hash)=32),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  side text NOT NULL CHECK (side IN ('buy','sell')),
  eth_wei numeric NOT NULL CHECK (eth_wei>0 AND scale(eth_wei)=0),
  token_raw numeric NOT NULL CHECK (token_raw>0 AND scale(token_raw)=0),
  sqrt_price_x96 numeric NOT NULL CHECK (sqrt_price_x96>=0 AND scale(sqrt_price_x96)=0),
  attribution text NOT NULL CHECK (attribution IN ('initiator','counterparty','unattributed')),
  batch_end bigint NOT NULL,
  PRIMARY KEY (chain_id, tx_hash, log_index),
  FOREIGN KEY (chain_id, stream_key, batch_end) REFERENCES agg_batches ON DELETE CASCADE,
  CHECK ((wallet_ref IS NULL) = (attribution='unattributed')),
  CHECK (block_number<=batch_end)
);
CREATE INDEX agg_live_trades_latest ON agg_live_trades (chain_id, block_number DESC, log_index DESC);
CREATE INDEX agg_live_trades_pool ON agg_live_trades (chain_id, pool_ref, block_number DESC, log_index DESC);

-- Pre-images of every row a batch changed, written once per batch before its
-- first change, for reorg walk-back (section 7.2). A null pre-image means the
-- row did not exist: walking back deletes it. Kept for the newest 256 batches.
CREATE TABLE agg_journal (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  "table" text NOT NULL CHECK ("table" IN ('agg_positions','agg_wallet_hours','agg_pool_hours','agg_pool_state','agg_wallets')),
  key jsonb NOT NULL CHECK (jsonb_typeof(key)='object'),
  before jsonb CHECK (before IS NULL OR jsonb_typeof(before)='object'),
  PRIMARY KEY (chain_id, stream_key, batch_end, "table", key),
  FOREIGN KEY (chain_id, stream_key, batch_end) REFERENCES agg_batches ON DELETE CASCADE
);

COMMENT ON TABLE agg_positions IS 'Incremental average-cost position per (pool, wallet) under transfer-verified attribution. Excluded positions keep counts and quantities; readers serve null finances for them.';
COMMENT ON TABLE agg_wallet_hours IS 'Realized PnL and closure metrics per wallet, pool and UTC hour from supported positions; counts and volume from every attributed swap. Windows sum whole hours and never touch inventory.';
COMMENT ON TABLE agg_batches IS 'Committed ranges of the ledger stream with query bodies, page records and the content hash of the rows consumed; the rows themselves are re-fetchable from HyperSync.';
COMMENT ON TABLE agg_journal IS 'Row pre-images per batch for walk-back; null means the row was created by the batch.';
