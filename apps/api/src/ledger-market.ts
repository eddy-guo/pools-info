import {
  assertObservedMarket,
  windows,
  type LiveWindow,
  type MarketBoundary,
  type ObservedMarket,
} from "@pools/core";
import type { ReadQuery } from "./catalog-read";
import { RequestError } from "./request";

/** Where the screener's and the pool page's market figures come from:
 * `broad`, the canonical broad rollups beside the deep publications (the
 * default, and what an unconfigured deployment serves), or `ledger`, the
 * aggregate ledger's pool hours and pool state for every launch the ledger
 * covers (docs/LEDGER-MARKET-SERVING.md). */
export type MarketSource = "broad" | "ledger";
/** Reads `MARKET_SOURCE` once, at startup; anything but the two names refuses
 * to start rather than silently serving the default. */
export function marketSourceSetting(value: string | undefined): MarketSource {
  if (value === undefined || value === "" || value === "broad") return "broad";
  if (value === "ledger") return "ledger";
  throw Error("Invalid MARKET_SOURCE");
}

const bad = () => new RequestError(503, "market_evidence_invalid");
const whole = (v: unknown) => {
  const value = Number(v);
  if (v === null || !Number.isSafeInteger(value) || value < 0) throw bad();
  return value;
};

/** The ledger's served boundary. `cutoff` is the committed cursor (every
 * swap at or below that block is folded); `newestHour` is the newest UTC hour
 * the pool hours hold, which anchors every window. */
export interface LedgerCut extends MarketBoundary {
  startBlock: number;
  newestHour: number;
  indexedAt: string;
}
/** The ledger's cut, or null when it has folded nothing yet (no cursor or no
 * pool hour), in which case every pool answers from the broad and deep
 * sources exactly as with the switch off. The cursor must be the newest
 * committed batch's end, and no pool hour may start after it. */
export async function ledgerCut(query: ReadQuery): Promise<LedgerCut | null> {
  const { rows } =
    await query(`SELECT s.start_block,s.cursor_block,'0x'||encode(s.cursor_hash,'hex') AS cursor_hash,s.cursor_timestamp,
    '0x'||encode(b.block_hash,'hex') AS batch_hash,b.to_timestamp AS batch_timestamp,b.collected_at,
    (SELECT max(hour) FROM agg_pool_hours WHERE chain_id=4663) AS newest_hour,
    EXISTS(SELECT 1 FROM analytics_accounting_pools a WHERE a.chain_id=4663 AND a.through_block=s.cursor_block
      AND (a.through_hash<>'0x'||encode(s.cursor_hash,'hex') OR a.asof_timestamp<>s.cursor_timestamp)) AS conflict
  FROM agg_streams s LEFT JOIN agg_batches b ON b.chain_id=s.chain_id AND b.stream_key=s.stream_key AND b.to_block=s.cursor_block
  WHERE s.chain_id=4663 AND s.stream_key='ledger:agg:v1'`);
  const r = rows[0];
  if (!r || r.cursor_block === null || r.newest_hour === null) return null;
  const block = whole(r.cursor_block),
    asOf = whole(r.cursor_timestamp),
    newestHour = whole(r.newest_hour);
  if (
    r.batch_hash !== r.cursor_hash ||
    r.batch_timestamp === null ||
    whole(r.batch_timestamp) !== asOf ||
    newestHour * 3600 > asOf
  )
    throw bad();
  if (r.conflict) throw new RequestError(503, "market_identity_conflict");
  return {
    block,
    hash: r.cursor_hash,
    asOf,
    startBlock: whole(r.start_block),
    newestHour,
    indexedAt: new Date(r.collected_at).toISOString(),
  };
}
/** The rolling hour 1h names: the swaps from `start` (the cutoff's time
 * less an hour) through the cursor, read from the live ring, which holds
 * every folded swap of the 24 hours ending at the cursor (`agg_live_trades`,
 * written in the batch that folds each swap and pruned from its oldest end,
 * so it is always every swap after its oldest row). Whole hours cannot
 * answer it: the newest hour holds only the minutes up to the cursor, so an
 * hour-bucketed 1h would be three minutes of trading at 09:03 under an
 * hour's name. The block bounds come from the batches' end times, so each
 * read is a range of the ring's block index rather than a scan: every swap
 * at or below `afterBlock` is before `start`, every swap before `start` is at
 * or below `beforeBlock`, and every swap at or below `hourAfterBlock` is
 * before `start`'s UTC hour. */
