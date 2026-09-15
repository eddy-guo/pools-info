import {
  type AnalyticsExploreOptions,
  type AnalyticsExploreResponse,
  type AnalyticsPoolRow,
} from "@pools/core";
import { accountingCoverage, windowFrom } from "./accounting-read";
import {
  assertCatalogIdentity,
  catalogCte,
  type ReadQuery,
} from "./catalog-read";
import { catalogPool } from "./explore-read";
import {
  broadExploreCut,
  broadWindowStart,
  broadExploreCtes,
} from "./broad-explore";
import { searchPattern } from "./request";
export async function readProjectedExplore(
  query: ReadQuery,
  options: AnalyticsExploreOptions,
): Promise<AnalyticsExploreResponse> {
  await assertCatalogIdentity(query);
  const broadCut = await broadExploreCut(query);
  const coverage = await accountingCoverage(query),
    window = options.window ?? "24h",
    values: unknown[] = [
      windowFrom(coverage, window),
      broadCut?.block ?? null,
      broadWindowStart(broadCut, window),
      broadCut?.startBlock ?? null,
      broadCut?.discoveryBatch ?? null,
      broadCut?.asOf ?? null,
    ],
    conditions: string[] = [];
  const q = (options.q ?? "").trim();
  if (q) {
    values.push(searchPattern(q));
    conditions.push(
      `(lower(p.name) LIKE $7 ESCAPE '\\' OR lower(p.symbol) LIKE $7 ESCAPE '\\' OR p.token LIKE $7 ESCAPE '\\' OR p.pool_id LIKE $7 ESCAPE '\\' OR p.launch_sender LIKE $7 ESCAPE '\\')`,
    );
  }
  if (options.view === "watchlist") {
    values.push(options.ids ?? []);
    conditions.push(`p.pool_id=ANY($${values.length}::text[])`);
  }
  if (options.view === "gainers") conditions.push("m.change>0");
  if (options.view === "crowd") conditions.push("false");
  const from = `${catalogCte}, flow AS (
    SELECT pool_id,sum(eth_wei) AS volume,count(*)::integer AS trades FROM analytics_accounting_trades WHERE chain_id=4663 AND timestamp >= $1 GROUP BY pool_id
  ), deep_metrics AS (
    SELECT a.*,coalesce(f.volume,0) AS volume,coalesce(f.trades,0) AS trades,
      EXISTS(SELECT 1 FROM broad_token_units u JOIN broad_batches bb USING(chain_id,stream_key,batch_end)
        WHERE u.chain_id=a.chain_id AND u.token=a.market->>'token' AND u.block_number BETWEEN a.from_block AND a.through_block
          AND u.timestamp<=a.asof_timestamp AND u.decimals<>(a.market->>'decimals')::integer) AS units_conflict,
      CASE WHEN coalesce(b.price_wei,CASE WHEN (a.market->>'launchedAt')::bigint >= $1 THEN first.price_wei END)>0
        THEN div((last.price_wei-coalesce(b.price_wei,first.price_wei))*1000000,coalesce(b.price_wei,first.price_wei))/10000 END AS change
    FROM analytics_accounting_pools a LEFT JOIN flow f USING(pool_id)
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id AND timestamp <= $1 ORDER BY ordinal DESC LIMIT 1)b ON true
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id ORDER BY ordinal LIMIT 1)first ON true
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id ORDER BY ordinal DESC LIMIT 1)last ON true
    WHERE a.chain_id=4663
  )${broadExploreCtes} SELECT p.*,m.market,m.volume,m.trades,m.price,m.change,m.liquidity_wei,m.holders_count,m.from_block,m.from_timestamp,m.asof_timestamp,m.through_block,m.generated_at,m.source_kind,
    m.broad_selected,m.unit_block,m.unit_hash,m.unit_time,m.unit_source,m.decimals,m.units_conflict,m.sqrt_price_x96,m.price_block,m.price_hash,m.price_time,m.baseline_block,m.baseline_hash,m.baseline_time,m.window_start,m.deep_hash
    FROM catalog p LEFT JOIN metrics m USING(pool_id) ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}`;
  const count = (
    await query(
      `SELECT count(*)::text AS count FROM (${from}) filtered`,
      values,
    )
  ).rows[0];
  const total = Number(count.count),
    offset = options.offset ?? 0,
    limit = options.limit ?? 25;
  const sort = options.view === "new" ? "launch" : (options.sort ?? "volume");
  const column = {
      launch: "launch_block",
      volume: "volume",
      price: "price",
      trades: "trades",
      liquidity: "liquidity_wei",
      change: "change",
    }[sort],
    direction = options.direction === "asc" ? "ASC" : "DESC";
  const rows = (
    await query(
      `SELECT * FROM (${from}) filtered ORDER BY ${column} ${direction} NULLS LAST,pool_id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  // Fetch chart samples only for this page, not for every pool in the corpus.
  const prices = (
    await query(
      `WITH points AS(SELECT pool_id,timestamp,price_wei,ordinal,count(*) OVER(PARTITION BY pool_id) AS total FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=ANY($1::text[]))
    SELECT pool_id,timestamp,price_wei FROM points WHERE mod(ordinal,greatest(1,ceil(total/160.0)::integer))=0 OR ordinal=total-1 ORDER BY pool_id,ordinal`,
      [rows.filter((r) => r.market).map((r) => r.pool_id)],
    )
  ).rows;
  const series = new Map<string, { time: number; wei: string }[]>();
  for (const p of prices) {
    const list = series.get(p.pool_id) ?? [];
    list.push({ time: Number(p.timestamp), wei: String(p.price_wei) });
    series.set(p.pool_id, list);
  }
  const items: AnalyticsPoolRow[] = rows.map((r) => ({
    ...catalogPool(r),
    processed: !!r.market,
    market: r.market
      ? { ...r.market, series: series.get(r.pool_id) ?? [] }
      : null,
    stats: {
      priceWei: r.price === null ? null : String(r.price),
      volumeWei: r.volume === null ? null : String(r.volume),
      liquidityWei: r.liquidity_wei ?? null,
      change: r.change === null ? null : Number(r.change),
      trades: r.trades === null ? null : Number(r.trades),
      holders: r.holders_count ?? null,
      completeWindow: r.broad_selected
        ? r.price !== null &&
          !r.units_conflict &&
          r.volume !== null &&
          (window === "All" ||
            Number(r.launched_at) >= Number(r.window_start) ||
            r.baseline_block !== null)
        : !!r.market &&
          !r.units_conflict &&
          Number(r.asof_timestamp) >= coverage.asOf &&
          (window === "All"
            ? Number(r.from_block) <= Number(r.launch_block)
            : Number(r.from_timestamp) <= Number(values[0]) ||
              Number(r.launched_at) >= Number(values[0])),
    },
    asOf: r.asof_timestamp === null ? null : Number(r.asof_timestamp),
    throughBlock: r.through_block === null ? null : Number(r.through_block),
    generatedAt: r.generated_at ? new Date(r.generated_at).toISOString() : null,
    sourceKind: r.source_kind,
    marketCoverage:
      r.broad_selected && broadCut
        ? {
            source: "canonical_broad",
            startBlock: Math.max(broadCut.startBlock, Number(r.launch_block)),
            cutoff: {
              block: broadCut.block,
              hash: broadCut.hash,
              asOf: broadCut.asOf,
            },
            windowStart:
              window === "All" ? Number(r.launched_at) : Number(r.window_start),
            indexedAt: broadCut.indexedAt,
            unitsConflict: !!r.units_conflict,
            unitBasis:
              r.decimals === null || r.units_conflict || Number(r.decimals) > 36
                ? null
                : {
                    block: Number(r.unit_block),
                    hash: r.unit_hash,
                    asOf: Number(r.unit_time),
                    decimals: Number(r.decimals),
                    source: r.unit_source,
                  },
            rawPrice:
              r.sqrt_price_x96 === null
                ? null
                : {
                    sqrtPriceX96: String(r.sqrt_price_x96),
                    block: Number(r.price_block),
                    hash: r.price_hash,
                    asOf: Number(r.price_time),
                  },
            priceBaseline:
              r.baseline_block === null
                ? null
                : {
                    block: Number(r.baseline_block),
                    hash: r.baseline_hash,
                    asOf: Number(r.baseline_time),
                  },
          }
        : r.market
          ? {
              source: "deep_publication",
              startBlock: Number(r.from_block),
              cutoff: {
                block: Number(r.through_block),
                hash: r.deep_hash,
                asOf: Number(r.asof_timestamp),
              },
              windowStart:
                window === "All" ? Number(r.launched_at) : Number(values[0]),
              indexedAt: new Date(r.generated_at).toISOString(),
              unitsConflict: !!r.units_conflict,
              unitBasis: r.units_conflict
                ? null
                : {
                    block: Number(r.through_block),
                    hash: r.deep_hash,
                    asOf: Number(r.asof_timestamp),
                    decimals: r.market.decimals,
                    source: "verified_deep_snapshot",
                  },
              rawPrice: null,
              priceBaseline: null,
            }
          : null,
  }));
  return {
    coverage,
    window,
    items,
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
    broadMarketCutoff: broadCut,
    ...(options.view === "crowd"
      ? {
          message:
            "Crowd launches are not included in the verified deployment registry yet.",
        }
      : {}),
  };
}
