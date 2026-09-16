-- One eth_getCode observation per transaction sender, shared by every pool the
-- sender traded, instead of one read per pool projection. Rows record exactly
-- what the provider returned at observed_block; the analytics reader decides
-- when that observation may answer a question about another block and when a
-- fresh read is required (see cachedSenderCode in apps/indexer/src/analytics.ts).
CREATE TABLE sender_code_observations (
  chain_id integer NOT NULL CHECK (chain_id = 4663),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  code_hash text CHECK (code_hash IS NULL OR code_hash ~ '^0x[0-9a-f]{64}$'),
  observed_block bigint NOT NULL CHECK (observed_block >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);
COMMENT ON TABLE sender_code_observations IS 'eth_getCode observation for a transaction sender at observed_block: code_hash is keccak256 of the returned code, NULL means the reply was 0x (no code). A dated observation only; it never changes the accounting rule that a sender with code at a pool cutoff is a contract sender. No beneficiary or PnL fact.';
COMMENT ON COLUMN sender_code_observations.observed_block IS 'Block the code was read at. The newest observation replaces older ones for the same address.';
