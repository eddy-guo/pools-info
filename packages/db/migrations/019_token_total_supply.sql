-- A token's measured total supply, for FDV beside the aggregate ledger's
-- price (docs/LEDGER-MARKET-SERVING.md): totalSupply() read through Multicall3
-- on the public RPC, in raw token units, with the block it was read at, both
-- null until the read has run. Nullable additions only, so nothing that reads
-- indexed_pools today changes. The columns are IF NOT EXISTS because the
-- supply read is separate work that may add them first.
ALTER TABLE indexed_pools
  ADD COLUMN IF NOT EXISTS token_total_supply_raw numeric
    CHECK (token_total_supply_raw>=0 AND scale(token_total_supply_raw)=0),
  ADD COLUMN IF NOT EXISTS token_supply_block bigint CHECK (token_supply_block>=0);
ALTER TABLE indexed_pools ADD CONSTRAINT indexed_pools_token_supply_read
  CHECK ((token_total_supply_raw IS NULL)=(token_supply_block IS NULL));
