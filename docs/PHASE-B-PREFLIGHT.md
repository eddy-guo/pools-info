# Phase B workload preflight

Status: Task 2 measurement report, September 15, 2026. Broad code is merged into
main after Task 1 consolidation, but no broad historical sweep is enabled.
These probes made no database writes, cursor changes or production changes.

## Registry-pool block fraction: 60 of 100 blocks

Recounted the retained read-only sample from **10:32:08 UTC**, range
**29,024,569 through 29,024,668 inclusive**. This sample already resolved the
registry subset before consolidation; reporting it now avoids spending RPC
again merely to reproduce it. Evidence is versioned in
[evidence/phase-b-registry-density-2026-09-15.json](evidence/phase-b-registry-density-2026-09-15.json).

- All v4 observations: 221 swaps, 76 distinct blocks, 70 pool IDs.
- Verified-catalog subset: **123 swaps in 60 distinct blocks, across 24 pools**.
- Requested fraction: **60 / 100 = 60%**. Transactions and swaps are not the
  denominator. Every selected log is at or after its saved pool launch block.
- Discovery v2 cutoffs before/after the registry reads were 29,907,168 and
  29,937,168, both beyond the sample. The cutoff block hash was rechecked.
- Membership came from the public verified catalog, not one atomic SQL registry
  snapshot. This is a narrow historical sample, not a representative estimate
  of the entire history or recent activity. Do not turn 60% into a universal
  density claim.

### Implied CU under this sample's density

Use the user's original **40,528,588-block** full-history planning span.
For 14 days, explicitly assume **10 blocks/sec**, giving **12,096,000 blocks**;
an exact timestamp-derived trailing boundary has not been measured.
Block receipts cost 20 billable CU per selected block, so density contributes
`blocks * 0.60 * 20`. Log scans at 1,000 blocks cost `ceil(blocks/1000) * 60`.

| Scope | Block receipts only | Logs plus block receipts | Full collector sample shape |
| --- | ---: | ---: | ---: |
| Original full-history span | 486,343,056 CU | 488,774,796 CU | about 1,652,755,819 CU |
| Trailing 14 days at 10 blocks/sec | 145,152,000 CU | 145,877,760 CU | 493,274,880 CU |

The first two columns are **components**, not complete indexing budgets.
The final column scales the actual 100-block collector sample below, including
its headers and unit refresh frequency. Larger batches can amortize boundary
checks/log queries and repeated token-unit reads; different eras can change
all densities. It excludes retries, collection failures, commit checkpoint work,
and the continuing recent/analytics workers. It is a scenario, not a quote or
an approved historical run. Even the log-plus-receipt component is materially
larger than Phase A's discovery budget under the measured 60% density.

### Actual collector probe, still no writes

The same 100 blocks were passed through the merged collector at 10:35:12 UTC
using optional **block receipt mode**, with 24 catalog identities. It completed
in 23.051 seconds, used 47 HTTP requests / 189 logical calls, and observed no
429s. It retained 123 selected receipts, 76 headers and 24 dated token units.

| Method | Calls | Billable CU/call | Subtotal |
| --- | ---: | ---: | ---: |
| eth_chainId | 1 | 0 | 0 |
| eth_blockNumber | 1 | 10 | 10 |
| eth_getLogs | 1 | 60 | 60 |
| eth_getBlockByNumber | 78 | 20 | 1,560 |
| eth_getBlockReceipts | 60 | 20 | 1,200 |
| eth_call | 48 | 26 | 1,248 |
| Total | 189 | | **4,078 CU** |

The current collector verifies headers for **all observed v4 log blocks**, not
just registered blocks. Therefore selected-block density is the receipt-cost
multiplier, but **is not the sole multiplier on total Phase B cost** in this
implementation. No canonical header checks were removed for this measurement.
Transaction receipt mode remains the default; substituting its 123 receipt
calls would add 1,260 CU to this particular sample (5,338 CU total).

Serialized group bytes: **1,607,812**; SHA-256:
`b01544bf782d1612bbca9946a697f0e4217ca91a9c8a08193a4b3125f0291234`.
This validates collection of that sample, not a persistence transaction or
an atomic registry-membership commit. No competing writer was run.

