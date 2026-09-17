-- The aggregate ledger's tip loop (docs/AGGREGATE-LEDGER.md, phase 3).
-- Nullable additions and one new table: nothing written before changes, and
-- a row restored from a dump taken before this migration reads as "not
-- folded" rather than as a zero.

-- Closed-cycle hold time, folded when a sale closes an inventory cycle
-- (decided 17 Sep 2026): how many cycles a position closed, how many of them
-- were held under 60 seconds and the shortest. A position written before this
-- migration may already hold closures whose hold time was never folded, so
-- its columns stay null until the history backfill fills them; a position the
-- writer creates from here on starts at zero.
ALTER TABLE agg_positions
  ADD COLUMN closed_cycles integer CHECK (closed_cycles>=0),
  ADD COLUMN flash_cycles integer CHECK (flash_cycles>=0 AND flash_cycles<=closed_cycles),
  ADD COLUMN shortest_cycle_seconds bigint CHECK (shortest_cycle_seconds>=0),
  ADD CONSTRAINT agg_positions_cycle_times CHECK (
    (closed_cycles IS NULL) = (flash_cycles IS NULL)
    AND (shortest_cycle_seconds IS NULL) = (closed_cycles IS NULL OR closed_cycles=0)
    AND (flash_cycles IS NULL OR flash_cycles=0 OR shortest_cycle_seconds<60));

-- The same count per wallet, pool and hour, so a window can say which share
-- of its closures were held under 60 seconds. Null on an hour row written
-- before this migration; an hour row created from here on starts at zero.
ALTER TABLE agg_wallet_hours
  ADD COLUMN flash_closures integer CHECK (flash_closures>=0 AND flash_closures<=closures);

-- A window's flash closures are null while any of its closures sits in an
-- hour row without the count. The partial index serves the top of the board:
-- the eligible wallets (at least 10 supported trades on a supported position)
-- in realized order.
ALTER TABLE agg_wallet_windows
  ADD COLUMN flash_closures integer CHECK (flash_closures>=0 AND flash_closures<=closures);
CREATE INDEX agg_wallet_windows_realized ON agg_wallet_windows (chain_id, "window", realized_wei DESC)
  WHERE supported_trades>=10 AND supported_positions>0;

-- The number of journal rows a batch wrote. Walk-back undoes a batch only
-- when its journal is whole: a batch committed before this migration (null),
-- or one whose journal was pruned or not restored with a dump, is refused
-- instead of silently leaving its changes in place.
ALTER TABLE agg_batches ADD COLUMN journal_rows integer CHECK (journal_rows>=0);

-- One row per window: the ledger cursor the window's rows reflect. A walk-back
-- that removes that batch removes this row with it, and the next refresh
-- rebuilds the window from the hour rows.
CREATE TABLE agg_window_refreshes (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  stream_key text NOT NULL CHECK (stream_key='ledger:agg:v1'),
  "window" text NOT NULL CHECK ("window" IN ('1h','6h','24h','7d','30d','All')),
  through_block bigint NOT NULL,
  through_timestamp bigint NOT NULL CHECK (through_timestamp>=0),
  window_start integer NOT NULL CHECK (window_start>=0),
  wallets integer NOT NULL CHECK (wallets>=0),
  ranked integer NOT NULL CHECK (ranked>=0 AND ranked<=wallets),
  refreshed_at timestamptz NOT NULL,
  PRIMARY KEY (chain_id, "window"),
  FOREIGN KEY (chain_id, stream_key, through_block) REFERENCES agg_batches ON DELETE CASCADE
);

COMMENT ON COLUMN agg_positions.closed_cycles IS 'Inventory cycles closed by a sale since hold times are folded; null when the position predates that fold.';
COMMENT ON COLUMN agg_positions.flash_cycles IS 'Of closed_cycles, those held under 60 seconds.';
COMMENT ON COLUMN agg_positions.shortest_cycle_seconds IS 'The shortest of closed_cycles; null when none.';
COMMENT ON COLUMN agg_wallet_hours.flash_closures IS 'Of closures, those held under 60 seconds; null on a row written before hold times were folded.';
COMMENT ON TABLE agg_wallet_windows IS 'Wallet totals per window, summed from whole hours ending with the ledger cursor''s hour, refreshed by the tip loop. rank is the position among eligible wallets by realized (address breaks ties), kept for the top 100 only.';
COMMENT ON COLUMN agg_wallet_windows.window_start IS 'The first hour the row was last summed from; agg_window_refreshes.window_start is the window''s current start, and a row with an hour between the two is recomputed, so its sums are the current window''s.';
COMMENT ON TABLE agg_window_refreshes IS 'The cursor each window reflects; removed with its batch by a walk-back, which forces a rebuild.';
