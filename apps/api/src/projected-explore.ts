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
import { searchPattern } from "./request";
export async function readProjectedExplore(
  query: ReadQuery,
  options: AnalyticsExploreOptions,
): Promise<AnalyticsExploreResponse> {
  await assertCatalogIdentity(query);
  const coverage = await accountingCoverage(query),
    window = options.window ?? "24h",
    values: unknown[] = [windowFrom(coverage, window)],
    conditions: string[] = [];
  const q = (options.q ?? "").trim();
  if (q) {
    values.push(searchPattern(q));
    conditions.push(
      `(lower(p.name) LIKE $2 ESCAPE '\\' OR lower(p.symbol) LIKE $2 ESCAPE '\\' OR p.token LIKE $2 ESCAPE '\\' OR p.pool_id LIKE $2 ESCAPE '\\' OR p.launch_sender LIKE $2 ESCAPE '\\')`,
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
  ), metrics AS (
    SELECT a.*,coalesce(f.volume,0) AS volume,coalesce(f.trades,0) AS trades,
      CASE WHEN coalesce(b.price_wei,CASE WHEN (a.market->>'launchedAt')::bigint >= $1 THEN first.price_wei END)>0
        THEN div((last.price_wei-coalesce(b.price_wei,first.price_wei))*1000000,coalesce(b.price_wei,first.price_wei))/10000 END AS change
    FROM analytics_accounting_pools a LEFT JOIN flow f USING(pool_id)
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id AND timestamp <= $1 ORDER BY ordinal DESC LIMIT 1)b ON true
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id ORDER BY ordinal LIMIT 1)first ON true
    LEFT JOIN LATERAL(SELECT price_wei FROM analytics_accounting_prices WHERE chain_id=4663 AND pool_id=a.pool_id ORDER BY ordinal DESC LIMIT 1)last ON true
    WHERE a.chain_id=4663
  ) SELECT p.*,m.market,m.volume,m.trades,m.change,m.liquidity_wei,m.holders_count,m.from_block,m.from_timestamp,m.asof_timestamp,m.through_block,m.generated_at,m.source_kind
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
      priceWei: r.market?.priceWei ?? null,
      volumeWei: r.market ? String(r.volume) : null,
      liquidityWei: r.liquidity_wei ?? null,
      change: r.change === null ? null : Number(r.change),
      trades: r.trades ?? null,
      holders: r.holders_count ?? null,
      completeWindow:
        !!r.market &&
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
  }));
  return {
    coverage,
    window,
    items,
    total,
    nextOffset: offset + limit < total ? offset + limit : null,
    ...(options.view === "crowd"
      ? {
          message:
            "Crowd launches are not included in the verified deployment registry yet.",
        }
      : {}),
  };
}
