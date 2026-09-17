import {
  assertObservedMarket,
  type LiveWindow,
  type ObservedMarket,
  type MarketBoundary,
} from "@pools/core";
import { RequestError } from "./request";
import type { ReadQuery } from "./catalog-read";

const seconds = {
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
  "30d": 2592000,
  All: Infinity,
};
const bad = () => new RequestError(503, "market_evidence_invalid");
const n = (v: unknown) => {
  const value = Number(v);
  if (v === null || !Number.isSafeInteger(value) || value < 0) throw bad();
  return value;
};
const hash = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
/** SQL predicates for the canonical literals the adapter accepts: decimal
 * integers of at most 96 digits and 32-byte hex hashes. Each matches the shape
 * with an unbounded repetition and bounds the length separately, because a
 * bounded repetition such as `[0-9]{0,95}` unrolls into that many regex states
 * and costs about 12 µs per evaluation: at seven per swap, a 21,000-swap pool
 * spent 1.5 s of its 3 s statement budget on these alone. */
export const literal = {
  unsigned: (column: string) =>
    `${column} ~ '^(0|[1-9][0-9]*)$' AND length(${column})<=96`,
  positive: (column: string) =>
    `${column} ~ '^[1-9][0-9]*$' AND length(${column})<=96`,
  signed: (column: string) =>
    `${column} ~ '^(0|-?[1-9][0-9]*)$' AND length(ltrim(${column},'-'))<=96`,
  hash: (column: string) =>
    `${column} ~ '^0x[0-9a-f]*$' AND length(${column})=66`,
};
/** The display price of a raw sqrt price state in the declared units: the
 * same exact numeric expression as the raw path applies per swap. */
const priceOf = (sqrt: string) =>
  `trunc(6277101735386680763835789423207666416102355444464034512896::numeric * power(10::numeric,$5::integer) / (${sqrt}*${sqrt}))`;
/** The market statement served from the canonical rollups for a broad-selected
 * cut. $1 pool, $2 start block, $3 cutoff block, $4 window start, $5 decimals.
 * Trades and volume come from whole batch summaries inside the window plus the
 * edge batches' intersecting buckets, exactly as the explore read sums them.
 * The latest and baseline price states are the newest bucket at or before the
 * cutoff and the newest before the window. Candles fold the buckets by minute
 * with hashable aggregates only, so the fold never sorts the pool's buckets
 * and its memory is the pool's minutes: a minute is a candle when every swap
 * in it is supported, and because the price is monotonic in the sqrt price
 * its high and low are the prices of the lowest and highest sqrt among its
 * swaps and the previous swap's state. Only the served candles then probe the
 * pool price index for their opening, closing and previous states (the
 * previous non-empty minute's last bucket), at most three probes each; an open
 * is that previous state or, after an unsupported swap, the minute's own first.
 * Observations are the newest fifty broad rows. Identity conflicts are the
 * write-time caches touching this pool on either side; the projection
 * validated provenance per row when it wrote the bucket. */
const bucketState = (time: string, order: string) =>
  `SELECT * FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=$1 AND batch_end<=$3 AND timestamp=${time} ORDER BY ${order} LIMIT 1`;
