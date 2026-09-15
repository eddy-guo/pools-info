-- A verified launch can be observed by historical discovery and a bounded
-- candidate scan. Keep all sources so rewinding either scan is well defined.
-- Serialize the backfill against an old worker finishing its current batch.
LOCK TABLE indexer_streams,indexer_batches,indexed_pools IN ACCESS EXCLUSIVE MODE;
CREATE TABLE pool_launch_sources (
  chain_id integer NOT NULL,
  pool_id text NOT NULL,
  stream_key text NOT NULL,
  batch_end bigint NOT NULL,
  PRIMARY KEY (chain_id, pool_id, stream_key, batch_end),
  FOREIGN KEY (chain_id, pool_id) REFERENCES indexed_pools ON DELETE CASCADE,
  FOREIGN KEY (chain_id, stream_key, batch_end)
    REFERENCES indexer_batches(chain_id, stream_key, to_block) ON DELETE CASCADE
);
CREATE INDEX pool_launch_sources_batch
  ON pool_launch_sources(chain_id, stream_key, batch_end);

INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end)
SELECT chain_id,pool_id,source_stream,source_batch FROM indexed_pools;

-- A rolling deployment can briefly retain old writer code after migration.
-- Seed its first source automatically as well as for new code and SQL fixtures.
CREATE FUNCTION record_pool_launch_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end)
    VALUES (NEW.chain_id,NEW.pool_id,NEW.source_stream,NEW.source_batch);
  RETURN NEW;
END;
$$;
CREATE TRIGGER pool_launch_source_created
AFTER INSERT ON indexed_pools
FOR EACH ROW EXECUTE FUNCTION record_pool_launch_source();

-- Legacy columns remain a representative source for existing read queries.
-- Their lifetime is now maintained from the complete set of observations.
ALTER TABLE indexed_pools
  DROP CONSTRAINT indexed_pools_chain_id_source_stream_source_batch_fkey;

CREATE FUNCTION reconcile_pool_launch_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE replacement record;
BEGIN
  PERFORM 1 FROM indexed_pools
    WHERE chain_id=OLD.chain_id AND pool_id=OLD.pool_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stream_key,batch_end INTO replacement FROM pool_launch_sources
    WHERE chain_id=OLD.chain_id AND pool_id=OLD.pool_id
    ORDER BY stream_key,batch_end LIMIT 1;
  IF FOUND THEN
    UPDATE indexed_pools SET source_stream=replacement.stream_key,
      source_batch=replacement.batch_end
      WHERE chain_id=OLD.chain_id AND pool_id=OLD.pool_id;
  ELSE
    -- Pool streams own event batches; deleting them also invalidates accounting.
    DELETE FROM indexer_streams WHERE chain_id=OLD.chain_id
      AND kind='pool' AND pool_id=OLD.pool_id;
    DELETE FROM indexed_pools WHERE chain_id=OLD.chain_id AND pool_id=OLD.pool_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pool_launch_source_removed
AFTER DELETE ON pool_launch_sources
FOR EACH ROW EXECUTE FUNCTION reconcile_pool_launch_source();
