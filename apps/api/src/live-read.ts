import type { LiveTradeEvent, LiveTradeFeedResponse } from "@pools/core";
import {
  assertCatalogIdentity,
  catalogCte,
  type ReadQuery,
} from "./catalog-read";
import { RequestError } from "./request";

const staleAfterSeconds = 120;
function number(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RequestError(503, "recent_evidence_invalid");
  return n;
}
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value as string);
  if (!Number.isFinite(date.getTime()))
    throw new RequestError(503, "recent_evidence_invalid");
  return date.toISOString();
}

/** Call inside a repeatable-read transaction: the cutoff and its rows must be
 * one canonical publication. There are no RPC calls or PnL in this read model. */
export async function readLiveTrades(
  query: ReadQuery,
  poolId: string | null,
  now = Date.now(),
): Promise<LiveTradeFeedResponse> {
  await assertCatalogIdentity(query);
  const { rows: streams } =
    await query(`SELECT s.stream_key,s.start_block,s.cursor_block,s.cursor_hash,
    s.cursor_timestamp,s.head_block,s.head_timestamp,s.checked_at,b.block_hash AS boundary_hash,b.to_timestamp AS boundary_timestamp
    FROM recent_streams s LEFT JOIN recent_batches b ON b.chain_id=s.chain_id
      AND b.stream_key=s.stream_key AND b.to_block=s.cursor_block
    WHERE s.chain_id=4663 AND s.stream_key IN ('discovery','swaps')`);
  for (const stream of streams) {
    if (
      stream.cursor_block !== null &&
      (!/^0x[0-9a-f]{64}$/.test(stream.cursor_hash) ||
        stream.boundary_hash !== stream.cursor_hash ||
        number(stream.boundary_timestamp) !== number(stream.cursor_timestamp))
    )
      throw new RequestError(503, "recent_boundary_unavailable");
  }
  const count = await query(
    `${catalogCte} SELECT count(*)::text AS count FROM catalog`,
  );
  const swaps = streams.find((s) => s.stream_key === "swaps");
  const discovery = streams.find((s) => s.stream_key === "discovery");
  const throughBlock = number(swaps?.cursor_block);
  const discoveryThroughBlock = number(discovery?.cursor_block);
  const headBlock = number(swaps?.head_block);
  const discoveryHead = number(discovery?.head_block);
  const asOf = number(swaps?.cursor_timestamp);
  const checkedAt = iso(swaps?.checked_at);
  const initialized =
    throughBlock !== null &&
    asOf !== null &&
    !!swaps?.cursor_hash &&
    discoveryThroughBlock !== null;
  const seconds = now / 1000;
  const fresh = (stream: typeof swaps) => {
    const checked = iso(stream?.checked_at);
    const cutoff = number(stream?.cursor_timestamp);
    const headTime = number(stream?.head_timestamp);
    const head = number(stream?.head_block),
      cursor = number(stream?.cursor_block);
    return (
      checked !== null &&
      cutoff !== null &&
      headTime !== null &&
      head !== null &&
      cursor !== null &&
      cursor <= head &&
      seconds - Date.parse(checked) / 1000 <= staleAfterSeconds &&
      seconds - cutoff <= staleAfterSeconds &&
      seconds - headTime <= staleAfterSeconds &&
      cutoff <= seconds + 30 &&
      headTime <= seconds + 30 &&
      Date.parse(checked) <= now + 30000
    );
  };
  const response: LiveTradeFeedResponse = {
    source: "indexed_recent_chain_events",
    generatedAt: new Date(now).toISOString(),
    poolId,
    events: [],
    truncated: false,
    replacement: true,
    coverage: {
      state: !initialized
        ? "uninitialized"
        : fresh(swaps) && fresh(discovery)
          ? "current"
          : "stale",
      scope: "verified_pools_launches_only",
      registryExhaustive: false,
      pnlAvailable: false,
      startBlock: number(swaps?.start_block),
      headBlock,
      throughBlock,
      throughHash: swaps?.cursor_hash ?? null,
      asOf,
      checkedAt,
      lagBlocks:
        headBlock !== null && throughBlock !== null
          ? Math.max(0, headBlock - throughBlock)
          : null,
      discoveryThroughBlock,
      discoveryLagBlocks:
        discoveryHead !== null && discoveryThroughBlock !== null
          ? Math.max(0, discoveryHead - discoveryThroughBlock)
          : null,
      knownPools: Number(count.rows[0].count),
      staleAfterSeconds,
    },
  };
  // Never substitute the historical stream for an uninitialized recent stream.
  if (!initialized) return response;
  if (throughBlock > discoveryThroughBlock)
    throw new RequestError(503, "recent_discovery_behind_swaps");
  const result = await query(
    `${catalogCte}
    SELECT e.pool_id,e.token,p.name,p.symbol,p.launch_tx,e.tx_hash,e.log_index,e.block_number,e.block_hash,
      e.timestamp,e.transaction_sender,e.eth_wei,e.token_raw,e.side
    FROM recent_swaps e JOIN catalog p ON p.chain_id=e.chain_id AND p.pool_id=e.pool_id AND p.token=e.token
    WHERE e.chain_id=4663 AND e.block_number BETWEEN $1 AND $2
      ${poolId ? "AND e.pool_id=$3" : ""}
    ORDER BY e.block_number DESC,e.log_index DESC,e.tx_hash DESC LIMIT 51`,
    poolId
      ? [swaps.start_block, throughBlock, poolId]
      : [swaps.start_block, throughBlock],
  );
  response.truncated = result.rows.length > 50;
  response.events = result.rows.slice(0, 50).map((r): LiveTradeEvent => {
    const block = number(r.block_number)!,
      timestamp = number(r.timestamp)!;
    const validHash = (value: unknown) =>
      typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
    const validAddress = (value: unknown) =>
      typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
    const positiveAmount = (value: unknown) =>
      typeof value === "string" &&
      /^[1-9][0-9]{0,77}$/.test(value) &&
      BigInt(value) < 2n ** 256n;
    if (
      !validHash(r.tx_hash) ||
      !validHash(r.pool_id) ||
      !validHash(r.block_hash) ||
      !validHash(r.launch_tx) ||
      !validAddress(r.token) ||
      (r.transaction_sender !== null && !validAddress(r.transaction_sender)) ||
      !positiveAmount(r.eth_wei) ||
      !positiveAmount(r.token_raw) ||
      !["buy", "sell"].includes(r.side) ||
      !Number.isSafeInteger(r.log_index) ||
      r.log_index < 0 ||
      timestamp > asOf! ||
      block > throughBlock ||
      block < Number(swaps.start_block)
    )
      throw new RequestError(503, "recent_evidence_invalid");
    return {
      id: `${r.tx_hash}:${r.log_index}`,
      poolId: r.pool_id,
      token: r.token,
      name: r.name,
      symbol: r.symbol,
      launchTx: r.launch_tx,
      transactionHash: r.tx_hash,
      logIndex: r.log_index,
      block,
      blockHash: r.block_hash,
      timestamp,
      transactionInitiator: r.transaction_sender,
      attribution: "transaction_initiator_only",
      ethWei: r.eth_wei,
      tokenRaw: r.token_raw,
      side: r.side,
    };
  });
  return response;
}