const rollupMarketSql = `WITH flow AS (
    SELECT coalesce(sum(trades),0) AS trades,coalesce(sum(unsupported),0) AS unsupported,coalesce(sum(volume_wei),0) AS volume FROM (
      SELECT trades,unsupported,volume_wei FROM broad_market_summaries
        WHERE chain_id=4663 AND pool_id=$1 AND batch_end<=$3 AND first_timestamp>=$4
      UNION ALL
      SELECT k.trades,k.unsupported,k.volume_wei FROM broad_market_buckets k
        JOIN broad_market_summaries s USING(chain_id,stream_key,batch_end,pool_id)
        WHERE k.chain_id=4663 AND k.pool_id=$1 AND k.batch_end<=$3 AND k.timestamp>=$4 AND s.first_timestamp<$4
    ) inputs
  ), minutes AS (
    SELECT timestamp/60 AS minute,sum(unsupported) AS unsupported,sum(volume_wei) AS volume,min(min_sqrt) AS min_sqrt,max(max_sqrt) AS max_sqrt,
      min(timestamp) AS first_time,max(timestamp) AS last_time
    FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=$1 AND batch_end<=$3 GROUP BY timestamp/60
  ), buckets AS (
    SELECT * FROM (SELECT *,lag(last_time) OVER(ORDER BY minute) AS previous_time FROM minutes) ordered
    WHERE $5::integer IS NOT NULL AND unsupported=0 AND min_sqrt>0
  ), history AS (
    SELECT b.minute*60 AS time,
      ${priceOf("coalesce(previous.sqrt,opening.first_sqrt)")}::text AS open,
      ${priceOf("least(previous.sqrt,b.min_sqrt)")}::text AS high,
      ${priceOf("greatest(previous.sqrt,b.max_sqrt)")}::text AS low,
      ${priceOf("closing.last_sqrt")}::text AS close,b.volume::text AS volume
    FROM (SELECT * FROM buckets ORDER BY minute DESC LIMIT 1000) b
    CROSS JOIN LATERAL (${bucketState("b.first_time", "first_block,first_log,first_tx")}) opening
    CROSS JOIN LATERAL (${bucketState("b.last_time", "last_block DESC,last_log DESC,last_tx DESC")}) closing
    LEFT JOIN LATERAL (SELECT CASE WHEN last_price_supported THEN last_sqrt END AS sqrt
      FROM (${bucketState("b.previous_time", "last_block DESC,last_log DESC,last_tx DESC")}) state) previous ON true
  ), observations AS (
    SELECT tx_hash,log_index,block_number,block_hash,timestamp,side,eth_wei::text AS eth_wei,
      CASE WHEN side IS NOT NULL THEN abs(amount1)::text END AS token_raw
    FROM broad_swaps WHERE chain_id=4663 AND pool_id=$1 AND block_number BETWEEN $2 AND $3
    ORDER BY block_number DESC,log_index DESC LIMIT 50
  )
  SELECT flow.trades,CASE WHEN flow.unsupported=0 THEN flow.volume::text END AS volume,false AS invalid,
    CASE WHEN latest.last_price_supported THEN ${priceOf("latest.last_sqrt")}::text END AS price,
    CASE WHEN baseline.last_price_supported THEN ${priceOf("baseline.last_sqrt")}::text END AS baseline_price,
    baseline.last_block AS baseline_block,baseline.last_hash AS baseline_hash,baseline.timestamp AS baseline_timestamp,
    (SELECT count(*) FROM buckets)>1000 AS truncated,
    coalesce((SELECT jsonb_agg(jsonb_build_object('time',time,'open',open,'high',high,'low',low,'close',close,'volume',volume) ORDER BY time) FROM history),'[]'::jsonb) AS candles,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',tx_hash||':'||log_index,'transactionHash',tx_hash,'logIndex',log_index,'block',block_number,'blockHash',block_hash,'timestamp',timestamp,'side',side,'ethWei',eth_wei,'tokenRaw',token_raw) ORDER BY block_number DESC,log_index DESC,tx_hash DESC) FROM observations),'[]'::jsonb) AS observations,
    EXISTS(SELECT 1 FROM broad_market_conflicts c
      JOIN broad_swaps b ON b.chain_id=c.chain_id AND b.tx_hash=c.tx_hash AND b.log_index=c.log_index
      LEFT JOIN indexed_events e ON e.chain_id=c.chain_id AND e.stream_key=c.copy_stream AND e.tx_hash=c.tx_hash AND e.log_index=c.log_index
      WHERE c.chain_id=4663 AND c.batch_end<=$3 AND (b.pool_id=$1 OR e.pool_id=$1)) OR
    EXISTS(SELECT 1 FROM broad_market_recent_conflicts c
      JOIN broad_swaps b ON b.chain_id=c.chain_id AND b.tx_hash=c.tx_hash AND b.log_index=c.log_index
      LEFT JOIN recent_swaps e ON e.chain_id=c.chain_id AND e.tx_hash=c.tx_hash AND e.log_index=c.log_index
      WHERE c.chain_id=4663 AND c.batch_end<=$3 AND (b.pool_id=$1 OR e.pool_id=$1)) AS conflict,
    false AS other_pool_conflict
  FROM flow
  LEFT JOIN LATERAL (SELECT * FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=$1 AND batch_end<=$3
    ORDER BY timestamp DESC,last_block DESC,last_log DESC,last_tx DESC LIMIT 1) latest ON true
  LEFT JOIN LATERAL (SELECT * FROM broad_market_buckets WHERE chain_id=4663 AND pool_id=$1 AND batch_end<=$3 AND timestamp<$4
    ORDER BY timestamp DESC,last_block DESC,last_log DESC,last_tx DESC LIMIT 1) baseline ON true`;
