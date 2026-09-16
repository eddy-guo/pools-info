import {
  InitiatorLedger,
  type AnalyticsCoverage,
  type AnalyticsWalletPosition,
  type AnalyticsWalletSummary,
  type LiveWindow,
  type ObservedExecution,
} from "@pools/core";
import { catalogCte, type ReadQuery } from "./catalog-read";
import { RequestError } from "./request";

// Only surviving own ranges participate. A deep publication owns its entire
// pool book, so tx.from and Transfer beneficiary basis are never blended.
const evidenceCte = `${catalogCte}, ranges AS MATERIALIZED (
  SELECT b.from_block,b.to_block,b.block_hash,b.to_timestamp AS timestamp,'recent' AS source,b.stream_key,
    b.block_hash ~ '^0x[0-9a-f]{64}$' AND b.to_timestamp>=0
      AND (b.unsupported_swaps=0 OR jsonb_array_length(coalesce(b.evidence->'logs','[]'::jsonb))>0) AS valid
  FROM recent_batches b JOIN recent_streams s USING(chain_id,stream_key)
  JOIN recent_batches tip ON tip.chain_id=s.chain_id AND tip.stream_key=s.stream_key AND tip.to_block=s.cursor_block
    AND tip.block_hash=s.cursor_hash AND tip.to_timestamp=s.cursor_timestamp
  JOIN recent_streams discovery ON discovery.chain_id=s.chain_id AND discovery.stream_key='discovery' AND discovery.cursor_block>=s.cursor_block
  JOIN recent_batches discovery_tip ON discovery_tip.chain_id=discovery.chain_id AND discovery_tip.stream_key=discovery.stream_key
    AND discovery_tip.to_block=discovery.cursor_block AND discovery_tip.block_hash=discovery.cursor_hash AND discovery_tip.to_timestamp=discovery.cursor_timestamp
  WHERE b.chain_id=4663 AND b.stream_key='swaps' AND b.from_block>=s.start_block AND b.to_block<=s.cursor_block
  UNION ALL
  SELECT b.from_block,b.batch_end,ib.block_hash,b.timestamp,'broad',b.stream_key,
    d.block_hash=b.discovery_hash AND d.content_hash=b.discovery_content_hash AND b.from_block=ib.from_block
      AND ib.block_hash ~ '^0x[0-9a-f]{64}$' AS valid
  FROM broad_batches b JOIN indexer_batches ib ON ib.chain_id=b.chain_id AND ib.stream_key=b.stream_key AND ib.to_block=b.batch_end
  JOIN indexer_streams s ON s.chain_id=ib.chain_id AND s.stream_key=ib.stream_key AND s.kind='broad'
  JOIN indexer_batches tip ON tip.chain_id=s.chain_id AND tip.stream_key=s.stream_key AND tip.to_block=s.cursor_block AND tip.block_hash=s.cursor_hash
  LEFT JOIN indexer_batches d ON d.chain_id=b.chain_id AND d.stream_key=b.discovery_stream AND d.to_block=b.discovery_batch
  WHERE b.chain_id=4663 AND b.from_block>=s.start_block AND b.batch_end<=s.cursor_block
), activity_pools AS MATERIALIZED (
  SELECT DISTINCT e.pool_id FROM recent_swaps e JOIN ranges r ON r.source='recent' AND r.stream_key=e.source_stream AND r.to_block=e.batch_end
    WHERE e.chain_id=4663
  UNION
  SELECT DISTINCT e.pool_id FROM broad_swaps e JOIN ranges r ON r.source='broad' AND r.stream_key=e.stream_key AND r.to_block=e.batch_end
    WHERE e.chain_id=4663
), merged AS (SELECT unnest(range_agg(int8range(from_block,to_block+1,'[)'))) AS span FROM ranges),
boundaries AS (SELECT to_block,min(block_hash) AS block_hash,min(timestamp) AS timestamp FROM ranges GROUP BY to_block),
unsupported_pools AS MATERIALIZED (
  SELECT DISTINCT logs.pool_id FROM (
    SELECT b.to_block,log->'topics'->>1 AS pool_id,count(*) AS count
    FROM recent_batches b JOIN ranges r ON r.source='recent' AND r.stream_key=b.stream_key AND r.to_block=b.to_block
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.evidence->'logs','[]'::jsonb)) log
    WHERE b.chain_id=4663 AND b.unsupported_swaps>0 GROUP BY b.to_block,log->'topics'->>1
  ) logs WHERE logs.count>(SELECT count(*) FROM recent_swaps e WHERE e.chain_id=4663 AND e.source_stream='swaps' AND e.batch_end=logs.to_block AND e.pool_id=logs.pool_id)
),
books AS MATERIALIZED (
  SELECT c.*,lower(m.span) AS start_block,upper(m.span)-1 AS through_block,r.timestamp AS asof,r.block_hash AS through_hash,
    EXISTS(SELECT 1 FROM unsupported_pools u WHERE u.pool_id=c.pool_id) AS unsupported_history,
    (CASE WHEN c.discovery_source='recent_discovery' THEN EXISTS(
      SELECT 1 FROM recent_batches source WHERE source.chain_id=c.chain_id AND source.stream_key='discovery' AND source.to_block=c.source_batch
      AND c.launch_block BETWEEN source.from_block AND source.to_block AND c.launched_at<=source.to_timestamp)
    ELSE EXISTS(SELECT 1 FROM indexer_batches source WHERE source.chain_id=c.chain_id AND source.stream_key=c.source_stream AND source.to_block=c.source_batch
      AND c.launch_block BETWEEN source.from_block AND source.to_block) END) AS catalog_valid
  FROM activity_pools activity JOIN catalog c USING(pool_id) JOIN merged m ON upper(m.span)>c.launch_block
  JOIN boundaries r ON r.to_block=upper(m.span)-1
  WHERE NOT EXISTS(SELECT 1 FROM analytics_accounting_pools a WHERE a.chain_id=c.chain_id AND a.pool_id=c.pool_id)
    AND NOT EXISTS(SELECT 1 FROM merged newer WHERE upper(newer.span)>upper(m.span) AND upper(newer.span)>c.launch_block)
), copies AS MATERIALIZED (
  SELECT e.pool_id,e.token,e.tx_hash,e.log_index,e.block_number,e.block_hash,e.timestamp,e.transaction_sender,e.side,
    e.eth_wei::text,e.token_raw::text,e.amount0::text,e.amount1::text,
    b.catalog_valid AND e.token=b.token AND e.block_number BETWEEN greatest(b.launch_block,r.from_block) AND r.to_block
      AND e.timestamp BETWEEN b.launched_at AND r.timestamp AND (e.block_number<>r.to_block OR e.block_hash=r.block_hash)
      AND (member.identity->>'pool_id',member.identity->>'token',member.identity->>'launch_block',member.identity->>'launch_tx',member.identity->>'launch_sender',member.identity->>'launched_at')
        IS NOT DISTINCT FROM (b.pool_id,b.token,b.launch_block::text,b.launch_tx,b.launch_sender,b.launched_at::text)
      AND source.block_hash=member.identity->>'source_hash' AND source.content_hash=member.identity->>'source_content_hash' AS valid,'broad' AS source
  FROM broad_swaps e JOIN books b USING(chain_id,pool_id) JOIN ranges r ON r.source='broad' AND r.stream_key=e.stream_key AND r.to_block=e.batch_end
  JOIN broad_registry_members member ON member.chain_id=e.chain_id AND member.stream_key=e.stream_key AND member.batch_end=e.batch_end AND member.pool_id=e.pool_id
  LEFT JOIN pool_launch_sources ps ON ps.chain_id=e.chain_id AND ps.pool_id=e.pool_id AND ps.stream_key='discovery:v2' AND ps.batch_end::text=member.identity->>'source_batch'
  LEFT JOIN indexer_batches source ON source.chain_id=ps.chain_id AND source.stream_key=ps.stream_key AND source.to_block=ps.batch_end
  WHERE e.chain_id=4663 AND e.block_number BETWEEN b.start_block AND b.through_block
  UNION ALL
  SELECT e.pool_id,e.token,e.tx_hash,e.log_index,e.block_number,e.block_hash,e.timestamp,e.transaction_sender,e.side,
    -- Keep exact stored strings on the hot path. JavaScript validates every
    -- amount before folding; numeric normalization is only needed for the
    -- cross-source comparison below, rather than every observed execution.
    e.eth_wei,e.token_raw,e.amount0,e.amount1,
    b.catalog_valid AND e.token=b.token AND e.block_number BETWEEN greatest(b.launch_block,r.from_block) AND r.to_block
      AND e.timestamp BETWEEN b.launched_at AND r.timestamp AND (e.block_number<>r.to_block OR e.block_hash=r.block_hash) AS valid,'recent' AS source
  FROM recent_swaps e JOIN books b USING(chain_id,pool_id) JOIN ranges r ON r.source='recent' AND r.stream_key=e.source_stream AND r.to_block=e.batch_end
  WHERE e.chain_id=4663 AND e.block_number BETWEEN b.start_block AND b.through_block
), broad_copies AS MATERIALIZED (SELECT * FROM copies WHERE source='broad'),
conflicts AS MATERIALIZED (
  -- Reconcile surviving source identities before eligibility can discard a
  -- changed pool. A collision affecting an eligible book must have both valid
  -- copies; otherwise a moved/invalid copy could conceal the conflict.
  SELECT raw_b.tx_hash,raw_b.log_index FROM broad_swaps raw_b
  JOIN ranges broad_range ON broad_range.source='broad' AND broad_range.stream_key=raw_b.stream_key AND broad_range.to_block=raw_b.batch_end
  JOIN recent_swaps raw_r ON raw_r.chain_id=raw_b.chain_id AND raw_r.tx_hash=raw_b.tx_hash AND raw_r.log_index=raw_b.log_index
  JOIN ranges recent_range ON recent_range.source='recent' AND recent_range.stream_key=raw_r.source_stream AND recent_range.to_block=raw_r.batch_end
  LEFT JOIN broad_copies b ON b.tx_hash=raw_b.tx_hash AND b.log_index=raw_b.log_index
  LEFT JOIN copies r ON r.source='recent' AND r.tx_hash=raw_r.tx_hash AND r.log_index=raw_r.log_index
  WHERE raw_b.chain_id=4663 AND (b.tx_hash IS NOT NULL OR r.tx_hash IS NOT NULL)
    AND (b.tx_hash IS NULL OR r.tx_hash IS NULL OR r.valid IS NOT TRUE OR b.valid IS NOT TRUE OR
    ROW(b.pool_id,b.token,b.block_number,b.block_hash,b.timestamp,b.transaction_sender,b.side,b.eth_wei,b.token_raw,b.amount0,b.amount1)
    IS DISTINCT FROM ROW(r.pool_id,r.token,r.block_number,r.block_hash,r.timestamp,r.transaction_sender,r.side,
      CASE WHEN r.eth_wei ~ '^[1-9][0-9]{0,95}$' THEN r.eth_wei::numeric::text ELSE r.eth_wei END,
      CASE WHEN r.token_raw ~ '^[1-9][0-9]{0,95}$' THEN r.token_raw::numeric::text ELSE r.token_raw END,
      CASE WHEN r.amount0 ~ '^-?[0-9]{1,96}$' THEN r.amount0::numeric::text ELSE r.amount0 END,
      CASE WHEN r.amount1 ~ '^-?[0-9]{1,96}$' THEN r.amount1::numeric::text ELSE r.amount1 END))
), canonical AS (
  -- Each normalized source has a unique (chain,tx,log) key. Only cross-source
  -- copies require reconciliation, avoiding a whole-history GROUP BY.
  SELECT c.*,c.transaction_sender AS wallet,EXISTS(SELECT 1 FROM conflicts conflict WHERE conflict.tx_hash=c.tx_hash AND conflict.log_index=c.log_index) AS conflict
  FROM copies c WHERE c.source='broad' OR NOT EXISTS(SELECT 1 FROM broad_copies b WHERE b.tx_hash=c.tx_hash AND b.log_index=c.log_index)
)`;
export interface Tier2Result {
  summaries: Map<string, AnalyticsWalletSummary>;
  costs: Map<string, bigint>;
  positions: AnalyticsWalletPosition[];
  trades: (ObservedExecution & { symbol: string; poolId: string })[];
  gains: { time: number; wei: string }[];
  pools: number;
  realizedPools: number;
  asOf: number;
  curveSampled: boolean;
  startTimestamp: number | null;
}
function compactGains(points: { time: number; wei: string }[]) {
  if (points.length <= 498) return false;
  for (let i = 0; i < points.length - 1; i += 2)
    points[i + 1] = {
      time: points[i + 1].time,
      wei: (BigInt(points[i].wei) + BigInt(points[i + 1].wei)).toString(),
    };
  const compacted = points.filter(
    (_, i) => i % 2 === 1 || (i === points.length - 1 && i % 2 === 0),
  );
  points.splice(0, points.length, ...compacted);
  return true;
}
export async function readTier2(
  query: ReadQuery,
  coverage: AnalyticsCoverage,
  window: LiveWindow,
  address?: string,
): Promise<Tier2Result> {
  const started = Date.now();
  const rangeInfo = (
    await query(`${evidenceCte} SELECT count(DISTINCT pool_id)::integer AS pools,coalesce(max(asof),0)::text AS asof,
    EXISTS(SELECT 1 FROM ranges GROUP BY to_block HAVING count(DISTINCT ROW(block_hash,timestamp))>1) AS cutoff_conflict,
    EXISTS(SELECT 1 FROM ranges WHERE valid IS NOT TRUE) AS source_invalid,
    jsonb_agg(jsonb_build_object('pool_id',pool_id,'start_block',start_block,'through_block',through_block,'asof',asof,
      'through_hash',through_hash,'token',token,'symbol',symbol,'launch_tx',launch_tx,'launch_block',launch_block,'launched_at',launched_at,'unsupported_history',unsupported_history)) AS metadata FROM books`)
  ).rows[0];
  if (rangeInfo.cutoff_conflict)
    throw new RequestError(503, "tier2_identity_conflict");
  if (rangeInfo.source_invalid)
    throw new RequestError(503, "tier2_source_invalid");
  const asOf = Math.max(coverage.asOf, Number(rangeInfo.asof));
  const duration = {
    "1h": 3600,
    "6h": 21600,
    "24h": 86400,
    "7d": 604800,
    "30d": 2592000,
    All: Infinity,
  }[window];
  const from = window === "All" ? -1 : asOf - duration;
  const result: Tier2Result = {
    summaries: new Map(),
    costs: new Map(),
    positions: [],
    trades: [],
    gains: [],
    pools: 0,
    realizedPools: 0,
    asOf,
    curveSampled: false,
    startTimestamp: null,
  };
  if (!Number(rangeInfo.pools)) return result;
  const realizedPools = new Set<string>();
  const observedPools = new Set<string>();
  const metadata = new Map<string, Record<string, any>>(
    (rangeInfo.metadata ?? []).map((book: Record<string, any>) => [
      book.pool_id,
      book,
    ]),
  );
  let ledger: InitiatorLedger | null = null,
    meta: Record<string, any> | null = null;
  let pendingGains: { time: number; wei: string }[] = [];
  let pendingTrades: Tier2Result["trades"] = [];
  const finish = () => {
    if (!ledger || !meta) return;
    const p = ledger.finish(),
      wallet = ledger.wallet;
    const known = p.realizedWei !== null;
    observedPools.add(meta.pool_id);
    if (known) realizedPools.add(meta.pool_id);
    const s =
      result.summaries.get(wallet) ??
      ({
        address: wallet,
        rank: null,
        realizedWei: null,
        unrealizedWei: null,
        netWei: "0",
        volumeWei: "0",
        roi: null,
        wins: 0,
        losses: 0,
        winRate: null,
        tradeCount: 0,
        supportedTradeCount: 0,
        supportedPositionCount: 0,
        excludedPositionCount: 0,
        bestWei: null,
        avgHold: null,
        last: null,
        asOf: null,
        oldestAsOf: null,
        completeWindow: true,
        accountingTier: "tier2",
        attribution: "transaction_initiator_only",
        flags: [],
        tier2PositionCount: 0,
        tier3PositionCount: 0,
        realizedPositionCount: 0,
        rankingTradeCount: 0,
      } satisfies AnalyticsWalletSummary);
    s.tier2PositionCount!++;
    if (!known) s.excludedPositionCount++;
    s.tradeCount += p.tradeCount;
    s.volumeWei = (BigInt(s.volumeWei) + BigInt(p.volumeWei)).toString();
    s.netWei = (BigInt(s.netWei ?? "0") + BigInt(p.netWei)).toString();
    s.flags = [...new Set([...s.flags!, ...p.flags])];
    s.asOf = Math.max(s.asOf ?? 0, Number(meta.asof));
    s.oldestAsOf = Math.min(s.oldestAsOf ?? Infinity, Number(meta.asof));
    s.completeWindow = s.completeWindow && known && Number(meta.asof) >= asOf;
    s.last = p.last === null ? s.last : Math.max(s.last ?? 0, p.last);
    if (known) {
      s.realizedPositionCount!++;
      s.rankingTradeCount! += p.tradeCount;
      s.realizedWei = (
        BigInt(s.realizedWei ?? "0") + BigInt(p.realizedWei!)
      ).toString();
      const cost =
        (result.costs.get(wallet) ?? 0n) + BigInt(p.disposedCostWei!);
      result.costs.set(wallet, cost);
      s.roi =
        cost > 0n
          ? Number((BigInt(s.realizedWei) * 1000000n) / cost) / 10000
          : null;
      s.wins += p.wins;
      s.losses += p.losses;
      s.winRate =
        s.wins + s.losses ? (s.wins / (s.wins + s.losses)) * 100 : null;
      if (
        p.bestWei !== null &&
        (s.bestWei === null || BigInt(p.bestWei) > BigInt(s.bestWei))
      )
        s.bestWei = p.bestWei;
    }
    result.summaries.set(wallet, s);
    if (result.summaries.size > 100000)
      throw new RequestError(503, "tier2_materialization_limit");
    if (wallet === address) {
      if (known)
        result.startTimestamp = Math.min(
          result.startTimestamp ?? Infinity,
          Number(meta.launched_at),
        );
      if (result.positions.length < 501)
        result.positions.push({
          poolId: meta.pool_id,
          token: meta.token,
          symbol: meta.symbol,
          decimals: null,
          launchTx: meta.launch_tx,
          asOf: Number(meta.asof),
          throughBlock: Number(meta.through_block),
          supported: false,
          flags: p.flags,
          realizedWei: p.realizedWei,
          unrealizedWei: null,
          netWei: p.netWei,
          volumeWei: p.volumeWei,
          position: null,
          modeledPosition: known ? p.position : null,
          accountingTier: "tier2",
          attribution: "transaction_initiator_only",
        });
      if (known) {
        result.gains.push(...pendingGains);
        result.gains.sort((a, b) => a.time - b.time);
        result.curveSampled = compactGains(result.gains) || result.curveSampled;
      }
      result.trades.push(...pendingTrades);
      result.trades.sort(
        (a, b) =>
          b.trade.block - a.trade.block || b.trade.logIndex - a.trade.logIndex,
      );
      result.trades = result.trades.slice(0, 501);
    }
    pendingGains = [];
    pendingTrades = [];
  };
  // A transaction-scoped read cursor executes the canonical aggregation once.
  // Fetch batches bound chain evidence memory without truncating accounting.
  await query(
    `DECLARE tier2_ledger NO SCROLL CURSOR FOR ${evidenceCte} SELECT * FROM canonical ORDER BY pool_id,wallet,block_number,log_index,tx_hash`,
  );
  for (;;) {
    if (Date.now() - started > 2800)
      throw new RequestError(503, "tier2_read_budget_exceeded");
    const rows = (await query("FETCH FORWARD 2048 FROM tier2_ledger")).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const r = row;
      const book = metadata.get(r.pool_id);
      if (!book) throw new RequestError(503, "tier2_evidence_invalid");
      if (r.conflict) throw new RequestError(503, "tier2_identity_conflict");
      if (
        !r.valid ||
        !/^0x[0-9a-f]{40}$/.test(r.wallet) ||
        !/^0x[0-9a-f]{64}$/.test(r.block_hash) ||
        !/^0x[0-9a-f]{64}$/.test(r.tx_hash) ||
        Number(r.timestamp) > Number(book.asof) ||
        Number(r.timestamp) < Number(book.launched_at) ||
        (Number(r.block_number) === Number(book.through_block) &&
          r.block_hash !== book.through_hash)
      )
        throw new RequestError(503, "tier2_evidence_invalid");
      if (
        !ledger ||
        ledger.poolId !== r.pool_id ||
        ledger.wallet !== r.wallet
      ) {
        finish();
        meta = book;
        ledger = new InitiatorLedger(
          r.pool_id,
          r.wallet,
          from,
          Number(book.start_block) <= Number(book.launch_block),
        );
        if (book.unsupported_history)
          ledger.invalidate("unsupported_swap_history");
      }
      if (r.side === null) {
        ledger.invalidate("unsupported_swap_history");
        continue;
      }
      if (
        !/^[1-9][0-9]{0,95}$/.test(r.eth_wei) ||
        !/^[1-9][0-9]{0,95}$/.test(r.token_raw) ||
        !/^-?[0-9]{1,96}$/.test(r.amount0) ||
        !/^-?[0-9]{1,96}$/.test(r.amount1)
      )
        throw new RequestError(503, "tier2_evidence_invalid");
      const eth = BigInt(r.eth_wei),
        tok = BigInt(r.token_raw),
        a0 = BigInt(r.amount0),
        a1 = BigInt(r.amount1);
      if (
        eth <= 0n ||
        tok <= 0n ||
        !(
          (r.side === "buy" && a0 === -eth && a1 === tok) ||
          (r.side === "sell" && a0 === eth && a1 === -tok)
        )
      )
        throw new RequestError(503, "tier2_evidence_invalid");
      const trade = {
        id: r.tx_hash + ":" + r.log_index,
        poolId: r.pool_id,
        trader: r.wallet,
        txHash: r.tx_hash,
        logIndex: Number(r.log_index),
        block: Number(r.block_number),
        timestamp: Number(r.timestamp),
        side: r.side,
        ethWei: eth.toString(),
        tokenRaw: tok.toString(),
      };
      const gain = ledger.add(trade);
      if (r.wallet === address) {
        if (gain) {
          pendingGains.push({ time: gain.timestamp, wei: gain.wei });
          result.curveSampled =
            compactGains(pendingGains) || result.curveSampled;
        }
        if (trade.timestamp >= from) {
          pendingTrades.push({
            trade,
            flags: [...ledger.flags],
            matchedTransfer: null,
            symbol: book.symbol,
            poolId: r.pool_id,
          });
          if (pendingTrades.length > 501) pendingTrades.shift();
        }
      }
    }
  }
  await query("CLOSE tier2_ledger");
  finish();
  result.realizedPools = realizedPools.size;
  result.pools = observedPools.size;
  return result;
}
