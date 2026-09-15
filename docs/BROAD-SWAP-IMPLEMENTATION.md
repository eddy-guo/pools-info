# Broad swap implementation boundary

The broad collector is a foundation for Phase B, not active historical
coverage. Discovery v2 was explicitly approved and activated on Railway on
September 15; see [PHASE-A-RUN.md](PHASE-A-RUN.md). No broad worker, cursor or
serving projection is enabled by the collector alone.

## Collection

The broad mode of `collectPoolEventGroup` reads one PoolManager Swap range and
resolves the observed pool IDs against a pinned discovery v2 checkpoint. It
does not request token Transfer history. It retains one shared log, receipt and
header bundle for the range, including unregistered manager observations. A
capacity failure rejects the whole range so a future worker can split and
retry; it must never commit only the first pools that fit.

Broad rows preserve exact signed swap amounts and the manager's price-state
fields. They have `supported: false` and `missing_transfer_history`, with no
beneficiary, cost basis or PnL. Transaction initiators remain separate. The
existing deep collector continues to gather the evidence used for verified
positions and holders.

## Persistence still required

The existing schema does require an additive migration before broad
persistence. `indexer_streams.kind` currently supports discovery and deep pool
streams, and accounting trade rows belong to published deep snapshots. Adding
invented position rows or advancing deep cursors after swaps-only collection
would misrepresent the saved evidence.

The next increment should extend the existing group transaction boundary with:

- A distinct broad stream starting at block 22,754,669, with pinned registry
  and source revisions. V1 and every deep pool cursor remain intact.
- One retained, content-hashed batch per range and normalized broad swaps
  referencing it. Preserve `amount0`, `amount1`, `sqrtPriceX96`, liquidity, tick,
  fee, canonical identity, timestamps and explicit unsupported flags.
- One transaction that validates discovery coverage, saves every pool's rows
  and evidence, and advances the global cursor. Independent per-pool commits
  followed by a cursor update are insufficient.
- A dependency on a canonical discovery v2 checkpoint. The broad end cannot
  pass discovery coverage. Discovery rollback must invalidate dependent broad
  ranges and rewind their cursor atomically, not merely delete individual rows.
- Content-sensitive replay, checkpoint reconciliation and whole-range capacity
  handling, including empty ranges and a single block that exceeds bounds.

Run this within the main writer's ownership. The separately locked recent
worker continues to serve recent activity; its bootstrap cursor and compact
event shape are not a substitute for complete historical broad coverage.

## Serving still required

Add broad price, volume and trade-count reads for discovered pools, deduplicated
against deep and recent observations by canonical transaction/log identity.
Keep holder counts and verified PnL sourced from the deep tier, with their own
cutoffs. Manager liquidity is active liquidity, not an ETH total locked; the
price-state field alone must not be labeled as TVL.

No evidence pruning, archive provider or storage estimate is introduced here.
See [EVIDENCE-RETENTION.md](EVIDENCE-RETENTION.md) for the retained-evidence policy
and prerequisites for any later archive. Acceptance tests for persistence must
cover multi-pool atomic failure, exact/conflicting replay, source rollback,
late registry changes, shared evidence and unsupported finances before claiming
broad market coverage.