/** Pool-scoped evidence adapter. Recent copies may corroborate history, but do
 * not move the historical cutoff or imply transfer/accounting completeness. */
export async function readObservedMarket(
  query: ReadQuery,
  pool: Record<string, any>,
  window: LiveWindow,
  verifiedUnits: { decimals: number; cutoff: MarketBoundary } | null,
): Promise<ObservedMarket> {
  const id = pool.pool_id;
  const streams = await query(
    `SELECT s.*, b.to_block,b.block_hash,b.evidence->'headers' AS headers,bb.timestamp AS broad_timestamp,
      d.block_hash AS discovery_hash,d.content_hash AS discovery_content_hash,
      bb.discovery_hash AS pinned_hash,bb.discovery_content_hash AS pinned_content_hash,
      EXISTS(SELECT 1 FROM pool_launch_sources ps WHERE ps.chain_id=s.chain_id AND ps.pool_id=$1
        AND ps.stream_key='discovery:v2' AND ps.batch_end<=bb.discovery_batch) AS pool_registered,
      s.kind='broad' AND NOT EXISTS(SELECT 1 FROM broad_batches gap LEFT JOIN broad_market_batches m USING(chain_id,stream_key,batch_end)
        WHERE gap.chain_id=s.chain_id AND gap.stream_key=s.stream_key AND gap.batch_end<=s.cursor_block AND m.batch_end IS NULL)
        AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('broad_market_buckets') AND attname='max_sqrt' AND NOT attisdropped) AS projected
    FROM indexer_streams s LEFT JOIN indexer_batches b ON b.chain_id=s.chain_id AND b.stream_key=s.stream_key AND b.to_block=s.cursor_block
    LEFT JOIN broad_batches bb ON bb.chain_id=b.chain_id AND bb.stream_key=b.stream_key AND bb.batch_end=b.to_block
    LEFT JOIN indexer_batches d ON d.chain_id=bb.chain_id AND d.stream_key=bb.discovery_stream AND d.to_block=bb.discovery_batch
    WHERE s.chain_id=4663 AND (s.stream_key='swaps:broad:v1' OR s.kind='pool' AND s.pool_id=$1)`,
    [id],
  );
  const cuts: {
    start: number;
    cutoff: MarketBoundary;
    indexedAt: string;
    // The canonical broad stream's own start and whether every batch through
    // its cursor has its market projection with the bucket extremes of
    // migration 018: the rollup path's preconditions. The schema check is per
    // request because this service deploys on its own while migrations run
    // from the indexer service's pre-deploy command, so a release ahead of the
    // migration keeps the raw path until the migration lands.
    rollups: { streamStart: number; projected: boolean } | null;
  }[] = [];
  for (const s of streams.rows) {
    if (s.cursor_block === null) continue;
    if (
      s.to_block === null ||
      s.cursor_hash !== s.block_hash ||
      !hash(s.cursor_hash)
    )
      throw bad();
    const broad = s.kind === "broad";
    if (broad && !s.pool_registered) continue;
    if (
      broad &&
      (s.broad_timestamp === null ||
        s.discovery_hash !== s.pinned_hash ||
        s.discovery_content_hash !== s.pinned_content_hash)
    )
      throw bad();
    const timestamp = broad
      ? s.broad_timestamp
      : s.headers?.find((h: any) => Number(h.number) === Number(s.cursor_block))
          ?.timestamp;
    if (timestamp === undefined) throw bad();
    if (n(s.cursor_block) < n(pool.launch_block)) continue;
    cuts.push({
      start: Math.max(n(s.start_block), n(pool.launch_block)),
      cutoff: {
        block: n(s.cursor_block),
        hash: s.cursor_hash,
        asOf: n(timestamp),
      },
      indexedAt: new Date(s.updated_at).toISOString(),
      rollups: broad
        ? { streamStart: n(s.start_block), projected: s.projected }
        : null,
    });
  }
  // The newest cutoff wins; at the same height the canonical broad cut does,
  // because the identity check below makes the two interchangeable and only
  // the broad cut has a bounded read.
  cuts.sort(
    (a, b) =>
      b.cutoff.block - a.cutoff.block ||
      Number(b.rollups !== null) - Number(a.rollups !== null),
  );
  const cut = cuts[0];
  const empty: ObservedMarket = {
    poolId: id,
    token: pool.token,
    decimals: null,
    priceWei: null,
    window,
    volumeWei: null,
    trades: null,
    change: null,
    observations: [],
    coverage: {
      startBlock: null,
      cutoff: null,
      indexedAt: null,
      completeWindow: false,
      windowStart: null,
      priceBaseline: null,
      unitBasis: null,
      unitsConflict: false,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: null,
      truncated: false,
      candles: [],
    },
  };
  if (!cut) return empty;
  if (cut.cutoff.asOf < n(pool.launched_at)) throw bad();
  for (const other of cuts.slice(1)) {
    if (
      other.cutoff.block === cut.cutoff.block &&
      (other.cutoff.hash !== cut.cutoff.hash ||
        other.cutoff.asOf !== cut.cutoff.asOf)
    )
      throw new RequestError(503, "market_identity_conflict");
    if (other.cutoff.block >= cut.start - 1)
      cut.start = Math.min(cut.start, other.start);
  }
  const windowStart =
    window === "All"
      ? n(pool.launched_at)
      : Math.max(0, cut.cutoff.asOf - seconds[window]);
  const units = await query(
    `WITH eligible AS (
    SELECT u.* FROM broad_token_units u JOIN broad_batches bb USING(chain_id,stream_key,batch_end)
    JOIN indexer_batches ib ON ib.chain_id=bb.chain_id AND ib.stream_key=bb.stream_key AND ib.to_block=bb.batch_end
      AND ib.block_hash=u.block_hash AND u.block_number=bb.batch_end AND u.timestamp=bb.timestamp
    JOIN indexer_batches d ON d.chain_id=bb.chain_id AND d.stream_key=bb.discovery_stream AND d.to_block=bb.discovery_batch
      AND d.block_hash=bb.discovery_hash AND d.content_hash=bb.discovery_content_hash
    WHERE u.chain_id=4663 AND u.token=$1 AND u.block_number BETWEEN $2 AND $3
  ), summary AS (SELECT count(DISTINCT decimals)>1 AS conflict,min(decimals) AS history_decimals FROM eligible)
  SELECT summary.*,latest.decimals,latest.block_number,latest.block_hash,latest.timestamp FROM summary
    LEFT JOIN LATERAL (SELECT * FROM eligible ORDER BY block_number DESC LIMIT 1) latest ON true`,
    [pool.token, cut.start, cut.cutoff.block],
  );
  const savedUnits = units.rows[0];
  const eligibleDeep =
    verifiedUnits &&
    verifiedUnits.cutoff.block >= cut.start &&
    verifiedUnits.cutoff.block <= cut.cutoff.block &&
    verifiedUnits.cutoff.asOf <= cut.cutoff.asOf
      ? verifiedUnits
      : null;
  const unitsConflict =
    savedUnits.conflict ||
    (eligibleDeep &&
      savedUnits.history_decimals !== null &&
      savedUnits.history_decimals !== eligibleDeep.decimals);
  const chosen =
    savedUnits.decimals !== null &&
    (!eligibleDeep || n(savedUnits.block_number) >= eligibleDeep.cutoff.block)
      ? {
          decimals: n(savedUnits.decimals),
          source: "broad_token_units" as const,
          cutoff: {
            block: n(savedUnits.block_number),
            hash: savedUnits.block_hash,
            asOf: n(savedUnits.timestamp),
          },
        }
      : eligibleDeep
        ? { ...eligibleDeep, source: "verified_deep_snapshot" as const }
        : null;
  const decimals =
    unitsConflict || !chosen || chosen.decimals > 36 ? null : chosen.decimals;
  const unitBasis =
    decimals === null || !chosen
      ? null
      : { ...chosen.cutoff, decimals, source: chosen.source };
  // Only summary totals, fifty trade identities and one thousand candle
  // buckets cross the wire on either path. A cut on the canonical broad stream
  // whose range the projections cover is served from the rollups; that path is
  // bounded by the pool's summaries and one-second buckets rather than its
  // swaps, which is what keeps the busiest pools inside the statement budget
  // (docs/BROAD-MARKET-SERVING.md, "Pool page from the rollups"). Anything
  // else, a deep-selected cut or a projection gap, aggregates the raw copies.
  const rollups =
    cut.rollups !== null &&
    cut.rollups.projected &&
    cut.start >= cut.rollups.streamStart;
  const result = rollups
    ? await query(rollupMarketSql, [
        id,
        cut.start,
        cut.cutoff.block,
        windowStart,
        decimals,
      ])
    : await query(
        `WITH historical AS MATERIALIZED (
    SELECT tx_hash,log_index,pool_id,token,block_number,block_hash,timestamp,
      amount0::text,amount1::text,side,eth_wei::text,sqrt_price_x96::text
    FROM broad_swaps WHERE chain_id=4663 AND pool_id=$1 AND block_number BETWEEN $2 AND $3
    UNION ALL
    SELECT e.tx_hash,e.log_index,e.pool_id,e.token,e.block_number,e.block_hash,e.timestamp,
      e.payload->'decoded'->>'amount0',e.payload->'decoded'->>'amount1',
      CASE WHEN e.payload->'decoded' ? 'side' THEN e.payload->'decoded'->>'side'
        WHEN (e.payload->'decoded'->>'amount0')::numeric<0 AND (e.payload->'decoded'->>'amount1')::numeric>0 THEN 'buy'
        WHEN (e.payload->'decoded'->>'amount0')::numeric>0 AND (e.payload->'decoded'->>'amount1')::numeric<0 THEN 'sell' END,
      CASE WHEN e.payload->'decoded' ? 'ethWei' THEN e.payload->'decoded'->>'ethWei'
        WHEN (e.payload->'decoded'->>'amount0')::numeric*(e.payload->'decoded'->>'amount1')::numeric<0 THEN abs((e.payload->'decoded'->>'amount0')::numeric)::text END,
      e.payload->'decoded'->>'sqrtPriceX96'
    FROM indexed_events e JOIN indexer_streams s USING(chain_id,stream_key)
    WHERE e.chain_id=4663 AND e.pool_id=$1 AND e.kind='swap' AND s.kind='pool'
      AND e.block_number BETWEEN $2 AND LEAST($3,s.cursor_block)
  ), identities AS MATERIALIZED (SELECT tx_hash,log_index FROM historical GROUP BY tx_hash,log_index),
  copies AS (
    SELECT * FROM historical
    UNION ALL
    SELECT e.tx_hash,e.log_index,e.pool_id,e.token,e.block_number,e.block_hash,e.timestamp,
      e.amount0,e.amount1,e.side,e.eth_wei,NULL::text
    FROM identities i JOIN recent_swaps e ON e.chain_id=4663 AND e.tx_hash=i.tx_hash AND e.log_index=i.log_index
    JOIN recent_batches b ON b.chain_id=e.chain_id AND b.stream_key=e.source_stream AND b.to_block=e.batch_end
    JOIN recent_streams s ON s.chain_id=e.chain_id AND s.stream_key=e.source_stream
    WHERE e.block_number BETWEEN GREATEST($2,s.start_block,b.from_block) AND LEAST($3,s.cursor_block,b.to_block)
  ), grouped AS MATERIALIZED (
    SELECT tx_hash,log_index,min(pool_id) AS pool_id,min(token) AS token,min(block_number) AS block_number,
      min(block_hash) AS block_hash,min(timestamp) AS timestamp,min(amount0) AS amount0,min(amount1) AS amount1,
      min(side) AS side,min(eth_wei) AS eth_wei,min(sqrt_price_x96) AS sqrt_price_x96,
      count(DISTINCT ROW(pool_id,token,block_number,block_hash,timestamp)) AS variants,
      count(DISTINCT ROW(amount0,amount1,side,eth_wei)) FILTER(WHERE amount0 IS NOT NULL AND amount1 IS NOT NULL) AS amount_variants,
      count(DISTINCT sqrt_price_x96) AS price_variants
    FROM copies GROUP BY tx_hash,log_index
  ), canonical AS MATERIALIZED (
    SELECT *,CASE WHEN $5::integer IS NOT NULL AND side IS NOT NULL AND ${literal.positive("sqrt_price_x96")}
      THEN trunc(6277101735386680763835789423207666416102355444464034512896::numeric * power(10::numeric,$5::integer)
        / (sqrt_price_x96::numeric*sqrt_price_x96::numeric)) END AS price,
      CASE WHEN ${literal.unsigned("eth_wei")} THEN eth_wei::numeric END AS volume,
      CASE WHEN ${literal.signed("amount0")} THEN amount0::numeric END AS a0,
      CASE WHEN ${literal.signed("amount1")} THEN amount1::numeric END AS a1
    FROM grouped
  ), validated AS (
    SELECT *, (amount0 IS NULL AND amount1 IS NULL AND side IS NULL AND eth_wei IS NULL AND sqrt_price_x96 IS NULL) OR a0 IS NOT NULL AND a1 IS NOT NULL AND
      ((a0<0 AND a1>0 AND side='buy' AND volume=-a0) OR
       (a0>0 AND a1<0 AND side='sell' AND volume=a0) OR
       (NOT ((a0<0 AND a1>0) OR (a0>0 AND a1<0)) AND side IS NULL AND eth_wei IS NULL)) AS valid
    FROM canonical
  ), summary AS (
    SELECT count(*) FILTER(WHERE timestamp >= $4) AS trades,
      CASE WHEN count(*) FILTER(WHERE timestamp >= $4 AND side IS NULL)=0
        THEN coalesce(sum(volume) FILTER(WHERE timestamp >= $4),0)::text END AS volume,
      coalesce(bool_or(valid IS NOT TRUE OR block_number<$2 OR block_number>$3 OR timestamp>$6 OR timestamp<$9 OR token<>$7
        OR NOT (${literal.hash("block_hash")}) OR NOT (${literal.hash("tx_hash")}) OR
        block_number=$3 AND block_hash<>$8 OR sqrt_price_x96 IS NOT NULL AND NOT (${literal.unsigned("sqrt_price_x96")})),false) AS invalid,
      coalesce(bool_or(variants>1 OR amount_variants>1 OR price_variants>1),false) AS conflict
    FROM validated
  ), ordered AS (
    SELECT *,lag(price) OVER(ORDER BY block_number,log_index,tx_hash) AS previous_price FROM canonical
  ), volumes AS (SELECT timestamp/60 AS minute,sum(volume)::text AS volume FROM canonical GROUP BY timestamp/60)
  , buckets AS (
    SELECT (ordered.timestamp/60)*60 AS time,
      (array_agg(coalesce(previous_price,price) ORDER BY block_number,log_index,tx_hash))[1]::text AS open,
      max(greatest(previous_price,price))::text AS high,min(least(previous_price,price))::text AS low,
      (array_agg(price ORDER BY block_number DESC,log_index DESC,tx_hash DESC))[1]::text AS close,
      max(v.volume) AS volume
    FROM ordered JOIN volumes v ON v.minute=ordered.timestamp/60 GROUP BY ordered.timestamp/60 HAVING bool_and(price IS NOT NULL)
  ), history AS (
    SELECT * FROM buckets ORDER BY time DESC LIMIT 1000
  ), observations AS (
    SELECT tx_hash,log_index,block_number,block_hash,timestamp,side,eth_wei,
      CASE WHEN side IS NOT NULL THEN abs(a1)::text END AS token_raw FROM canonical
    ORDER BY block_number DESC,log_index DESC,tx_hash DESC LIMIT 50
  )
  SELECT summary.*,latest.price::text AS price,baseline.price::text AS baseline_price,
    baseline.block_number AS baseline_block,baseline.block_hash AS baseline_hash,baseline.timestamp AS baseline_timestamp,
    (SELECT count(*) FROM buckets)>1000 AS truncated,
    coalesce((SELECT jsonb_agg(jsonb_build_object('time',time,'open',open,'high',high,'low',low,'close',close,'volume',volume) ORDER BY time) FROM history),'[]'::jsonb) AS candles,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',tx_hash||':'||log_index,'transactionHash',tx_hash,'logIndex',log_index,'block',block_number,'blockHash',block_hash,'timestamp',timestamp,'side',side,'ethWei',eth_wei,'tokenRaw',token_raw) ORDER BY block_number DESC,log_index DESC,tx_hash DESC) FROM observations),'[]'::jsonb) AS observations,
    EXISTS(SELECT 1 FROM identities i WHERE
      EXISTS(SELECT 1 FROM broad_swaps e WHERE e.chain_id=4663 AND e.tx_hash=i.tx_hash AND e.log_index=i.log_index AND (e.pool_id<>$1 OR e.token<>$7)) OR
      EXISTS(SELECT 1 FROM recent_swaps e WHERE e.chain_id=4663 AND e.tx_hash=i.tx_hash AND e.log_index=i.log_index AND (e.pool_id<>$1 OR e.token<>$7)) OR
      EXISTS(SELECT 1 FROM indexed_events e WHERE e.chain_id=4663 AND e.tx_hash=i.tx_hash AND e.log_index=i.log_index AND e.kind='swap' AND (e.pool_id<>$1 OR e.token<>$7))) AS other_pool_conflict
  FROM summary
  LEFT JOIN LATERAL (SELECT price FROM canonical ORDER BY block_number DESC,log_index DESC,tx_hash DESC LIMIT 1) latest ON true
  LEFT JOIN LATERAL (SELECT * FROM canonical WHERE timestamp<$4 ORDER BY block_number DESC,log_index DESC,tx_hash DESC LIMIT 1) baseline ON true`,
        [
          id,
          cut.start,
          cut.cutoff.block,
          windowStart,
          decimals,
          cut.cutoff.asOf,
          pool.token,
          cut.cutoff.hash,
          n(pool.launched_at),
        ],
      );
  const row = result.rows[0];
  if (row.conflict || row.other_pool_conflict)
    throw new RequestError(503, "market_identity_conflict");
  if (row.invalid) throw bad();
  const baseline =
    row.baseline_price !== null
      ? {
          block: n(row.baseline_block),
          hash: row.baseline_hash,
          asOf: n(row.baseline_timestamp),
        }
      : null;
  const market: ObservedMarket = {
    ...empty,
    decimals,
    priceWei: row.price,
    volumeWei: row.volume,
    trades: n(row.trades),
    observations: row.observations,
    change:
      row.price !== null &&
      row.baseline_price !== null &&
      BigInt(row.baseline_price) > 0n
        ? Number(
            ((BigInt(row.price) - BigInt(row.baseline_price)) * 10000n) /
              BigInt(row.baseline_price),
          ) / 100
        : null,
    coverage: {
      ...empty.coverage,
      startBlock: cut.start,
      cutoff: cut.cutoff,
      indexedAt: cut.indexedAt,
      windowStart,
      completeWindow:
        cut.start === n(pool.launch_block) &&
        row.price !== null &&
        decimals !== null &&
        row.volume !== null &&
        (n(pool.launched_at) >= windowStart || baseline !== null),
      priceBaseline: baseline,
      unitBasis,
      unitsConflict: Boolean(unitsConflict),
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 60,
      fromTimestamp: row.candles[0]?.time ?? null,
      truncated: row.truncated,
      candles: row.candles,
    },
  };
  assertObservedMarket(market, id, pool.token, window);
  return market;
}
