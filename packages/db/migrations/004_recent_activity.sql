-- Recent activity is deliberately separate from birth-contiguous PnL evidence.
CREATE TABLE recent_streams (
  chain_id integer NOT NULL CHECK(chain_id=4663),
  stream_key text NOT NULL CHECK(stream_key IN ('discovery','swaps')),
  start_block bigint NOT NULL CHECK(start_block>=0),
  cursor_block bigint,
  cursor_hash text,
  cursor_timestamp bigint,
  head_block bigint,
  head_timestamp bigint,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,stream_key),
  CHECK((cursor_block IS NULL)=(cursor_hash IS NULL) AND (cursor_block IS NULL)=(cursor_timestamp IS NULL)),
  CHECK(cursor_block IS NULL OR cursor_block>=start_block)
);
CREATE TABLE recent_batches (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  from_block bigint NOT NULL,
  to_block bigint NOT NULL CHECK(to_block>=from_block),
  block_hash text NOT NULL,
  to_timestamp bigint NOT NULL,
  content_hash text NOT NULL,
  evidence jsonb NOT NULL,
  observed_swaps integer NOT NULL DEFAULT 0,
  unregistered_swaps integer NOT NULL DEFAULT 0,
  unsupported_swaps integer NOT NULL DEFAULT 0,
  collected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,stream_key,to_block),
  FOREIGN KEY(chain_id,stream_key) REFERENCES recent_streams ON DELETE CASCADE
);
CREATE TABLE recent_pools (
  chain_id integer NOT NULL CHECK(chain_id=4663),
  pool_id text NOT NULL,
  token text NOT NULL,
  name text NOT NULL,
  symbol text NOT NULL,
  launch_block bigint NOT NULL,
  launch_tx text NOT NULL,
  launch_sender text NOT NULL,
  launched_at bigint NOT NULL,
  source_stream text NOT NULL DEFAULT 'discovery' CHECK(source_stream='discovery'),
  source_batch bigint NOT NULL,
  PRIMARY KEY(chain_id,pool_id),
  FOREIGN KEY(chain_id,source_stream,source_batch) REFERENCES recent_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE INDEX recent_pools_token ON recent_pools(chain_id,token);
CREATE TABLE recent_swaps (
  chain_id integer NOT NULL CHECK(chain_id=4663),
  source_stream text NOT NULL DEFAULT 'swaps' CHECK(source_stream='swaps'),
  batch_end bigint NOT NULL,
  pool_id text NOT NULL,
  token text NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL CHECK(log_index>=0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  timestamp bigint NOT NULL,
  transaction_sender text NOT NULL,
  amount0 text NOT NULL,
  amount1 text NOT NULL,
  eth_wei text NOT NULL,
  token_raw text NOT NULL,
  side text NOT NULL CHECK(side IN ('buy','sell')),
  PRIMARY KEY(chain_id,tx_hash,log_index),
  FOREIGN KEY(chain_id,source_stream,batch_end) REFERENCES recent_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE INDEX recent_swaps_latest ON recent_swaps(chain_id,block_number DESC,log_index DESC,tx_hash DESC);
COMMENT ON TABLE recent_swaps IS 'Receipt-backed swaps only in DB-verified Pools markets. Transaction sender is not beneficiary. Never use recent-window records as complete PnL or holder history.';

CREATE INDEX recent_swaps_pool_latest ON recent_swaps(chain_id,pool_id,block_number DESC,log_index DESC,tx_hash DESC);
