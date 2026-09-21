-- Deliberately outside migrations/: only the attended, archive-bound entrypoint
-- applies this file. No existing financial row or journal pre-image changes.
ALTER TABLE agg_batches ADD COLUMN transfer_provenance_rows integer
  CHECK (transfer_provenance_rows >= 0);
-- NULL means not recorded, including batches written by an older binary.
-- Zero means the new writer checked the batch and found no selected legs.
CREATE TABLE agg_transfer_provenance (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='ledger:agg:v1'),
  batch_end bigint NOT NULL,
  pool_ref integer NOT NULL REFERENCES indexed_pools(pool_ref),
  tx_hash bytea NOT NULL CHECK (octet_length(tx_hash)=32),
  log_index integer NOT NULL CHECK (log_index>=0),
  block_number bigint NOT NULL CHECK (block_number>=0 AND block_number<=batch_end),
  block_hash bytea NOT NULL CHECK (octet_length(block_hash)=32),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  from_address bytea NOT NULL CHECK (octet_length(from_address)=20),
  to_address bytea NOT NULL CHECK (octet_length(to_address)=20),
  token_raw numeric NOT NULL CHECK (token_raw>=0 AND scale(token_raw)=0),
  context text NOT NULL CHECK (context IN ('residual','unattributed_swap')),
  classification_version smallint NOT NULL CHECK (classification_version=1),
  from_class text NOT NULL CHECK (from_class IN ('mint_burn','token_contract','launcher','wrapper_or_router','protocol','unregistered')),
  from_evidence text NOT NULL CHECK (length(from_evidence)>0),
  to_class text NOT NULL CHECK (to_class IN ('mint_burn','token_contract','launcher','wrapper_or_router','protocol','unregistered')),
  to_evidence text NOT NULL CHECK (length(to_evidence)>0),
  PRIMARY KEY (chain_id,tx_hash,log_index),
  FOREIGN KEY (chain_id,stream_key,batch_end) REFERENCES agg_batches(chain_id,stream_key,to_block) ON DELETE CASCADE
);
CREATE INDEX agg_transfer_provenance_batch ON agg_transfer_provenance(chain_id,stream_key,batch_end);
CREATE INDEX agg_transfer_provenance_from ON agg_transfer_provenance(chain_id,from_address,pool_ref);
CREATE INDEX agg_transfer_provenance_to ON agg_transfer_provenance(chain_id,to_address,pool_ref);
