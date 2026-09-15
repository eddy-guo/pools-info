# Pool detail market serving

The existing `/v1/pools/:poolId` response adds `market: ObservedMarket`; the
existing web proxy and pool page consume it. The broad-only page uses the
existing pool layout and candle component. Deep published accounting continues
to use its existing snapshot, holders and supported positions. Broad history
does not manufacture a ChainMarket, wallet, holder balance or beneficiary.
The live-trades route remains recent-only.

Market coverage has its own start block, canonical cutoff block/hash/asOf,
indexedAt, window start and price baseline. Accounting is explicitly unavailable
on this observed contract. Catalog discovery, recent observation time and quiet
unprocessed pools never imply a processed market or zero trades. Only a surviving
canonical historical stream can establish the market cutoff. Recent copies can
corroborate historical identities but cannot advance that cutoff.

SQL combines deep saved swaps, normalized broad swaps and eligible recent copies
by transaction hash/log index. Conflicting pool/token, block/hash/time, signed
amounts or price state reject the read. Cross-pool copies are checked through
canonical identity indexes. Deep legacy payloads with exact signed amounts can
derive side and ETH volume without rounding. Unknown/unsupported signs remain
observed trades; affected window volume and current price are unavailable.

ETH amounts and price math remain exact decimal strings and PostgreSQL numeric
integers. The latest surviving canonical units observation at or before the market
cutoff declares the chart's token display scale. Its own dated block/hash/asOf
and source stay separate from the market coverage cutoff. This is display normalization, not evidence
that decimals were independently observed at every swap. Conflicting surviving
dated decimals suppress normalization. Missing all eligible units never defaults to 18. A quiet token retains its
chart when an unrelated or empty global batch advances coverage; the earlier
unit basis is never relabeled as observed at that newer cutoff. Token scales above the supported 36-decimal price
range remain unavailable. Current supply is never used for historical FDV.

The adapter aggregates complete canonical per-pool history in SQL. It returns
only summary totals, the latest 50 identities and the latest 1,000 minute OHLC
buckets. Stats are never computed from a fetched prefix. Baselines precede the
selected window and are not filtered out with window trades. Candles carry the
previous proven price state as their opening value; unsupported-price buckets
are omitted. Output truncation is explicit. The 21,001-trade Postgres-to-HTTP
fixture proves full exact totals with bounded observations and candles.

This is a pool-detail adapter, not the global screener architecture. Global
serving needs a rebuildable canonical per-pool/time-bucket rollup, cutoff and
unit-basis versioning, summary indexes for sorting/pagination, and atomic suffix
invalidation on discovery/broad/deep rewind. Deep saved swap price fields should
also be normalized into indexed scalar columns before global aggregation, rather
than scanning retained JSON evidence. No global screener request scans raw broad
swaps in this increment. Very large per-pool histories may also benefit from the
same rebuildable buckets; the current reader retains its existing 3-second SQL
budget rather than returning incomplete summary totals on timeout.

Prerequisites: broad persistence 010, worker integration 649b985 and canonical
token units dc603f8/migration011. Verification uses only isolated local
Postgres schemas and mocked website API responses. No production flag is enabled.
