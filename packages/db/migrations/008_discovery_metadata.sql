-- Keep the registry identity beside the cursor it defines. Legacy streams stay
-- unchanged; discovery:v2 inserts and verifies its own pinned identity.
ALTER TABLE indexer_streams
  ADD COLUMN registry_revision text,
  ADD COLUMN registry_source_revision text;

ALTER TABLE indexed_pools
  ADD COLUMN image_url text,
  ADD COLUMN description text,
  ADD COLUMN external_url text;
ALTER TABLE pool_launch_sources
  ADD COLUMN image_url text,
  ADD COLUMN description text,
  ADD COLUMN external_url text;

-- Store the decoded tuple with each observation, not just its cached pool row.
-- A rollback to a legacy observation must also remove unsupported metadata.
CREATE OR REPLACE FUNCTION record_pool_launch_source() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pool_launch_sources
    (chain_id,pool_id,stream_key,batch_end,image_url,description,external_url)
    VALUES (NEW.chain_id,NEW.pool_id,NEW.source_stream,NEW.source_batch,
      NEW.image_url,NEW.description,NEW.external_url);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION reconcile_pool_launch_source() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  replacement record;
  affected_chain integer;
  affected_pool text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_chain := OLD.chain_id;
    affected_pool := OLD.pool_id;
  ELSE
    affected_chain := NEW.chain_id;
    affected_pool := NEW.pool_id;
  END IF;
  PERFORM 1 FROM indexed_pools
    WHERE chain_id=affected_chain AND pool_id=affected_pool FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT stream_key,batch_end,image_url,description,external_url
    INTO replacement FROM pool_launch_sources
    WHERE chain_id=affected_chain AND pool_id=affected_pool
    ORDER BY (image_url IS NOT NULL OR description IS NOT NULL OR external_url IS NOT NULL) DESC,
      stream_key,batch_end LIMIT 1;
  IF FOUND THEN
    UPDATE indexed_pools SET source_stream=replacement.stream_key,
      source_batch=replacement.batch_end, image_url=replacement.image_url,
      description=replacement.description, external_url=replacement.external_url
      WHERE chain_id=affected_chain AND pool_id=affected_pool;
  ELSE
    DELETE FROM indexer_streams WHERE chain_id=affected_chain
      AND kind='pool' AND pool_id=affected_pool;
    DELETE FROM indexed_pools WHERE chain_id=affected_chain AND pool_id=affected_pool;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER pool_launch_source_metadata_added
AFTER INSERT OR UPDATE OF image_url,description,external_url ON pool_launch_sources
FOR EACH ROW EXECUTE FUNCTION reconcile_pool_launch_source();
