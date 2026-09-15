-- Broad activity owns a global cursor. It never advances deep pool coverage.
ALTER TABLE indexer_streams DROP CONSTRAINT indexer_streams_kind_check;
ALTER TABLE indexer_streams ADD CONSTRAINT indexer_streams_kind_check
  CHECK (kind IN ('discovery','pool','broad'));
ALTER TABLE indexer_streams ADD CONSTRAINT broad_stream_identity CHECK
  (kind <> 'broad' OR (stream_key='swaps:broad:v1' AND start_block=22754669
    AND registry_revision IS NOT NULL AND registry_source_revision IS NOT NULL
    AND registry_revision='robinhood-instant-v2'
    AND registry_source_revision='2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f'));
ALTER TABLE indexer_streams ADD CONSTRAINT broad_stream_key
  CHECK ((stream_key='swaps:broad:v1')=(kind='broad'));

CREATE TABLE broad_batches (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='swaps:broad:v1'),
  batch_end bigint NOT NULL,
  from_block bigint NOT NULL CHECK (from_block>=22754669),
  parent_hash text NOT NULL CHECK (parent_hash ~ '^0x[0-9a-f]{64}$'),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  discovery_stream text NOT NULL CHECK (discovery_stream='discovery:v2'),
  discovery_batch bigint NOT NULL CHECK (discovery_batch>=batch_end),
  discovery_hash text NOT NULL CHECK (discovery_hash ~ '^0x[0-9a-f]{64}$'),
  discovery_content_hash text NOT NULL CHECK (discovery_content_hash ~ '^[0-9a-f]{64}$'),
  serializer_version integer NOT NULL CHECK (serializer_version=1),
  -- Exact serializer bytes are retained once; indexer_batches holds the digest.
  serialized_group text NOT NULL CHECK (octet_length(serialized_group)<=16777216),
  observed_swaps integer NOT NULL CHECK (observed_swaps BETWEEN 0 AND 10000),
  unregistered_swaps integer NOT NULL CHECK (unregistered_swaps BETWEEN 0 AND observed_swaps),
  unsupported_swaps integer NOT NULL CHECK (unsupported_swaps BETWEEN 0 AND observed_swaps-unregistered_swaps),
  PRIMARY KEY (chain_id,stream_key,batch_end),
  CHECK (batch_end>=from_block AND batch_end-from_block<10000),
  FOREIGN KEY (chain_id,stream_key,batch_end)
    REFERENCES indexer_batches(chain_id,stream_key,to_block) ON DELETE CASCADE,
  FOREIGN KEY (chain_id,discovery_stream,discovery_batch)
    REFERENCES indexer_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE INDEX broad_batches_discovery ON broad_batches(chain_id,discovery_stream,discovery_batch);

CREATE TABLE broad_registry_members (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  pool_id text NOT NULL,
  -- Snapshot the complete launch/source identity for content-sensitive replay.
  identity jsonb NOT NULL,
  PRIMARY KEY (chain_id,stream_key,batch_end,pool_id),
  FOREIGN KEY (chain_id,stream_key,batch_end) REFERENCES broad_batches ON DELETE CASCADE
);
CREATE TABLE broad_swaps (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  pool_id text NOT NULL CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index>=0),
  block_number bigint NOT NULL CHECK (block_number>=22754669),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  transaction_sender text NOT NULL CHECK (transaction_sender ~ '^0x[0-9a-f]{40}$'),
  manager_sender text NOT NULL CHECK (manager_sender ~ '^0x[0-9a-f]{40}$'),
  amount0 numeric NOT NULL CHECK (scale(amount0)=0 AND amount0>=-170141183460469231731687303715884105728 AND amount0<=170141183460469231731687303715884105727),
  amount1 numeric NOT NULL CHECK (scale(amount1)=0 AND amount1>=-170141183460469231731687303715884105728 AND amount1<=170141183460469231731687303715884105727),
  sqrt_price_x96 numeric NOT NULL CHECK (scale(sqrt_price_x96)=0 AND sqrt_price_x96>=0 AND sqrt_price_x96<1461501637330902918203684832716283019655932542976),
  liquidity numeric NOT NULL CHECK (scale(liquidity)=0 AND liquidity>=0 AND liquidity<340282366920938463463374607431768211456),
  tick integer NOT NULL CHECK (tick BETWEEN -8388608 AND 8388607),
  fee integer NOT NULL CHECK (fee BETWEEN 0 AND 16777215),
  side text,
  eth_wei numeric CHECK (scale(eth_wei)=0),
  token_raw numeric CHECK (scale(token_raw)=0),
  supported boolean NOT NULL DEFAULT false CHECK (supported=false),
  flags text[] NOT NULL,
  PRIMARY KEY (chain_id,tx_hash,log_index),
  FOREIGN KEY (chain_id,stream_key,batch_end,pool_id) REFERENCES broad_registry_members ON DELETE CASCADE,
  CHECK (
    (amount0<0 AND amount1>0 AND side IS NOT DISTINCT FROM 'buy' AND eth_wei IS NOT DISTINCT FROM -amount0 AND token_raw IS NOT DISTINCT FROM amount1 AND flags=ARRAY['missing_transfer_history']) OR
    (amount0>0 AND amount1<0 AND side IS NOT DISTINCT FROM 'sell' AND eth_wei IS NOT DISTINCT FROM amount0 AND token_raw IS NOT DISTINCT FROM -amount1 AND flags=ARRAY['missing_transfer_history']) OR
    (NOT ((amount0<0 AND amount1>0) OR (amount0>0 AND amount1<0)) AND side IS NULL AND eth_wei IS NULL AND token_raw IS NULL AND flags=ARRAY['missing_transfer_history','unsupported_swap_signs'])
  )
);
CREATE INDEX broad_swaps_pool_history ON broad_swaps(chain_id,pool_id,block_number,log_index);
COMMENT ON TABLE broad_swaps IS 'Swaps-only activity. No verified inventory, beneficiary, basis or PnL. Retain range evidence indefinitely.';
COMMENT ON COLUMN broad_swaps.transaction_sender IS 'Transaction initiator, never a proven beneficiary.';

-- Losing a dependency invalidates the complete broad suffix, including empty
-- ranges. This runs inside discovery rewind's transaction, including FK cascades.
CREATE FUNCTION invalidate_broad_suffix() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE last_batch record;
BEGIN
  PERFORM 1 FROM indexer_streams WHERE chain_id=OLD.chain_id AND stream_key=OLD.stream_key FOR UPDATE;
  DELETE FROM indexer_batches WHERE chain_id=OLD.chain_id AND stream_key=OLD.stream_key AND to_block>=OLD.batch_end;
  SELECT to_block,block_hash INTO last_batch FROM indexer_batches
    WHERE chain_id=OLD.chain_id AND stream_key=OLD.stream_key ORDER BY to_block DESC LIMIT 1;
  IF FOUND THEN
    UPDATE indexer_streams SET cursor_block=last_batch.to_block,cursor_hash=last_batch.block_hash,updated_at=clock_timestamp()
      WHERE chain_id=OLD.chain_id AND stream_key=OLD.stream_key;
  ELSE
    UPDATE indexer_streams SET cursor_block=NULL,cursor_hash=NULL,updated_at=clock_timestamp()
      WHERE chain_id=OLD.chain_id AND stream_key=OLD.stream_key;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER broad_dependency_removed AFTER DELETE ON broad_batches
  FOR EACH ROW EXECUTE FUNCTION invalidate_broad_suffix();