export interface LedgerHour {
  start: number;
  afterBlock: number;
  beforeBlock: number;
  hourAfterBlock: number;
}
export const ledgerLiveTradeRows = 1_250_000;
/** The rolling hour, or null while the ring does not hold every swap since
 * the start of `start`'s UTC hour (the hour's flow and the price it opened
 * at). The age prune cannot reach that hour. An oldest row inside it is
 * complete while the ring is below its row bound, but may have lost earlier
 * swaps when the row bound is reached. An incomplete 1h serves no volume,
 * trade count or change and has `completeWindow` false. */
export async function ledgerHour(
  query: ReadQuery,
  cut: LedgerCut,
  maxRows = ledgerLiveTradeRows,
): Promise<LedgerHour | null> {
  const start = cut.asOf - windows["1h"],
    hourStart = Math.floor(start / 3600) * 3600;
  const { rows } = await query(
    `SELECT (SELECT timestamp FROM agg_live_trades WHERE chain_id=4663 ORDER BY block_number,log_index LIMIT 1) AS oldest,
      after.to_block AS after_block,before.to_block AS before_block,
      (SELECT max(to_block) FROM agg_batches WHERE chain_id=4663 AND stream_key='ledger:agg:v1' AND to_block<=$1 AND to_timestamp<$3) AS hour_after_block
    FROM (SELECT max(to_block) AS to_block FROM agg_batches WHERE chain_id=4663 AND stream_key='ledger:agg:v1' AND to_block<=$1 AND to_timestamp<$2) after
    CROSS JOIN LATERAL (SELECT min(to_block) AS to_block FROM agg_batches WHERE chain_id=4663 AND stream_key='ledger:agg:v1' AND to_block>after.to_block AND to_block<=$1) before`,
    [cut.block, start, hourStart],
  );
  const r = rows[0];
  if (!r || r.hour_after_block === null || r.before_block === null) return null;
  if (r.oldest === null || whole(r.oldest) >= hourStart) {
    const atBound = await query(
      `SELECT 1 FROM agg_live_trades WHERE chain_id=4663
       ORDER BY block_number DESC,log_index DESC OFFSET $1 LIMIT 1`,
      [maxRows - 1],
    );
    if (atBound.rows.length) return null;
  }
  return {
    start,
    afterBlock: whole(r.after_block),
    beforeBlock: whole(r.before_block),
    hourAfterBlock: whole(r.hour_after_block),
  };
}
/** How a ledger statement measures its window: `hours` sums the window's
 * whole hours from $8 (All: the pool state's lifetime totals), `ring` reads
 * the rolling hour from the live ring with $10-$13 bound to a `LedgerHour`,
 * and `none` serves no flow or change (a 1h the ring does not cover). */
export type LedgerFlow = "hours" | "ring" | "none";
export const ledgerFlow = (
  window: LiveWindow,
  hour: LedgerHour | null,
): LedgerFlow => (window !== "1h" ? "hours" : hour ? "ring" : "none");
/** The first UTC hour a window reads: the window is that many whole hours
 * ending with the newest hour, so a 24h window is hours newest-23 through
 * newest; 1h is the rolling hour, whose first hour holds its start. All has
 * no first hour; it is the pool's whole history. */
export function ledgerWindowHour(cut: LedgerCut, window: LiveWindow) {
  return window === "All"
    ? null
    : window === "1h"
      ? Math.floor((cut.asOf - windows["1h"]) / 3600)
      : Math.max(0, cut.newestHour - windows[window] / 3600 + 1);
}
/** Where a window starts: its first hour's start, or the rolling hour's own
 * start for 1h; null for All (each pool's launch). */
export const ledgerWindowStart = (cut: LedgerCut, window: LiveWindow) =>
  window === "1h"
    ? cut.asOf - windows["1h"]
    : window === "All"
      ? null
      : ledgerWindowHour(cut, window)! * 3600;
/** The ledger's statement values after the broad ones: $7 its cursor block,
 * $8 the window's first hour, $9 its start block, and for the rolling hour
 * $10-$13 its start and block bounds. */
export const ledgerValues = (
  cut: LedgerCut,
  window: LiveWindow,
  hour: LedgerHour | null,
) => [
  cut.block,
  ledgerWindowHour(cut, window),
  cut.startBlock,
  ...(ledgerFlow(window, hour) === "ring"
    ? [hour!.start, hour!.afterBlock, hour!.beforeBlock, hour!.hourAfterBlock]
    : []),
];
/** The rolling hour's trades and volume per pool from the ring: its swaps
 * at or after `start` through the cursor. `pools` further bounds the read. */
