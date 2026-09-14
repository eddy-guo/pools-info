-- Bounded read API access paths. Keep the original evidence schema intact.
CREATE INDEX indexed_events_global_trades
  ON indexed_events(chain_id, block_number DESC, log_index DESC, tx_hash DESC, stream_key DESC)
  WHERE kind = 'swap';
CREATE INDEX indexed_events_transfer_from
  ON indexed_events(chain_id, (payload->>'from'), block_number DESC, log_index DESC)
  WHERE kind = 'transfer';
CREATE INDEX indexed_events_transfer_to
  ON indexed_events(chain_id, (payload->>'to'), block_number DESC, log_index DESC)
  WHERE kind = 'transfer';
CREATE INDEX indexer_streams_pool_lookup
  ON indexer_streams(chain_id, pool_id) WHERE kind = 'pool';
