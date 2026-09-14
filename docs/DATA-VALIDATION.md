# Data validation and coverage

Audit: 14 September 2026, approximately 18:35 UTC. These are point-in-time
observations, not a live status page.

## What was checked

- Railway continued saving successful discovery, swap and transfer batches.
- Alchemy reported 0% throughput-limited requests and 99.3% success over the
  preceding hour. The usage warning refers to a historical peak of 450 CU/s
  against a 300 CU/s limit. Monthly usage was 757.2K of 30M CUs.
- Recent failed request logs were HTTP 400 / JSON-RPC -32600: the free plan
  permits only ten blocks per eth_getLogs request. The adapter was repeatedly
  probing a larger range before adapting. The worker now initializes that
  known range via INDEXER_LOG_RANGE_BLOCKS, default 10.
- Chain head read directly from RPC: 63024450, timestamp 18:35:38 UTC. An observed
  discovery checkpoint was 62652934, timestamp 08:05:57 UTC. This demonstrates
  roughly ten and a half hours of historical lag, not near-head coverage.
  Each pool has its own event checkpoint; discovery progress does not establish
  trade-history completeness.
- The current sequential discovery/backfill loop was advancing discovery by
  about 1,000 blocks per 150 seconds in several observed cycles. The chain was
  producing blocks faster. Running this pilot longer is not a catch-up strategy.

The usage dashboard is https://dashboard.alchemy.com/usage. Request errors are
at https://dashboard.alchemy.com/apps/4wcnkim4si1oybsp/logs/requests.

## PnL verification

23 accounting, wallet-metric and receipt-attribution tests passed. Independent
average-cost example: buy 100 tokens for 1 ETH, then 100 for 3 ETH. Selling 50
for 1.5 ETH consumes 1 ETH of basis, realizes +0.5 ETH and leaves 150 tokens
with 3 ETH basis.

An independent recomputation of the committed snapshot at block 62666406
matched all 18 supported wallet/pool positions; 19 positions remained excluded.
A fully closed sample also reconciled directly as sale proceeds minus purchase
spending: -0.000314690450473335 ETH. No arithmetic mismatch was found.

This is PnL from supported pool swap amounts, excluding gas and separate
router/application charges. It is not proof of a wallet's total net profit.
Unknown transfers, unsupported routes and inconsistent inventory remain
exclusions. Unrealized marks use the captured audit price, which can lag the
current market feed.

The website's accounting is still computed from saved snapshots or an on-demand
RPC audit. The new Postgres events do not yet feed accounting. The current
leaderboard is per pool, not a completed cross-pool trader ranking.

## Repeatable sanity checks

1. **Membership:** match the token's launch transaction, emitting strategy,
   chain 4663, token address and derived pool ID. A name or symbol match proves
   nothing. The current registry has two Instant strategies, excludes Crowd and
   starts at block 62625935. See INDEXING-SCOPE.md before claiming every launch.
2. **Trades:** select one buy and sell in a completed database batch. Compare
   transaction hash, log index, block hash, emitting PoolManager, pool ID and
   raw amount0/amount1 against the transaction receipt. Token transfers must
   reconcile with the audited trader, not simply transaction_sender. Store
   and compare integers before applying token decimals.
3. **Coverage:** compare like-for-like block cutoffs. A recent indexed_at time
   can describe old blocks. Check discovery and each pool's own cursor and
   canonical hash. A chart from Pools at the current block cannot directly
   validate a historical snapshot's current price or volume.
4. **Holders:** once implemented, replay complete token-birth Transfer history
   to a fixed block and reconcile sample balances and totalSupply at that same
   block. Zero gaps and supply reconciliation are required; neither proves
   wallet cost basis on its own.
5. **PnL:** choose a simple wallet with only supported buys and sells and no
   transfers. Work through average cost chronologically. A fully closed
   position must equal proceeds minus purchase cost under the stated fee policy.
   For a rolling window, include earlier buys when calculating sale cost basis.

Read-only SQL for a Railway private connection or tunnel:

```sql
-- Stored event counts. These are not counts of attributed trader positions.
SELECT kind, count(*) FROM indexed_events GROUP BY kind;

-- Coverage and freshness are separate dimensions.
SELECT s.stream_key, p.symbol, p.token, s.start_block, s.cursor_block,
       s.cursor_hash, s.updated_at
FROM indexer_streams s
LEFT JOIN indexed_pools p
  ON p.chain_id = s.chain_id AND p.pool_id = s.pool_id
ORDER BY s.kind, s.cursor_block NULLS FIRST;

-- Select exact receipt/log identities for a manual comparison.
SELECT pool_id, token, kind, tx_hash, log_index, block_number, block_hash,
       payload
FROM indexed_events
ORDER BY block_number, log_index
LIMIT 20;

-- Expected zero rows: gaps between committed batches within a stream.
WITH ranges AS (
  SELECT chain_id, stream_key, from_block, to_block,
         lag(to_block) OVER (
           PARTITION BY chain_id, stream_key ORDER BY from_block
         ) AS preceding_end
  FROM indexer_batches
)
SELECT * FROM ranges
WHERE preceding_end IS NOT NULL AND from_block <> preceding_end + 1;
```

Run `pnpm test` for deterministic chain/accounting checks. `pnpm test:db`
requires a separate TEST_DATABASE_URL and must never point to production.
The SQL above helps inspect stored evidence; it does not independently prove
that our provider returned every relevant on-chain event.

## Next implementation priorities

1. Share log scans and receipt/header enrichment across pools. Add a provider
   usage budget covering backfill and fresh data together. Batching HTTP
   requests alone does not reduce billable RPC calls.
2. Give following new blocks a separate schedule from historical backfill.
   Publish explicit lag and coverage for both.
3. Verify/version all Pools deployment paths and activation blocks, including
   Crowd, and implement backward coverage without resetting existing cursors.
4. Derive holder snapshots and audited average-cost positions from database
   evidence, then connect a read service to the website and its cross-pool
   leaderboard. Keep production Postgres private.

Design work can proceed in parallel throughout. Real loading, unavailable-data
and partial-coverage states should remain visible instead of invented metrics.