export const ledgerRingFlowSql = (
  b: { start: string; after: string; cursor: string },
  pools = "",
) =>
  `SELECT pool_ref,count(*) AS trades,sum(eth_wei) AS volume FROM agg_live_trades
    WHERE chain_id=4663 AND block_number>${b.after} AND block_number<=${b.cursor} AND timestamp>=${b.start}${pools} GROUP BY pool_ref`;
/** The price a pool's rolling hour opened at: its last swap before the
 * start, from the ring when that swap is inside the start's UTC hour, else
 * the close of its last whole hour before it (every swap of that UTC hour
 * before the start is in the ring). Probed only where `active`. */
export const ledgerRingBaselineSql = (
  poolRef: string,
  active: string,
  b: { start: string; before: string; hourAfter: string; hour: string },
) =>
  `SELECT sqrt FROM ((SELECT sqrt_price_x96 AS sqrt,0 AS source FROM agg_live_trades
      WHERE chain_id=4663 AND pool_ref=${poolRef} AND block_number>${b.hourAfter} AND block_number<=${b.before} AND timestamp<${b.start} AND ${active}
      ORDER BY block_number DESC,log_index DESC LIMIT 1)
    UNION ALL (SELECT sqrt,1 FROM (${ledgerBaselineSql(poolRef, b.hour, active)}) closed)) opened ORDER BY source LIMIT 1`;
/** The rolling hour's bounds as explore and the creators aggregate bind them. */
export const ledgerRingParams = {
  start: "$10::bigint",
  after: "$11::bigint",
  cursor: "$7",
  before: "$12::bigint",
  hourAfter: "$13::bigint",
  hour: "$8::integer",
};
/** A window's baseline probe in explore's parameters, for either flow. */
export const ledgerWindowBaselineSql = (
  flow: LedgerFlow,
  poolRef: string,
  active: string,
) =>
  flow === "ring"
    ? ledgerRingBaselineSql(poolRef, active, ledgerRingParams)
    : ledgerBaselineSql(poolRef, "$8::integer", active);
/** How far the crowd ledger stream (docs/CROWD-LAUNCHES.md) may trail the
 * main cursor and still have its pools served under it. The tip loop brings
 * it level every cycle, a few seconds after the main range commits; one tip
 * range is 760 to 2,000 blocks. A crowd lane catching up, failing or
 * switched off trails by more, and its pools then answer as unmeasured
 * rather than as figures cut at an older block under the main cutoff. */
export const crowdServedLagBlocks = 2000;
/** The crowd ledger's cursor while it is served under the main cursor, else
 * null (so no crowd launch source qualifies). One read per statement. */
const crowdCursorSql = (cursor: string) =>
  `(SELECT c.cursor_block FROM agg_streams c WHERE c.chain_id=4663 AND c.stream_key='ledger:crowd:v1'
      AND c.cursor_block BETWEEN ${cursor}::bigint-${crowdServedLagBlocks} AND ${cursor}::bigint)`;
/** A launch source the ledger serves at the main cursor: the main launch
 * lane's batches at or below it, and the crowd lane's at or below the crowd
 * ledger's cursor while that is served. `ps` prefixes the source columns. */
export const ledgerSourceSql = (ps: string, cursor: string) =>
  `(${ps}stream_key='launches:agg:v1' AND ${ps}batch_end<=${cursor}
    OR ${ps}stream_key='launches:crowd:v1' AND ${ps}batch_end<=${crowdCursorSql(cursor)})`;
/** A launch the ledger covers: launched inside the ledger's range and
 * registered by one of its launch lanes in a batch its stream has folded, so
 * every swap of the pool since launch is folded and a missing pool state is
 * a proven zero. $start and $cursor name the statement's parameters. */
export const ledgerLaunchSql = (alias: string, start: string, cursor: string) =>
  `${alias}launch_block BETWEEN ${start} AND ${cursor} AND EXISTS(SELECT 1 FROM pool_launch_sources ps
    WHERE ps.chain_id=4663 AND ps.pool_id=${alias}pool_id AND ${ledgerSourceSql("ps.", cursor)})`;
