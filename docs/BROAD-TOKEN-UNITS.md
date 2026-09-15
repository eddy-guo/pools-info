# Dated broad token units

The default-off broad worker explicitly collects units for distinct registered
tokens observed in each range. Legacy broad collector callers omit
`collectTokenUnits` and retain their original evidence shape. Discovery v2,
Phase A, deep accounting, and recent ingestion are unchanged.

## Canonical collection and cost

For each required token, the collector calls `decimals()` (`0x313ce567`) and
`totalSupply()` (`0x18160ddd`) at the exact range-end header, using EIP-1898
`{blockHash, requireCanonical: true}`. Both results must be exactly one ABI word.
Decimals must fit uint8; supply must fit uint256. A verified zero supply or zero
decimals is valid evidence. Missing, malformed, oversized, or reverted results
reject the whole range. No default decimals or synthetic zero supply is used.
Providers that do not support hash-pinned calls fail closed, with no
numeric-height fallback. Existing final header and worker precommit rechecks
cover the metadata calls too.

Tokens shared by multiple observed pools cost only two logical `eth_call`s per
range. Calls are batched within the existing 20-call evidence chunk, HTTP/time
limits, and retained-byte budget. Empty or wholly unregistered ranges make no
units calls. Each later observed range gets fresh observations: neither
decimals immutability nor supply stability is assumed. At the current planning
rate of 26 CU per `eth_call`, units add 52 CU per distinct observed token per
attempted range, before retries. Existing cutoff header checks are reused, not
duplicated. This cost is separate from the Phase A discovery budget; broad
method telemetry explicitly counts `eth_call` before transport retries.

## Persistence and read contract

Migration 011 adds `broad_token_units` with these columns:

| Column                                         | Meaning                                                           |
| ---------------------------------------------- | ----------------------------------------------------------------- |
| `chain_id`, `stream_key`, `batch_end`, `token` | Primary key; chain 4663, `swaps:broad:v1`, lowercase token        |
| `block_number`, `block_hash`, `timestamp`      | Exact canonical observation cutoff; block number equals batch end |
| `decimals`                                     | Verified uint8 value, including zero                              |
| `total_supply`                                 | Exact numeric integer from zero through uint256 maximum           |
| `decimals_result`, `total_supply_result`       | Retained raw 32-byte ABI results                                  |

The group's optional `tokenUnits` evidence retains token identity, cutoff,
decoded values, and raw results. Persistence reconstructs the entire collector
result from retained evidence, including ABI decoding and exact cutoff selectors,
before comparing content. Identical replay is a no-op; changed evidence rejects.
Units, swaps, discovery membership, batch evidence, and cursor commit in one
transaction. The units foreign key cascades from `broad_batches`; broad and
discovery rewinds invalidate dependent units with their complete range.

Read units only by exact chain/token/batch-end/cutoff-hash match against the
surviving broad batch and canonical indexer boundary. These observations prove
units at that cutoff only. Do not apply them to earlier swaps, reuse them at a
later cutoff, or infer token immutability. A dated chart point may pair the last
price state carried through contiguous broad coverage to that batch end with
units observed at the same cutoff. Missing observations mean unavailable
verified units, not 18 decimals or zero supply. A real zero supply can produce
zero or unsupported derived FDV according to serving policy. Market units do
not establish Transfer accounting, beneficiary positions, holders, or PnL.

Migration 011 also owns the partial canonical deep/recent swap identity index
on `indexed_events(chain_id, tx_hash, log_index) WHERE kind='swap'` for serving
deduplication. Evidence is retained indefinitely under
[EVIDENCE-RETENTION.md](EVIDENCE-RETENTION.md); no pruning is introduced.
