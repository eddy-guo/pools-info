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
  broadFlowCte,
  broadCoverageSql,
} from "./broad-explore";
import { searchPattern } from "./request";
export async function readProjectedExplore(
  query: ReadQuery,
  options: AnalyticsExploreOptions,
): Promise<AnalyticsExploreResponse> {
  // JIT never pays for these statements: per-row LATERAL lookups inflate their
  // cost estimates far past jit_optimize_above_cost while they execute in well
  // under a second, so a host with JIT available (CI's stock container; not
  // this project's Homebrew builds) spends seconds compiling and optimizing
  // them and blows the statement budget. Local to the read transaction.
  await query("SET LOCAL jit = off");
  await assertCatalogIdentity(query);
  const broadCut = await broadExploreCut(query);
  const coverage = await accountingCoverage(query),
    window = options.window ?? "24h",
    // $1-$6 feed the metric CTEs; catalog filters bind after them.
    metricValues: unknown[] = [
      windowFrom(coverage, window),
      broadCut?.block ?? null,
      broadWindowStart(broadCut, window),
      broadCut?.startBlock ?? null,
      broadCut?.discoveryBatch ?? null,
      broadCut?.asOf ?? null,
    ];
  // Catalog filters read launch rows only, so they can run before any metric.
  const catalogFilters: { value: unknown; sql: (p: string) => string }[] = [];
  const q = (options.q ?? "").trim();
  if (q)
    catalogFilters.push({
      value: searchPattern(q),
      sql: (p) =>
        `(lower(p.name) LIKE ${p} ESCAPE '\\' OR lower(p.symbol) LIKE ${p} ESCAPE '\\' OR p.token LIKE ${p} ESCAPE '\\' OR p.pool_id LIKE ${p} ESCAPE '\\' OR p.launch_sender LIKE ${p} ESCAPE '\\')`,
    });
  if (options.view === "watchlist")
    catalogFilters.push({
      value: options.ids ?? [],
      sql: (p) => `p.pool_id=ANY(${p}::text[])`,
    });
  const catalogConditions = (bound: number) => [
    ...catalogFilters.map((filter, i) => filter.sql(`$${bound + i + 1}`)),
    ...(options.view === "crowd" ? ["false"] : []),
  ];
  const sort = options.view === "new" ? "launch" : (options.sort ?? "launch");
  const metricConditions: string[] = [];
  if (options.view === "gainers") metricConditions.push("m.change>0");
  if (sort === "volume") metricConditions.push("m.volume IS NOT NULL");
  if (sort === "trades") metricConditions.push("m.trades IS NOT NULL");
  if (sort === "liquidity")
    metricConditions.push("m.liquidity_wei IS NOT NULL");
  if (sort === "change") metricConditions.push("m.change IS NOT NULL");
  const where = (conditions: string[]) =>
    conditions.length ? "WHERE " + conditions.join(" AND ") : "";
  const column = {
      launch: "launch_block",
      volume: "volume",
      trades: "trades",
      liquidity: "liquidity_wei",
      change: "change",
    }[sort],
    direction = options.direction === "asc" ? "ASC" : "DESC",
    order = `${column} ${direction} NULLS LAST,pool_id ASC`;
  const offset = options.offset ?? 0,
    limit = options.limit ?? 25,
    catalogValues = catalogFilters.map((filter) => filter.value),
    values = [...metricValues, ...catalogValues],
    page = [...values, limit, offset],
    limitClause = `LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
  // Every path computes the full per-pool metrics (dated units, latest and
  // baseline price states) for the `page` relation only, never for the whole
  // catalog, because those per-pool lookups cost seconds at catalog scale on
  // a small host. Launch order selects the page's identities with a narrow
  // catalog sort. Trades and volume rank every launch on the cheap flow
  // columns (broad summaries under the coverage predicate, or deep flow) and
  // then bind the page's identities. Change, liquidity and the gainers view
  // rank the pools with a deep publication, the only pools whose change or
  // liquidity is served, so the full metrics run over that bounded set; a
  // catalog-wide change or price order waits for a per-pool latest-state
  // rollup. Rank keys mirror the served expressions and the page is served
  // in ranked order. An empty page is counted alone.
  const deepRanked =
    options.view === "gainers" || sort === "change" || sort === "liquidity";
  const metricCtes = `, flow AS (
    SELECT pool_id,sum(eth_wei) AS volume,count(*)::integer AS trades FROM analytics_accounting_trades WHERE chain_id=4663 AND timestamp >= $1 AND pool_id IN (SELECT pool_id FROM page) GROUP BY pool_id
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
    WHERE a.chain_id=4663 AND a.pool_id IN (SELECT pool_id FROM page)
  )${broadExploreCtes()}`;
  const columns = `p.*,m.market,m.volume,m.trades,m.price,m.change,m.liquidity_wei,m.holders_count,m.from_block,m.from_timestamp,m.asof_timestamp,m.through_block,m.generated_at,m.source_kind,
    m.broad_selected,m.unit_block,m.unit_hash,m.unit_time,m.unit_source,m.decimals,m.units_conflict,m.sqrt_price_x96,m.price_block,m.price_hash,m.price_time,m.baseline_block,m.baseline_hash,m.baseline_time,m.window_start,m.deep_hash`;
  let rows: Record<string, any>[], total: number;
  if (deepRanked) {
    const deepPage = `${catalogCte}, page AS (SELECT * FROM catalog p ${where([...catalogConditions(metricValues.length), "EXISTS(SELECT 1 FROM analytics_accounting_pools a WHERE a.chain_id=4663 AND a.pool_id=p.pool_id)"])})${metricCtes}`;
    rows = (
      await query(
        `SELECT * FROM (${deepPage} SELECT ${columns},count(*) OVER () AS total FROM page p LEFT JOIN metrics m USING(pool_id) ${where(metricConditions)}) filtered ORDER BY ${order} ${limitClause}`,
        page,
      )
    ).rows;
    total = rows.length
      ? Number(rows[0].total)
      : Number(
          (
            await query(
              `SELECT count(*)::text AS count FROM (${deepPage} SELECT 1 FROM page p LEFT JOIN metrics m USING(pool_id) ${where(metricConditions)}) filtered`,
              values,
            )
          ).rows[0].count,
        );
  } else {
    // The served trades and volume: broad flow where the canonical broad
    // cutoff covers the launch and no deep publication is newer, else deep.
    const broadSelected = `${broadCoverageSql("p.")} AND (a.through_block IS NULL OR $2 >= a.through_block)`;
    const rankedCtes = `${catalogCte}, flow AS (
    SELECT pool_id,sum(eth_wei) AS volume,count(*)::integer AS trades FROM analytics_accounting_trades WHERE chain_id=4663 AND timestamp >= $1 GROUP BY pool_id
  )${broadFlowCte("catalog")}, ranked AS (
    SELECT p.pool_id,
      CASE WHEN ${broadSelected} THEN coalesce(b.trades,0) WHEN a.pool_id IS NOT NULL THEN coalesce(f.trades,0) END AS trades,
      CASE WHEN ${broadSelected} THEN CASE WHEN coalesce(b.unsupported,0)=0 THEN coalesce(b.volume,0) END WHEN a.pool_id IS NOT NULL THEN coalesce(f.volume,0) END AS volume
    FROM catalog p LEFT JOIN broad_flow b ON b.pool_id=p.pool_id
    LEFT JOIN analytics_accounting_pools a ON a.chain_id=4663 AND a.pool_id=p.pool_id
    LEFT JOIN flow f ON f.pool_id=p.pool_id ${where(catalogConditions(metricValues.length))}
  )`;
    const [ranked, rankValues, countAlone, countValues] =
      sort === "launch"
        ? [
            `${catalogCte} SELECT pool_id,count(*) OVER () AS total FROM catalog p ${where(catalogConditions(0))} ORDER BY ${order} LIMIT $${catalogValues.length + 1} OFFSET $${catalogValues.length + 2}`,
            [...catalogValues, limit, offset],
            `${catalogCte} SELECT count(*)::text AS count FROM catalog p ${where(catalogConditions(0))}`,
            catalogValues,
          ]
        : [
            `${rankedCtes} SELECT pool_id,count(*) OVER () AS total FROM ranked WHERE ${column} IS NOT NULL ORDER BY ${order} ${limitClause}`,
            page,
            `${rankedCtes} SELECT count(*)::text AS count FROM ranked WHERE ${column} IS NOT NULL`,
            values,
          ];
    const ids = (await query(ranked, rankValues)).rows;
    total = ids.length
      ? Number(ids[0].total)
      : Number((await query(countAlone, countValues)).rows[0].count);
    const idsParam = `$${metricValues.length + 1}::text[]`;
    rows = ids.length
      ? (
          await query(
            `${catalogCte}, page AS (SELECT * FROM catalog p WHERE p.pool_id=ANY(${idsParam}))${metricCtes}
    SELECT ${columns} FROM page p LEFT JOIN metrics m USING(pool_id) ORDER BY array_position(${idsParam},p.pool_id)`,
            [...metricValues, ids.map((row) => row.pool_id)],
          )
        ).rows
      : [];
  }
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
