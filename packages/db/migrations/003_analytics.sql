-- Published product reads are separate from raw indexer checkpoints.
CREATE TABLE analytics_pool_snapshots (
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  pool_id text NOT NULL,
  through_block bigint NOT NULL CHECK (through_block >= 0),
  through_hash text NOT NULL CHECK (through_hash ~ '^0x[0-9a-f]{64}$'),
  asof_timestamp bigint NOT NULL CHECK (asof_timestamp >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL CHECK ((jsonb_typeof(snapshot) = 'object' AND snapshot->>'schemaVersion' = '1' AND snapshot->>'chainId' = '4663' AND jsonb_array_length(snapshot->'markets') = 1) IS TRUE),
  holders jsonb,
  liquidity_wei text CHECK (liquidity_wei IS NULL OR liquidity_wei ~ '^(0|[1-9][0-9]*)$'),
  source_kind text NOT NULL CHECK (source_kind IN ('indexed','rpc_capture')),
  source_stream text,
  source_batch bigint,
  evidence jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (chain_id,pool_id),
  FOREIGN KEY (chain_id,pool_id) REFERENCES indexed_pools ON DELETE CASCADE,
  FOREIGN KEY (chain_id,source_stream,source_batch) REFERENCES indexer_batches(chain_id,stream_key,to_block) ON DELETE CASCADE,
  CHECK ((source_kind='indexed' AND source_stream IS NOT NULL AND source_batch IS NOT NULL)
    OR (source_kind='rpc_capture' AND source_stream IS NULL AND source_batch IS NULL)),
  CHECK ((snapshot->>'toBlock' = through_block::text AND snapshot->>'blockHash' = through_hash AND snapshot->>'toTimestamp' = asof_timestamp::text) IS TRUE),
  CHECK ((snapshot->'markets'->0->>'id' = pool_id) IS TRUE)
);
CREATE TABLE analytics_pool_jobs (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_id text NOT NULL,
  attempted_at timestamptz,
  published_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  PRIMARY KEY (chain_id,pool_id),
  FOREIGN KEY (chain_id,pool_id) REFERENCES indexed_pools ON DELETE CASCADE
);
CREATE INDEX analytics_pool_jobs_due ON analytics_pool_jobs(next_attempt_at,pool_id);
COMMENT ON TABLE analytics_pool_snapshots IS 'Latest validated pool capture for product reads. Exact per-pool cutoff, no claim of whole-chain coverage or complete wallet profit.';
