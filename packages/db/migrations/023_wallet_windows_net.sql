-- The trader board's net order (`metric=net`, apps/api/src/ledger-leaderboard.ts)
-- read the window's whole eligible set through the realized index and sorted
-- it by net: 5,252 rows and about 6,700 pages for 7d, 22,287 and 8,700 for
-- 30d, 77,522 and 18,800 with two parallel workers for All on the 27 Sep 2026
-- production backup. Uncached, that is a random heap read per page, and
-- production answered 7d and 30d net in 0.7-1.7 s once the tip loop's writes
-- had pushed those pages out of a smaller cache, against 148-187 ms warm. The
-- same partial predicate as the realized index, so the board's eligible
-- wallets are read in net order and the page stops at its last row: about
-- 500 pages on every window, 4 MB on that backup.
CREATE INDEX agg_wallet_windows_net ON agg_wallet_windows (chain_id, "window", net_wei DESC)
  WHERE supported_trades>=10 AND supported_positions>0;