/** The display price in wei per whole token of a raw pool price state. Every
 * pool is keyed currency0 = native ETH (18 decimals) and currency1 = the
 * token (`decimals`), and `sqrtPriceX96 = sqrt(token1 raw / token0 raw) *
 * 2^96`, so one wei buys `sqrt^2 / 2^192` raw token units and one whole token
 * (10^decimals raw units) costs `2^192 * 10^decimals / sqrt^2` wei. ETH's own
 * 18 decimals are the wei unit itself. Exact numeric, truncated to the wei;
 * this is the conversion the broad and raw paths apply (`priceOf` in
 * observed-market-read.ts). A zero sqrt or unknown decimals prices nothing. */
export const ledgerPriceSql = (sqrt: string, decimals: string) =>
  `CASE WHEN ${decimals} IS NOT NULL AND ${sqrt}>0 THEN trunc(6277101735386680763835789423207666416102355444464034512896::numeric*power(10::numeric,${decimals})/(${sqrt}*${sqrt})) END`;
/** The percent change from a baseline price state to the latest, to the
 * hundredth and truncated toward zero, taken from the sqrt prices themselves:
 * the price is proportional to 1/sqrt^2, so latest/baseline - 1 is
 * (baseline^2 - latest^2) / latest^2 exactly, whatever the decimals, with no
 * rounding of either price to the wei first. */
export const ledgerChangeSql = (latest: string, baseline: string) =>
  `CASE WHEN ${latest}>0 AND ${baseline}>0 THEN div((${baseline}*${baseline}-${latest}*${latest})*10000,${latest}*${latest})/100 END`;
/** The pool's close before a window's first hour: its price state as the
 * window opens. None for All, and none for a pool whose first hour is inside
 * the window, whose change is then not served under that window's name.
 * `active` is whether the pool has an hour inside the window: only those are
 * probed, one index probe each. */
export const ledgerBaselineSql = (
  poolRef: string,
  hour: string,
  active: string,
) =>
  `SELECT close_sqrt_price_x96 AS sqrt FROM agg_pool_hours WHERE chain_id=4663 AND pool_ref=${poolRef} AND hour<${hour} AND ${active} ORDER BY hour DESC LIMIT 1`;
/** A covered pool's served change over a window whose first hour is `hour`.
 * Null for All, for unverified or conflicting decimals and for a pool with
 * no price state; exactly 0 for a pool that traded before the window and not
 * inside it, since no trade moved its price; otherwise the latest state
 * against the close before the window, null when the pool's first hour is
 * inside it rather than a change since launch labelled with the window. */
export const ledgerServedChangeSql = (c: {
  hour: string;
  decimals: string;
  conflict: string;
  latest: string;
  active: string;
  baseline: string;
}) =>
  `CASE WHEN ${c.hour} IS NULL OR ${c.decimals} IS NULL OR ${c.conflict} OR coalesce(${c.latest},0)<=0 THEN NULL
    WHEN NOT (${c.active}) THEN 0::numeric ELSE ${ledgerChangeSql(c.latest, c.baseline)} END`;
/** Whether a window's change has a baseline: the pool traded before the
 * window, either with no hour inside it or with a close before it. */
export const ledgerBaselineFoundSql = (
  latest: string,
  active: string,
  baseline: string,
) => `(${latest} IS NOT NULL AND (NOT (${active}) OR ${baseline} IS NOT NULL))`;

export interface LedgerPool {
  ref: number;
  decimals: number | null;
  /** The token's measured total supply in raw units (migration 019), or null
   * until it has been read. */
  supplyRaw: string | null;
}
/** The ledger covers this pool: its surrogate key, declared decimals and
 * measured supply. */
export async function ledgerPool(
  query: ReadQuery,
  cut: LedgerCut,
  poolId: string,
): Promise<LedgerPool | null> {
  const { rows } = await query(
    `SELECT p.pool_ref,p.decimals,p.token_total_supply_raw::text AS supply FROM indexed_pools p
    WHERE p.chain_id=4663 AND p.pool_id=$1 AND ${ledgerLaunchSql("p.", "$2", "$3")}`,
    [poolId, cut.startBlock, cut.block],
  );
  return rows[0]
    ? {
        ref: whole(rows[0].pool_ref),
        decimals: rows[0].decimals === null ? null : whole(rows[0].decimals),
        supplyRaw: rows[0].supply,
      }
    : null;
}

/** The markets `readLedgerMarket` built, so the pool route can tell that the
 * ledger served one without a field in the response. */
const ledgerMarkets = new WeakSet<ObservedMarket>();
export const servedByLedger = (market: ObservedMarket) =>
  ledgerMarkets.has(market);
