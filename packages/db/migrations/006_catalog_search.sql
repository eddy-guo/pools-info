-- Keep search work in Postgres as the verified launch catalog grows.
-- Explicit public placement also supports isolated application schemas.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

-- Favor predictable search latency: catalog metadata is appended infrequently,
-- so maintain the GIN tree immediately instead of accumulating pending entries.
CREATE INDEX indexed_pools_name_search ON indexed_pools USING gin (lower(name) public.gin_trgm_ops) WITH (fastupdate=off);
CREATE INDEX indexed_pools_symbol_search ON indexed_pools USING gin (lower(symbol) public.gin_trgm_ops) WITH (fastupdate=off);
CREATE INDEX indexed_pools_token_prefix ON indexed_pools (chain_id, token text_pattern_ops);
CREATE INDEX indexed_pools_id_prefix ON indexed_pools (chain_id, pool_id text_pattern_ops);
CREATE INDEX indexed_pools_creator_prefix ON indexed_pools (chain_id, launch_sender text_pattern_ops);
CREATE INDEX indexed_pools_tx_prefix ON indexed_pools (chain_id, launch_tx text_pattern_ops);

CREATE INDEX recent_pools_name_search ON recent_pools USING gin (lower(name) public.gin_trgm_ops) WITH (fastupdate=off);
CREATE INDEX recent_pools_symbol_search ON recent_pools USING gin (lower(symbol) public.gin_trgm_ops) WITH (fastupdate=off);
CREATE INDEX recent_pools_token_prefix ON recent_pools (chain_id, token text_pattern_ops);
CREATE INDEX recent_pools_id_prefix ON recent_pools (chain_id, pool_id text_pattern_ops);
CREATE INDEX recent_pools_creator_prefix ON recent_pools (chain_id, launch_sender text_pattern_ops);
CREATE INDEX recent_pools_tx_prefix ON recent_pools (chain_id, launch_tx text_pattern_ops);
