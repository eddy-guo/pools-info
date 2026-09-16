-- Rebuildable serving inputs. Evidence and deep accounting remain untouched.
-- One-second buckets preserve exact window boundaries, including multiple blocks
-- sharing a timestamp. Each bounded canonical batch owns its aggregate rows.
CREATE TABLE broad_market_batches (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  PRIMARY KEY(chain_id,stream_key,batch_end),
  FOREIGN KEY(chain_id,stream_key,batch_end) REFERENCES broad_batches ON DELETE CASCADE
);
CREATE TABLE broad_market_buckets (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  pool_id text NOT NULL,
  timestamp bigint NOT NULL CHECK(timestamp>=0),
  trades bigint NOT NULL CHECK(trades>0),
  unsupported bigint NOT NULL CHECK(unsupported BETWEEN 0 AND trades),
  volume_wei numeric NOT NULL CHECK(scale(volume_wei)=0 AND volume_wei>=0),
  first_block bigint NOT NULL,
  first_log integer NOT NULL,
  first_tx text NOT NULL,
  first_hash text NOT NULL,
  first_price_supported boolean NOT NULL,
  first_sqrt numeric NOT NULL CHECK(scale(first_sqrt)=0 AND first_sqrt>=0),
  last_block bigint NOT NULL,
  last_log integer NOT NULL,
  last_tx text NOT NULL,
  last_hash text NOT NULL,
  last_price_supported boolean NOT NULL,
  last_sqrt numeric NOT NULL CHECK(scale(last_sqrt)=0 AND last_sqrt>=0),
  PRIMARY KEY(chain_id,stream_key,batch_end,pool_id,timestamp),
  FOREIGN KEY(chain_id,stream_key,batch_end) REFERENCES broad_market_batches ON DELETE CASCADE
);
CREATE INDEX broad_market_window ON broad_market_buckets(chain_id,timestamp,pool_id,batch_end)
  INCLUDE(trades,unsupported,volume_wei);
CREATE INDEX broad_market_pool_price ON broad_market_buckets(chain_id,pool_id,timestamp DESC,last_block DESC,last_log DESC,last_tx DESC)
  INCLUDE(batch_end,first_sqrt,last_sqrt,first_price_supported,last_price_supported,first_block,first_log,first_tx);
CREATE INDEX broad_swaps_batch_projection ON broad_swaps(chain_id,stream_key,batch_end);

CREATE TABLE broad_market_summaries (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  pool_id text NOT NULL,
  first_timestamp bigint NOT NULL,
  last_timestamp bigint NOT NULL CHECK(last_timestamp>=first_timestamp),
  trades bigint NOT NULL CHECK(trades>0),
  unsupported bigint NOT NULL CHECK(unsupported BETWEEN 0 AND trades),
  volume_wei numeric NOT NULL CHECK(scale(volume_wei)=0 AND volume_wei>=0),
  PRIMARY KEY(chain_id,stream_key,batch_end,pool_id),
  FOREIGN KEY(chain_id,stream_key,batch_end) REFERENCES broad_market_batches ON DELETE CASCADE
);
CREATE INDEX broad_market_summary_window ON broad_market_summaries(chain_id,first_timestamp,pool_id,batch_end)
  INCLUDE(last_timestamp,trades,unsupported,volume_wei);

