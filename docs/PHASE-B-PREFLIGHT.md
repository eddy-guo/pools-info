# Phase B workload preflight

Status: measurement in progress, September 15, 2026. Phase A remains active.
The broad worker is disabled and isolated from main. These probes made no
database writes, cursor changes or production configuration changes.

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
This optimization is not implemented or enabled yet.

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