/** The creator-fee flag the pool page serves with a ledger market: the
 * catalog's stored flag (migration 021, written at discovery) over the frozen
 * deep publication's, which answers for a pool written before the column
 * existed, and undefined unless one of them is a real boolean, so the
 * response omits the key rather than inventing a "Disabled". */
export function creatorFeeFlag(
  stored: unknown,
  published: unknown,
): boolean | undefined {
  if (typeof stored === "boolean") return stored;
  if (typeof published === "boolean") return published;
  return undefined;
}
export function withCreatorFees(
  market: ObservedMarket,
  creatorFees: boolean | undefined,
): ObservedMarket {
  return creatorFees === undefined ? market : { ...market, creatorFees };
}
const price = (sqrt: string) => ledgerPriceSql(sqrt, "$4::integer");
/** One pool's market from the ledger. $1 pool_ref, $2 the window's first
 * hour (null for All), $3 cutoff block, $4 decimals (null when unverified),
 * and for the rolling hour $5-$8 its start and block bounds (`LedgerHour`).
 * Trades and volume sum the window's hours, or the rolling hour's swaps in
 * the ring. Candles are the pool's hours, the
 * newest thousand: an hour opens at the previous hour's close (the price
 * state its first swap starts from) or, for the pool's first hour, at its own
 * first swap's state, and its high and low price are the lowest and highest
 * sqrt among that opening state and its swaps, the price falling as the sqrt
 * rises. Observations are the pool's newest fifty trades in the ledger's live
 * ring (its last 24 hours), all the ring still holds of them. */
const ringParams = {
  start: "$5::bigint",
  after: "$6::bigint",
  cursor: "$3",
  before: "$7::bigint",
  hourAfter: "$8::bigint",
  hour: "$2::integer",
};
const ledgerMarketSql = (ring: boolean) => `WITH flow AS (
    ${
      ring
        ? `SELECT coalesce(sum(trades),0) AS trades,coalesce(sum(volume),0) AS volume FROM (${ledgerRingFlowSql(ringParams, " AND pool_ref=$1")}) ring`
        : `SELECT coalesce(sum(trades),0) AS trades,coalesce(sum(volume_wei),0) AS volume FROM agg_pool_hours
    WHERE chain_id=4663 AND pool_ref=$1 AND hour>=coalesce($2::integer,0)`
    }
  ), hours AS (
    SELECT hour,volume_wei,open_sqrt_price_x96 AS open_sqrt,close_sqrt_price_x96 AS close_sqrt,
      low_sqrt_price_x96 AS min_sqrt,high_sqrt_price_x96 AS max_sqrt,
      lag(close_sqrt_price_x96) OVER(ORDER BY hour) AS previous_sqrt
    FROM agg_pool_hours WHERE chain_id=4663 AND pool_ref=$1
  ), priced AS (
    SELECT * FROM hours WHERE $4::integer IS NOT NULL AND min_sqrt>0
  ), history AS (
    SELECT hour*3600 AS time,
      ${price("coalesce(previous_sqrt,open_sqrt)")}::text AS open,
      ${price("least(previous_sqrt,min_sqrt)")}::text AS high,
      ${price("greatest(previous_sqrt,max_sqrt)")}::text AS low,
      ${price("close_sqrt")}::text AS close,volume_wei::text AS volume
    FROM (SELECT * FROM priced ORDER BY hour DESC LIMIT 1000) served
  ), observations AS (
    SELECT '0x'||encode(tx_hash,'hex') AS tx_hash,log_index,block_number,'0x'||encode(block_hash,'hex') AS block_hash,timestamp,side,
      eth_wei::text AS eth_wei,token_raw::text AS token_raw
    FROM agg_live_trades WHERE chain_id=4663 AND pool_ref=$1 AND block_number<=$3
    ORDER BY block_number DESC,log_index DESC LIMIT 50
  )
  SELECT flow.trades,flow.volume::text AS volume,${price("state.sqrt_price_x96")}::text AS price,
    ${ledgerBaselineFoundSql("state.sqrt_price_x96", "flow.trades>0", "baseline.sqrt")} AS baseline,
    ${ledgerServedChangeSql({ hour: "$2::integer", decimals: "$4::integer", conflict: "false", latest: "state.sqrt_price_x96", active: "flow.trades>0", baseline: "baseline.sqrt" })} AS change,
    (SELECT count(*) FROM priced)>1000 AS truncated,
    coalesce((SELECT jsonb_agg(jsonb_build_object('time',time,'open',open,'high',high,'low',low,'close',close,'volume',volume) ORDER BY time) FROM history),'[]'::jsonb) AS candles,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',tx_hash||':'||log_index,'transactionHash',tx_hash,'logIndex',log_index,'block',block_number,'blockHash',block_hash,'timestamp',timestamp,'side',side,'ethWei',eth_wei,'tokenRaw',token_raw) ORDER BY block_number DESC,log_index DESC) FROM observations),'[]'::jsonb) AS observations
  FROM flow
  LEFT JOIN agg_pool_state state ON state.chain_id=4663 AND state.pool_ref=$1
  LEFT JOIN LATERAL (${ring ? ledgerRingBaselineSql("$1", "flow.trades>0", ringParams) : ledgerBaselineSql("$1", "$2::integer", "flow.trades>0")}) baseline ON true`;

