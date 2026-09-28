-- Crowd launches: pools.xyz's quick-launch auctions (Uniswap's continuous
-- clearing auction through the two LBPStrategy singletons) that graduated
-- into a v4 pool (docs/CROWD-LAUNCHES.md). Their pools register through a
-- launch stream of their own (launches:crowd:v1) and fold through a ledger
-- stream of their own (ledger:crowd:v1), which catches their history up from
-- the ledger's start block and then follows the main ledger's cursor.
-- Additions only: nothing written before changes, and every existing row
-- reads as the Instant launch it is.

-- Where a pool came from. Every pool written before this migration was
-- verified by the Instant registry, so the default is exact for them.
ALTER TABLE indexed_pools
  ADD COLUMN launch_type text NOT NULL DEFAULT 'instant' CHECK (launch_type IN ('instant','crowd'));
COMMENT ON COLUMN indexed_pools.launch_type IS 'instant: an Instant strategy''s TokenLaunched; crowd: a pools.xyz quick-launch auction that migrated into this pool (docs/CROWD-LAUNCHES.md). A crowd pool''s launch_tx is the migration that created the pool and its launch_sender the wallet that created the auction; the migration itself is permissionless and usually sent by a keeper.';

-- Template auctions the crowd launch lane has seen created and not yet seen
-- graduate: an index from the auction to its creation block, so a later
-- Migrated log can re-read that block. Never a trust root: the migration's
-- batch re-reads and re-verifies the creation from the chain. Rewound with
-- the batch that observed the creation.
CREATE TABLE crowd_auctions (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  auction text NOT NULL CHECK (auction ~ '^0x[0-9a-f]{40}$'),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  strategy text NOT NULL CHECK (strategy ~ '^0x[0-9a-f]{40}$'),
  pool_id text NOT NULL CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  created_block bigint NOT NULL CHECK (created_block>=0),
  created_tx text NOT NULL CHECK (created_tx ~ '^0x[0-9a-f]{64}$'),
  source_stream text NOT NULL CHECK (source_stream='launches:crowd:v1'),
  source_batch bigint NOT NULL CHECK (source_batch>=created_block),
  PRIMARY KEY (chain_id, auction),
  FOREIGN KEY (chain_id, source_stream, source_batch)
    REFERENCES indexer_batches(chain_id, stream_key, to_block) ON DELETE CASCADE
);
CREATE INDEX crowd_auctions_created ON crowd_auctions (chain_id, created_block);
COMMENT ON TABLE crowd_auctions IS 'pools.xyz template auctions seen created by the crowd launch lane, keyed by auction: where to re-read a creation when its Migrated log arrives.';

-- The crowd ledger stream shares every agg_* table with the main one; its
-- pools are disjoint from the main stream's (indexed_pools.launch_type), so
-- the two never touch the same position, hour or pool row.
ALTER TABLE agg_streams DROP CONSTRAINT agg_streams_stream_key_check,
  ADD CONSTRAINT agg_streams_stream_key_check CHECK (stream_key IN ('ledger:agg:v1','ledger:crowd:v1'));
ALTER TABLE agg_live_trades DROP CONSTRAINT agg_live_trades_stream_key_check,
  ADD CONSTRAINT agg_live_trades_stream_key_check CHECK (stream_key IN ('ledger:agg:v1','ledger:crowd:v1'));
