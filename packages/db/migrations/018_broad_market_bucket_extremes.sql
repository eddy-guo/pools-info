-- The pool page's candles from the rollups (docs/BROAD-MARKET-SERVING.md,
-- "Pool page from the rollups"). Blocks on this chain share timestamps, so a
-- one-second bucket often holds several swaps and its first/last sqrt price
-- cannot give a minute's high and low. The extremes over every swap in the
-- bucket can: the display price is monotonic in the sqrt price, so a minute's
-- highest price is the price of its lowest sqrt and vice versa. Derived data
-- only: the backfill recomputes every retained bucket from broad_swaps in this
-- transaction and the projection fills the columns for every later batch.
-- Evidence, broad_swaps, summaries, conflicts and deep accounting are untouched.
ALTER TABLE broad_market_buckets
  ADD COLUMN min_sqrt numeric,
  ADD COLUMN max_sqrt numeric;
UPDATE broad_market_buckets k SET min_sqrt=x.min_sqrt,max_sqrt=x.max_sqrt
  FROM (SELECT chain_id,stream_key,batch_end,pool_id,timestamp,min(sqrt_price_x96) AS min_sqrt,max(sqrt_price_x96) AS max_sqrt
    FROM broad_swaps GROUP BY chain_id,stream_key,batch_end,pool_id,timestamp) x
  WHERE k.chain_id=x.chain_id AND k.stream_key=x.stream_key AND k.batch_end=x.batch_end
    AND k.pool_id=x.pool_id AND k.timestamp=x.timestamp;
ALTER TABLE broad_market_buckets
  ALTER COLUMN min_sqrt SET NOT NULL,
  ALTER COLUMN max_sqrt SET NOT NULL,
  ADD CONSTRAINT broad_market_buckets_sqrt_extremes CHECK (
    scale(min_sqrt)=0 AND scale(max_sqrt)=0 AND min_sqrt>=0 AND min_sqrt<=max_sqrt
    AND first_sqrt BETWEEN min_sqrt AND max_sqrt AND last_sqrt BETWEEN min_sqrt AND max_sqrt);

-- Same projection as migration 012 with the two extremes; the column list is
-- explicit so a later column cannot shift a positional insert.
CREATE OR REPLACE FUNCTION project_broad_market(p_end bigint) RETURNS void LANGUAGE plpgsql AS $$
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
  INSERT INTO broad_market_buckets(chain_id,stream_key,batch_end,pool_id,timestamp,trades,unsupported,volume_wei,
    first_block,first_log,first_tx,first_hash,first_price_supported,first_sqrt,
    last_block,last_log,last_tx,last_hash,last_price_supported,last_sqrt,min_sqrt,max_sqrt)
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
    (array_agg(sqrt_price_x96 ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1],
    min(sqrt_price_x96),max(sqrt_price_x96)
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
-- The pool page folds a pool's buckets by minute. Without statistics on the
-- expression the planner takes a minute per bucket, expects a hash table
-- past work_mem and sorts every bucket instead, on disk for a sparse pool;
-- with them it hashes, so the fold's memory is the pool's minutes. The
-- analyze here gives the rewritten rows fresh statistics at once instead of
-- after the next autoanalyze.
CREATE STATISTICS broad_market_bucket_minutes ON (timestamp/60) FROM broad_market_buckets;
ANALYZE broad_market_buckets;
COMMENT ON COLUMN broad_market_buckets.min_sqrt IS 'Lowest raw sqrt price over every swap in the second, supported or not; the minute high on the pool page. Never a normalized price on its own.';
COMMENT ON COLUMN broad_market_buckets.max_sqrt IS 'Highest raw sqrt price over every swap in the second, supported or not; the minute low on the pool page. Never a normalized price on its own.';