/** The pool page's market from the ledger, in the observed-market shape. The
 * ledger keeps no block hash for a pool's price states, so the baseline is
 * not published as a boundary; the unit basis is the ledger's cutoff, at
 * which its registry declares the decimals. A verified deep snapshot inside
 * the ledger's range that declares other decimals is a units conflict. */
export async function readLedgerMarket(
  query: ReadQuery,
  pool: Record<string, any>,
  window: LiveWindow,
  verifiedUnits: { decimals: number; cutoff: MarketBoundary } | null,
  cut: LedgerCut,
  covered: LedgerPool,
): Promise<ObservedMarket> {
  const launchBlock = whole(pool.launch_block),
    launchedAt = whole(pool.launched_at);
  if (cut.asOf < launchedAt) throw bad();
  const startBlock = Math.max(cut.startBlock, launchBlock),
    hour = ledgerWindowHour(cut, window),
    windowStart = ledgerWindowStart(cut, window) ?? launchedAt,
    rolling = window === "1h" ? await ledgerHour(query, cut) : null,
    flow = ledgerFlow(window, rolling);
  const unitsConflict =
    !!verifiedUnits &&
    covered.decimals !== null &&
    verifiedUnits.cutoff.block >= startBlock &&
    verifiedUnits.cutoff.block <= cut.block &&
    verifiedUnits.decimals !== covered.decimals;
  const decimals =
    unitsConflict || covered.decimals === null || covered.decimals > 36
      ? null
      : covered.decimals;
  const row = (
    await query(ledgerMarketSql(flow === "ring"), [
      covered.ref,
      hour,
      cut.block,
      decimals,
      ...(flow === "ring"
        ? [
            rolling!.start,
            rolling!.afterBlock,
            rolling!.beforeBlock,
            rolling!.hourAfterBlock,
          ]
        : []),
    ])
  ).rows[0];
  const cutoff = { block: cut.block, hash: cut.hash, asOf: cut.asOf },
    answers = flow !== "none";
  const market: ObservedMarket = {
    poolId: pool.pool_id,
    token: pool.token,
    decimals,
    priceWei: row.price,
    // FDV is the served price times the measured supply, in whole tokens.
    fdvWei:
      row.price === null || covered.supplyRaw === null || decimals === null
        ? null
        : (
            (BigInt(row.price) * BigInt(covered.supplyRaw)) /
            10n ** BigInt(decimals)
          ).toString(),
    window,
    volumeWei: answers ? row.volume : null,
    trades: answers ? whole(row.trades) : null,
    change: answers && row.change !== null ? Number(row.change) : null,
    observations: row.observations,
    coverage: {
      startBlock,
      cutoff,
      indexedAt: cut.indexedAt,
      completeWindow:
        answers &&
        startBlock === launchBlock &&
        row.price !== null &&
        decimals !== null &&
        (launchedAt >= windowStart || row.baseline),
      windowStart,
      priceBaseline: null,
      unitBasis:
        decimals === null
          ? null
          : { ...cutoff, decimals, source: "aggregate_ledger" },
      unitsConflict,
      accounting: "unavailable",
      attribution: "transaction_initiator_only",
    },
    history: {
      priceSemantics: "declared_cutoff_display_units",
      intervalSeconds: 3600,
      fromTimestamp: row.candles[0]?.time ?? null,
      truncated: row.truncated,
      candles: row.candles,
    },
  };
  assertObservedMarket(market, pool.pool_id, pool.token, window);
  ledgerMarkets.add(market);
  return market;
}