CREATE FUNCTION project_broad_market(p_end bigint) RETURNS void LANGUAGE plpgsql AS $$
DECLARE expected bigint; actual bigint; unsupported_count bigint; expected_unsupported bigint;
BEGIN
  -- Call under the broad stream lock in the writer/rebuild transaction.
  SELECT observed_swaps-unregistered_swaps,unsupported_swaps INTO expected,expected_unsupported FROM broad_batches
    WHERE chain_id=4663 AND stream_key='swaps:broad:v1' AND batch_end=p_end FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing canonical broad batch'; END IF;
  SELECT count(*),count(*) FILTER(WHERE side IS NULL) INTO actual,unsupported_count FROM broad_swaps
    WHERE chain_id=4663 AND stream_key='swaps:broad:v1' AND batch_end=p_end;
  IF EXISTS(SELECT 1 FROM broad_batches b JOIN indexer_batches d
    ON d.chain_id=b.chain_id AND d.stream_key=b.discovery_stream AND d.to_block=b.discovery_batch
    WHERE b.chain_id=4663 AND b.batch_end=p_end AND
      (b.discovery_hash<>d.block_hash OR b.discovery_content_hash<>d.content_hash))
    THEN RAISE EXCEPTION 'Invalid canonical broad discovery dependency'; END IF;
  IF actual<>expected OR unsupported_count<>expected_unsupported THEN RAISE EXCEPTION 'Incomplete canonical broad inputs'; END IF;
  IF EXISTS(SELECT 1 FROM broad_swaps s JOIN broad_batches b USING(chain_id,stream_key,batch_end)
    JOIN indexed_pools p ON p.chain_id=s.chain_id AND p.pool_id=s.pool_id
    WHERE s.chain_id=4663 AND s.batch_end=p_end AND (s.block_number NOT BETWEEN b.from_block AND b.batch_end
      OR s.timestamp>b.timestamp OR s.timestamp<p.launched_at OR s.token<>p.token
      OR s.block_number=p_end AND s.block_hash<>(SELECT block_hash FROM indexer_batches i
        WHERE i.chain_id=s.chain_id AND i.stream_key=s.stream_key AND i.to_block=s.batch_end)))
    THEN RAISE EXCEPTION 'Invalid canonical broad market provenance'; END IF;
  DELETE FROM broad_market_batches WHERE chain_id=4663 AND stream_key='swaps:broad:v1' AND batch_end=p_end;
  INSERT INTO broad_market_batches VALUES(4663,'swaps:broad:v1',p_end,1);
  INSERT INTO broad_market_buckets
  SELECT chain_id,stream_key,batch_end,pool_id,timestamp,count(*),count(*) FILTER(WHERE side IS NULL),
    coalesce(sum(eth_wei),0),
    (array_agg(block_number ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(log_index ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(tx_hash ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(block_hash ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(side IS NOT NULL AND sqrt_price_x96>0 ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(sqrt_price_x96 ORDER BY block_number,log_index,tx_hash))[1],
    (array_agg(block_number ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    (array_agg(log_index ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    (array_agg(tx_hash ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    (array_agg(block_hash ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    (array_agg(side IS NOT NULL AND sqrt_price_x96>0 ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    (array_agg(sqrt_price_x96 ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1]
  FROM broad_swaps WHERE chain_id=4663 AND stream_key='swaps:broad:v1' AND batch_end=p_end
  GROUP BY chain_id,stream_key,batch_end,pool_id,timestamp;
  INSERT INTO broad_market_summaries
    SELECT chain_id,stream_key,batch_end,pool_id,min(timestamp),max(timestamp),sum(trades),sum(unsupported),sum(volume_wei)
    FROM broad_market_buckets WHERE chain_id=4663 AND batch_end=p_end GROUP BY chain_id,stream_key,batch_end,pool_id;
  DELETE FROM broad_market_conflicts WHERE chain_id=4663 AND batch_end=p_end;
  DELETE FROM broad_market_recent_conflicts WHERE chain_id=4663 AND batch_end=p_end;
  PERFORM project_broad_market_conflicts(p_end);
  PERFORM project_broad_market_recent_conflicts(p_end);
END; $$;
COMMENT ON TABLE broad_market_buckets IS 'Derived canonical broad activity only. Never add deep or recent copies to these totals. Raw sqrt price states use separately dated token units. Deleting a source batch cascades; historical inputs require bounded rebuild.';

-- Cache contradictory canonical deep copies at write/rebuild time. Identity
-- checks do not require scanning deep JSON on each global page request.
CREATE TABLE broad_market_conflicts (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  copy_stream text NOT NULL,
  copy_batch bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY(chain_id,stream_key,batch_end,copy_stream,copy_batch,tx_hash,log_index),
  FOREIGN KEY(chain_id,stream_key,batch_end) REFERENCES broad_batches ON DELETE CASCADE,
  FOREIGN KEY(chain_id,copy_stream,copy_batch) REFERENCES indexer_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE FUNCTION market_copy_conflicts(e indexed_events,b broad_swaps) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT ROW(e.pool_id,e.token,e.block_number,e.block_hash,e.timestamp)
    IS DISTINCT FROM ROW(b.pool_id,b.token,b.block_number,b.block_hash,b.timestamp)
    OR (e.payload->'decoded'->>'amount0' IS NOT NULL AND e.payload->'decoded'->>'amount0' IS DISTINCT FROM b.amount0::text)
    OR (e.payload->'decoded'->>'amount1' IS NOT NULL AND e.payload->'decoded'->>'amount1' IS DISTINCT FROM b.amount1::text)
    OR (e.payload->'decoded'->>'sqrtPriceX96' IS NOT NULL AND e.payload->'decoded'->>'sqrtPriceX96' IS DISTINCT FROM b.sqrt_price_x96::text)
    OR (e.payload->'decoded'->>'side' IS NOT NULL AND e.payload->'decoded'->>'side' IS DISTINCT FROM b.side)
    OR (e.payload->'decoded'->>'ethWei' IS NOT NULL AND e.payload->'decoded'->>'ethWei' IS DISTINCT FROM b.eth_wei::text);
$$;
CREATE FUNCTION refresh_market_copy_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    DELETE FROM broad_market_conflicts WHERE chain_id=OLD.chain_id AND copy_stream=OLD.stream_key
      AND tx_hash=OLD.tx_hash AND log_index=OLD.log_index;
  END IF;
  IF NEW.kind='swap' THEN
    INSERT INTO broad_market_conflicts
      SELECT b.chain_id,b.stream_key,b.batch_end,NEW.stream_key,NEW.batch_end,NEW.tx_hash,NEW.log_index
      FROM broad_swaps b WHERE b.chain_id=NEW.chain_id AND b.tx_hash=NEW.tx_hash AND b.log_index=NEW.log_index
        AND market_copy_conflicts(NEW,b);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER market_deep_copy AFTER INSERT OR UPDATE ON indexed_events
  FOR EACH ROW EXECUTE FUNCTION refresh_market_copy_conflict();
-- Delete individual copies as well as whole deep batches.
CREATE FUNCTION remove_market_copy_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM broad_market_conflicts WHERE chain_id=OLD.chain_id AND copy_stream=OLD.stream_key
    AND tx_hash=OLD.tx_hash AND log_index=OLD.log_index;
  RETURN NULL;
END; $$;
CREATE TRIGGER market_deep_copy_removed AFTER DELETE ON indexed_events
  FOR EACH ROW EXECUTE FUNCTION remove_market_copy_conflict();
CREATE FUNCTION project_broad_market_conflicts(p_end bigint) RETURNS void LANGUAGE sql AS $$
  INSERT INTO broad_market_conflicts
    SELECT b.chain_id,b.stream_key,b.batch_end,e.stream_key,e.batch_end,b.tx_hash,b.log_index
    FROM broad_swaps b JOIN indexed_events e ON e.chain_id=b.chain_id AND e.tx_hash=b.tx_hash AND e.log_index=b.log_index AND e.kind='swap'
    WHERE b.chain_id=4663 AND b.batch_end=p_end AND market_copy_conflicts(e,b)
    ON CONFLICT DO NOTHING;
$$;
CREATE TABLE broad_market_recent_conflicts (
  chain_id integer NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  copy_stream text NOT NULL,
  copy_batch bigint NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  PRIMARY KEY(chain_id,stream_key,batch_end,copy_stream,copy_batch,tx_hash,log_index),
  FOREIGN KEY(chain_id,stream_key,batch_end) REFERENCES broad_batches ON DELETE CASCADE,
  FOREIGN KEY(chain_id,copy_stream,copy_batch) REFERENCES recent_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE FUNCTION market_recent_conflicts(e recent_swaps,b broad_swaps) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT ROW(e.pool_id,e.token,e.block_number,e.block_hash,e.timestamp)
    IS DISTINCT FROM ROW(b.pool_id,b.token,b.block_number,b.block_hash,b.timestamp)
    OR ROW(e.amount0,e.amount1,e.side,e.eth_wei)
      IS DISTINCT FROM ROW(b.amount0::text,b.amount1::text,b.side,b.eth_wei::text);
$$;
CREATE FUNCTION refresh_market_recent_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP<>'INSERT' THEN
    DELETE FROM broad_market_recent_conflicts WHERE chain_id=OLD.chain_id AND copy_stream=OLD.source_stream
      AND tx_hash=OLD.tx_hash AND log_index=OLD.log_index;
  END IF;
  IF TG_OP<>'DELETE' THEN
    INSERT INTO broad_market_recent_conflicts
      SELECT b.chain_id,b.stream_key,b.batch_end,NEW.source_stream,NEW.batch_end,NEW.tx_hash,NEW.log_index
      FROM broad_swaps b WHERE b.chain_id=NEW.chain_id AND b.tx_hash=NEW.tx_hash AND b.log_index=NEW.log_index
        AND market_recent_conflicts(NEW,b);
  END IF;
  RETURN NULL;
END; $$;
CREATE TRIGGER market_recent_copy AFTER INSERT OR UPDATE OR DELETE ON recent_swaps
  FOR EACH ROW EXECUTE FUNCTION refresh_market_recent_conflict();
CREATE FUNCTION project_broad_market_recent_conflicts(p_end bigint) RETURNS void LANGUAGE sql AS $$
  INSERT INTO broad_market_recent_conflicts
    SELECT b.chain_id,b.stream_key,b.batch_end,e.source_stream,e.batch_end,b.tx_hash,b.log_index
    FROM broad_swaps b JOIN recent_swaps e ON e.chain_id=b.chain_id AND e.tx_hash=b.tx_hash AND e.log_index=b.log_index
    WHERE b.chain_id=4663 AND b.batch_end=p_end AND market_recent_conflicts(e,b)
    ON CONFLICT DO NOTHING;
$$;
