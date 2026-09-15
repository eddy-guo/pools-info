-- Dated ERC20 state observations, owned by the complete canonical broad range.
-- These never overwrite deep analytics units or imply token immutability.
CREATE INDEX indexed_events_canonical_swap_identity
  ON indexed_events(chain_id,tx_hash,log_index) WHERE kind='swap';
CREATE TABLE broad_token_units (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='swaps:broad:v1'),
  batch_end bigint NOT NULL,
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  block_number bigint NOT NULL CHECK (block_number=batch_end),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  timestamp bigint NOT NULL CHECK (timestamp>=0),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 255),
  total_supply numeric NOT NULL CHECK (scale(total_supply)=0 AND total_supply>=0 AND total_supply<115792089237316195423570985008687907853269984665640564039457584007913129639936),
  decimals_result text NOT NULL CHECK (decimals_result ~ '^0x[0-9a-fA-F]{64}$'),
  total_supply_result text NOT NULL CHECK (total_supply_result ~ '^0x[0-9a-fA-F]{64}$'),
  PRIMARY KEY (chain_id,stream_key,batch_end,token),
  FOREIGN KEY (chain_id,stream_key,batch_end)
    REFERENCES broad_batches ON DELETE CASCADE
);
CREATE INDEX broad_token_units_token_cutoff
  ON broad_token_units(chain_id,token,block_number DESC);
COMMENT ON TABLE broad_token_units IS 'Raw ABI state results at the exact canonical broad cutoff hash. Valid only as dated observations. Broad/discovery rewind removes their canonical read eligibility. No beneficiary or accounting facts.';
