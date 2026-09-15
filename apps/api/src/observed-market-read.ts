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
        AND ps.stream_key='discovery:v2' AND ps.batch_end<=bb.discovery_batch) AS pool_registered
    FROM indexer_streams s LEFT JOIN indexer_batches b ON b.chain_id=s.chain_id AND b.stream_key=s.stream_key AND b.to_block=s.cursor_block
    LEFT JOIN broad_batches bb ON bb.chain_id=b.chain_id AND bb.stream_key=b.stream_key AND bb.batch_end=b.to_block
    LEFT JOIN indexer_batches d ON d.chain_id=bb.chain_id AND d.stream_key=bb.discovery_stream AND d.to_block=bb.discovery_batch
    WHERE s.chain_id=4663 AND (s.stream_key='swaps:broad:v1' OR s.kind='pool' AND s.pool_id=$1)`,
    [id],
  );
  const cuts: { start: number; cutoff: MarketBoundary; indexedAt: string }[] =
    [];
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
    });
  }
  cuts.sort((a, b) => b.cutoff.block - a.cutoff.block);
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
  // Aggregate the entire canonical pool history in PostgreSQL. Only summary,
  // fifty trade identities and one thousand candle buckets cross the wire.
  const result = await query(
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
    SELECT *,CASE WHEN $5::integer IS NOT NULL AND side IS NOT NULL AND sqrt_price_x96 ~ '^[1-9][0-9]{0,95}$'
      THEN trunc(6277101735386680763835789423207666416102355444464034512896::numeric * power(10::numeric,$5::integer)
        / (sqrt_price_x96::numeric*sqrt_price_x96::numeric)) END AS price,
      CASE WHEN eth_wei ~ '^(0|[1-9][0-9]{0,95})$' THEN eth_wei::numeric END AS volume,
      CASE WHEN amount0 ~ '^(0|-?[1-9][0-9]{0,95})$' THEN amount0::numeric END AS a0,
      CASE WHEN amount1 ~ '^(0|-?[1-9][0-9]{0,95})$' THEN amount1::numeric END AS a1
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
        OR block_hash !~ '^0x[0-9a-f]{64}$' OR tx_hash !~ '^0x[0-9a-f]{64}$' OR
        block_number=$3 AND block_hash<>$8 OR sqrt_price_x96 IS NOT NULL AND sqrt_price_x96 !~ '^(0|[1-9][0-9]{0,95})$'),false) AS invalid,
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
