-- Provenance of each recent batch's evidence, inspectable without parsing the
-- retained JSON: the receipt-shaped JSON-RPC collector or the transaction-shaped
-- HyperSync collector (docs/HYPERSYNC-TIP.md). Rows written before this column
-- existed were all collected over JSON-RPC. The evidence itself carries the same
-- label under `source` and `stream` for the HyperSync variant and is covered by
-- the batch's content hash. This is a label only: cursors, checkpoints, replay
-- and reorg rules are unchanged, and both variants share one stream.
ALTER TABLE recent_batches
  ADD COLUMN source text NOT NULL DEFAULT 'recent:rpc:v1'
  CHECK (source IN ('recent:rpc:v1','recent:hypersync:v1'));
COMMENT ON COLUMN recent_batches.source IS 'Evidence provenance: recent:rpc:v1 retains logs, receipts and headers from the JSON-RPC provider; recent:hypersync:v1 retains logs, transactions and blocks from Envio HyperSync. Same rows, same content hash rule, same stream.';
COMMENT ON TABLE recent_swaps IS 'Swaps only in DB-verified Pools markets, each backed by its batch evidence: a receipt (recent:rpc:v1) or a successful transaction row (recent:hypersync:v1). Transaction sender is the initiator, not the beneficiary. Never use recent-window records as complete PnL or holder history.';