## Initial measured density

At 10:12:26 UTC, a read-only Alchemy probe fetched three 1,000-block global
PoolManager Swap ranges. It validated the requested source, range, duplicate
identity absence and unchanged cutoff hash. It used 11 HTTP/logical calls,
with zero observed throttling. No receipts or token units were fetched by this
probe. These are all manager observations, not a verified Pools-only subset.

| From | Through | Swaps | Distinct blocks | Distinct transactions | Distinct pool IDs | Raw log JSON bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 29,023,669 | 29,024,668 | 2,729 | 870 | 2,369 | 244 | 2,603,030 |
| 38,993,682 | 38,994,681 | 1,193 | 661 | 1,088 | 181 | 1,137,434 |
| 63,576,941 | 63,577,940 | 2,184 | 831 | 1,775 | 488 | 2,082,509 |

The prepared collector checks headers for every observed log block, including
unregistered swaps. At the published method rates, that means at least
**17,400 / 13,220 / 16,620 CU** of header work in these respective ranges,
before boundary rechecks, receipts, token units or retries. The one log request
itself costs 60 CU. A larger log range does not remove those other calls.

If every observed transaction were registered, per-transaction receipts would
add at most **47,380 / 21,760 / 35,500 CU** respectively. If every observed pool
were registered and mapped to a distinct token, its two unit calls would add
at most **12,688 / 9,412 / 25,376 CU**. Actual selected subsets can be smaller.
These are per-sample planning bounds, not full-history estimates or billed use.

**Do not carry the Phase A 7.8M CU estimate into Phase B.** Three deliberately
chosen windows cannot establish the distribution over the entire history.
No full-run cost or completion time has been verified. Storage estimates must
also include receipts, headers, normalized rows, indexes, WAL and backups;
raw log bytes alone are not a database-size estimate.

## Receipt batching capability

At 10:14:16 UTC, a second read-only probe queried `eth_getBlockReceipts` at
block **29,024,668**, hash
`0xc9c9e52d3249ce171d274a30133964c987e1fbdda418b16463e024d5fe74da13`.
It returned **18 receipts / 258,626 JSON bytes**. All returned receipts matched
the block number/hash; one successful receipt with logs was exactly equal to
its separate `eth_getTransactionReceipt` response. The header was rechecked.
The probe made five logical/HTTP calls and exited zero.

This proves one historical capability sample, not every block. The method's
published billing cost is 20 CU, but its **throughput weight is 500 CU**.
Batching it at the ordinary ten-call/250ms pace would need separate throughput
analysis because recent, analytics and discovery share the account.

A possible optimization is one receipt request per selected block instead of
per selected transaction. It must retain the exact selected receipts and all
existing receipt/log/hash checks. Bound response bytes and receipt counts,
reject missing or duplicate selected receipts, and test equivalence with the
existing per-transaction path. Unrelated receipts may be discarded after
bounded validation; existing canonical evidence must not be dropped.
This optimization is implemented in merged commit `5b3e6ad` and covered by
receipt-equivalence tests. It is optional and not enabled in production.

## Next activation evidence

1. Measure registered subsets against a pinned completed discovery registry,
   using bounded samples from several launch eras. Report actual headers,
   selected transactions/blocks/tokens, method calls, retries, elapsed time,
   serialized evidence bytes and successful group validation.
2. Measure any receipt optimization on the same selected transactions and
   demonstrate identical retained evidence and decoded rows. Keep the current
   path as the baseline until provider, byte and throughput bounds are verified.
3. Produce a separate Phase B budget and storage estimate with explicit sample
   limitations before full production activation. Do not treat a green code CI
   run as approval of an unmeasured multi-million-request workload.

Sources checked September 15, 2026:
[Alchemy method costs](https://www.alchemy.com/docs/reference/compute-unit-costs)
and [published PAYG pricing](https://www.alchemy.com/pricing). The latter lists
$0.525 per million CU for PAYG usage. Do not assume the Free plan's 30M monthly
allowance is a credit on PAYG; account-specific billing remains authoritative.
No billing setting was changed.
