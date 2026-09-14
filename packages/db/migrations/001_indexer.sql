CREATE TABLE IF NOT EXISTS indexer_streams (
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  stream_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('discovery', 'pool')),
  pool_id text,
  start_block bigint NOT NULL CHECK (start_block >= 0),
  cursor_block bigint,
  cursor_hash text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz NOT NULL DEFAULT 'epoch',
  PRIMARY KEY (chain_id, stream_key),
  CHECK ((cursor_block IS NULL) = (cursor_hash IS NULL)),
  CHECK (cursor_block IS NULL OR cursor_block >= start_block),
  CHECK ((kind = 'pool') = (pool_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS indexer_batches (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  from_block bigint NOT NULL,
  to_block bigint NOT NULL CHECK (to_block >= from_block),
  block_hash text NOT NULL,
  content_hash text NOT NULL,
  evidence jsonb NOT NULL,
  collected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, stream_key, to_block),
  FOREIGN KEY (chain_id, stream_key) REFERENCES indexer_streams ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS indexed_pools (
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  pool_id text NOT NULL,
  token text NOT NULL,
  name text NOT NULL,
  symbol text NOT NULL,
  launch_block bigint NOT NULL,
  launch_tx text NOT NULL,
  launch_sender text NOT NULL,
  launched_at bigint NOT NULL,
  source_stream text NOT NULL,
  source_batch bigint NOT NULL,
  PRIMARY KEY (chain_id, pool_id),
  FOREIGN KEY (chain_id, source_stream, source_batch)
    REFERENCES indexer_batches(chain_id, stream_key, to_block) ON DELETE CASCADE
);
CREATE INDEX indexed_pools_token ON indexed_pools(chain_id, token);
CREATE INDEX indexed_pools_launch ON indexed_pools(chain_id, launch_block DESC, pool_id);
CREATE TABLE IF NOT EXISTS indexed_events (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL CHECK (log_index >= 0),
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  timestamp bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('swap', 'transfer')),
  pool_id text NOT NULL,
  token text NOT NULL,
  transaction_sender text,
  payload jsonb NOT NULL,
  PRIMARY KEY (chain_id, stream_key, tx_hash, log_index),
  FOREIGN KEY (chain_id, stream_key, batch_end)
    REFERENCES indexer_batches(chain_id, stream_key, to_block) ON DELETE CASCADE
);
CREATE INDEX indexed_events_history ON indexed_events(chain_id, pool_id, kind, block_number DESC, log_index DESC);
CREATE INDEX indexed_events_sender ON indexed_events(chain_id, transaction_sender, block_number DESC);
COMMENT ON COLUMN indexed_events.transaction_sender IS 'Transaction origin, not proven trading beneficiary. Do not use directly for PnL.';
COMMENT ON TABLE indexed_events IS 'Relevant verified event evidence; coverage is per stream, not a claim of all-chain or full-life token coverage.';
