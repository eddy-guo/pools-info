import pg from "pg";
import {
  readLeaderboard,
  readWallet,
  accountingCoverage,
} from "./accounting-read";
import { readProjectedExplore } from "./projected-explore";
import { readSearch } from "./search-read";
import { assertCatalogIdentity, catalogCte } from "./catalog-read";
import { readLiveTrades } from "./live-read";
import { poolAnalytics } from "@pools/core";
import { loadAnalyticsModel } from "./analytics-read";
import {
  encodeCursor,
  isAddress,
  RequestError,
  searchPattern,
  type ReadRequest,
} from "./request";

type Row = Record<string, any>; // PostgreSQL projections are mapped explicitly below.
type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Row[] }>;
export interface Reader {
  read(request: ReadRequest): Promise<unknown>;
  close(): Promise<void>;
}
export const limitations = {
  chainId: 4663,
  source: "indexed_chain_events",
  scope: "verified_pools_launches_only",
  completeness: "partial",
  registryExhaustive: false,
  chainHead: null,
  pnlAvailable: false,
  note: "Recorded block cutoffs are historical coverage, not proof of current-chain freshness. Transaction initiators are not proven trade beneficiaries. Token transfers can appear once per indexed pool for the same token.",
} as const;

const coverageColumns =
  "s.start_block, s.cursor_block, s.cursor_hash, s.updated_at";
const poolColumns =
  "p.pool_id, p.token, p.name, p.symbol, p.launch_block, p.launch_tx, p.launch_sender, p.launched_at, p.source_stream, p.source_batch, p.discovery_source, p.image_url, p.description, p.external_url, p.metadata_sources";
const eventColumns =
  "e.stream_key, e.pool_id, e.token, e.tx_hash, e.log_index, e.block_number, e.block_hash, e.timestamp, e.kind, e.transaction_sender, e.payload";
const eventOrder =
  "e.block_number DESC, e.log_index DESC, e.tx_hash DESC, e.stream_key DESC";
const eventPosition = "(e.block_number,e.log_index,e.tx_hash,e.stream_key)";
function coverage(r: Row) {
  return {
    startBlock: r.start_block ?? null,
    throughBlock: r.cursor_block ?? null,
    throughBlockHash: r.cursor_hash ?? null,
    indexedAt: r.updated_at ?? null,
    completeTokenLifetime: false,
  };
}
function poolItem(r: Row) {
  return {
    poolId: r.pool_id,
    token: r.token,
    name: r.name,
    symbol: r.symbol,
    imageUrl: r.image_url ?? null,
    description: r.description ?? null,
    externalUrl: r.external_url ?? null,
    metadataSources: r.metadata_sources ?? null,
    launch: {
      block: r.launch_block,
      transactionHash: r.launch_tx,
      transactionInitiator: r.launch_sender,
      timestamp: r.launched_at,
      sourceStream: r.source_stream,
      discoverySource: r.discovery_source,
      sourceBatchThroughBlock: r.source_batch,
    },
    coverage: coverage(r),
  };
}
function eventItem(r: Row) {
  return {
    id: `${r.stream_key}:${r.tx_hash}:${r.log_index}`,
    poolId: r.pool_id,
    token: r.token,
    transactionHash: r.tx_hash,
    logIndex: r.log_index,
    block: r.block_number,
    blockHash: r.block_hash,
    timestamp: r.timestamp,
    kind: r.kind,
    transactionInitiator: r.transaction_sender,
    attribution: "transaction_initiator_only",
    payload: r.payload,
    coverage: coverage(r),
  };
}
function paginate(rows: Row[], request: ReadRequest, type: "pools" | "events") {
  const page = rows.slice(0, request.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => (type === "pools" ? poolItem(r) : eventItem(r))),
    nextCursor:
      rows.length > request.limit && last
        ? encodeCursor(
            request.scope,
            type === "pools"
              ? [last.launch_block, last.pool_id]
              : [
                  last.block_number,
                  String(last.log_index),
                  last.tx_hash,
                  last.stream_key,
                ],
          )
        : null,
    pagination: "descending_keyset_eventually_consistent",
  };
}

/** Queries read one repeatable DB snapshot per response. There are no migrations
 * or write statements on this service's execution path. */
export async function readData(
  query: Query,
  request: ReadRequest,
): Promise<unknown> {
  if (request.route === "ready") {
    // Zero-row reads check table access too, unlike SELECT 1 alone.
    await query("SELECT 1 FROM indexed_events WHERE false");
    await query("SELECT 1 FROM indexed_pools WHERE false");
    await query("SELECT 1 FROM indexer_streams WHERE false");
    await query("SELECT 1 FROM analytics_pool_snapshots WHERE false");
    await query("SELECT 1 FROM recent_streams WHERE false");
    await query("SELECT 1 FROM recent_pools WHERE false");
    await query("SELECT 1 FROM recent_swaps WHERE false");
    await query("SELECT 1 FROM analytics_accounting_pools WHERE false");
    await query("SELECT 1 FROM analytics_accounting_positions WHERE false");
    await query("SELECT 1 FROM analytics_accounting_trades WHERE false");
    await query("SELECT 1 FROM analytics_accounting_prices WHERE false");
    await accountingCoverage(query);
    return { ready: true };
  }
  if (request.route === "live-trades")
    return readLiveTrades(query, request.poolId);
  const base = { coverage: limitations, generatedAt: new Date().toISOString() };
  if (request.route === "explore")
    return readProjectedExplore(query, request.explore);
  if (request.route === "leaderboard")
    return readLeaderboard(query, request.leaderboard);
  if (request.route === "profile")
    return readWallet(query, request.wallet!, request.window);
  if (request.route === "search")
    return readSearch(query, request.q, request.group);
  if (request.route === "feed") {
    const streams = await query(
      `SELECT s.stream_key, s.pool_id, ${coverageColumns}
      FROM indexer_streams s WHERE s.chain_id=4663 AND s.kind='pool' AND s.pool_id=ANY($1::text[])
      ORDER BY s.cursor_block ASC NULLS FIRST`,
      [request.pools],
    );
    if (
      streams.rows.length !== request.pools.length ||
      streams.rows.some((r) => r.cursor_block === null)
    )
      throw new RequestError(503, "feed_coverage_unavailable");
    const first = streams.rows[0];
    const toBlock = Number(first.cursor_block);
    const fromBlock = Math.max(
      toBlock - 999,
      ...streams.rows.map((r) => Number(r.start_block)),
    );
    if (
      !Number.isSafeInteger(toBlock) ||
      !Number.isSafeInteger(fromBlock) ||
      fromBlock > toBlock
    )
      throw new RequestError(503, "feed_coverage_unavailable");
    const boundary = await query(
      `SELECT b.block_hash, h.value->>'hash' AS header_hash, h.value->>'timestamp' AS timestamp
      FROM indexer_batches b CROSS JOIN LATERAL jsonb_array_elements(b.evidence->'headers') h(value)
      WHERE b.chain_id=4663 AND b.stream_key=$1 AND b.to_block=$2 AND h.value->>'number'=$3 LIMIT 1`,
      [first.stream_key, first.cursor_block, `0x${toBlock.toString(16)}`],
    );
    const header = boundary.rows[0];
    const toTimestamp = header ? Number(header.timestamp) : NaN;
    if (
      !header ||
      header.header_hash !== first.cursor_hash ||
      header.block_hash !== first.cursor_hash ||
      !/^0x[\da-f]+$/i.test(header.timestamp) ||
      !Number.isSafeInteger(toTimestamp) ||
      toTimestamp < 0
    )
      throw new RequestError(503, "feed_boundary_unavailable");
    const rows = await query(
      `SELECT ${eventColumns} FROM indexed_events e WHERE e.chain_id=4663
      AND e.kind='swap' AND e.pool_id=ANY($1::text[]) AND e.block_number BETWEEN $2 AND $3
      ORDER BY ${eventOrder} LIMIT 51`,
      [request.pools, fromBlock, toBlock],
    );
    const page = rows.rows.slice(0, 50);
    const supported = page.filter(
      (r) =>
        r.payload?.decoded &&
        typeof r.payload.decoded.amount0 === "string" &&
        typeof r.payload.decoded.amount1 === "string" &&
        /^-?\d+$/.test(r.payload.decoded.amount0) &&
        /^-?\d+$/.test(r.payload.decoded.amount1),
    );
    return {
      ...base,
      source: "indexed_chain_events",
      fromBlock,
      toBlock,
      toTimestamp,
      toBlockHash: first.cursor_hash,
      indexedAt: streams.rows
        .map((r) => new Date(r.updated_at).toISOString())
        .sort()[0],
      poolCoverage: streams.rows.map((r) => ({
        poolId: r.pool_id,
        ...coverage(r),
      })),
      events: supported.map((r) => ({
        poolId: r.pool_id,
        txHash: r.tx_hash,
        logIndex: r.log_index,
        block: Number(r.block_number),
        timestamp: Number(r.timestamp),
        amount0: r.payload.decoded.amount0,
        amount1: r.payload.decoded.amount1,
        transactionSender: r.transaction_sender,
      })),
      truncated: rows.rows.length > 50,
      omittedUnsupportedEvents: page.length - supported.length,
    };
  }
  if (request.route === "status") {
    const discovery = await query(
      `SELECT s.stream_key, ${coverageColumns} FROM indexer_streams s WHERE s.chain_id=4663 AND s.kind='discovery' ORDER BY s.stream_key LIMIT 101`,
    );
    const summary =
      await query(`SELECT count(*)::text AS streams, count(cursor_block)::text AS streams_started,
      min(cursor_block)::text AS earliest_cursor, max(cursor_block)::text AS latest_cursor,
      max(updated_at) AS last_commit_at FROM indexer_streams WHERE chain_id=4663 AND kind='pool'`);
    return {
      ...base,
      discovery: discovery.rows
        .slice(0, 100)
        .map((r) => ({ stream: r.stream_key, ...coverage(r) })),
      discoveryTruncated: discovery.rows.length > 100,
      poolStreams: summary.rows[0],
    };
  }
  if (request.route === "pools") {
    await assertCatalogIdentity(query);
    const params: unknown[] = [];
    const conditions = ["p.chain_id=4663"];
    if (request.q) {
      params.push(isAddress(request.q) ? request.q : searchPattern(request.q));
      conditions.push(
        isAddress(request.q)
          ? `p.token=$${params.length}`
          : `(p.name ILIKE $${params.length} ESCAPE '\\' OR p.symbol ILIKE $${params.length} ESCAPE '\\')`,
      );
    }
    if (request.cursor) {
      params.push(...request.cursor);
      conditions.push(
        `(p.launch_block,p.pool_id) < ($${params.length - 1}::bigint,$${params.length}::text)`,
      );
    }
    params.push(request.limit + 1);
    const result = await query(
      `${catalogCte} SELECT ${poolColumns}, ${coverageColumns} FROM catalog p
      LEFT JOIN indexer_streams s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id AND s.kind='pool'
      WHERE ${conditions.join(" AND ")} ORDER BY p.launch_block DESC,p.pool_id DESC LIMIT $${params.length}`,
      params,
    );
    return { ...base, ...paginate(result.rows, request, "pools") };
  }
  if (request.route === "pool") {
    await assertCatalogIdentity(query);
    const result = await query(
      `${catalogCte} SELECT ${poolColumns}, ${coverageColumns} FROM catalog p
      LEFT JOIN indexer_streams s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id AND s.kind='pool'
      WHERE p.chain_id=4663 AND p.pool_id=$1`,
      [request.poolId],
    );
    if (!result.rows.length) throw new RequestError(404, "pool_not_indexed");
    const latest = await query(
      `SELECT ${eventColumns}, ${coverageColumns} FROM indexed_events e
      JOIN indexer_streams s ON s.chain_id=e.chain_id AND s.stream_key=e.stream_key
      WHERE e.chain_id=4663 AND e.pool_id=$1 AND e.kind='swap' ORDER BY ${eventOrder} LIMIT 1`,
      [request.poolId],
    );
    return {
      ...base,
      pool: poolItem(result.rows[0]),
      analytics: poolAnalytics(
        await loadAnalyticsModel(query, request.poolId!),
        request.poolId!,
        request.window,
      ),
      latestRecordedSwap: latest.rows.length ? eventItem(latest.rows[0]) : null,
    };
  }
  const params: unknown[] = [];
  const conditions = ["e.chain_id=4663"];
  if (request.route === "trades") {
    conditions.push("e.kind='swap'");
    if (request.poolId) {
      params.push(request.poolId);
      conditions.push(`e.pool_id=$${params.length}`);
    }
  } else if (request.route === "wallet") {
    params.push(request.wallet);
    conditions.push(
      `(e.transaction_sender=$1 OR (e.kind='transfer' AND (e.payload->>'from'=$1 OR e.payload->>'to'=$1)))`,
    );
  } else throw new RequestError(404, "not_found");
  if (request.cursor) {
    const start = params.length;
    params.push(...request.cursor);
    conditions.push(
      `${eventPosition} < ($${start + 1}::bigint,$${start + 2}::integer,$${start + 3}::text,$${start + 4}::text)`,
    );
  }
  params.push(request.limit + 1);
  const result = await query(
    `SELECT ${eventColumns}, ${coverageColumns} FROM indexed_events e
    JOIN indexer_streams s ON s.chain_id=e.chain_id AND s.stream_key=e.stream_key
    WHERE ${conditions.join(" AND ")} ORDER BY ${eventOrder} LIMIT $${params.length}`,
    params,
  );
  return {
    ...base,
    ...(request.wallet
      ? {
          wallet: request.wallet,
          activityMeaning: "transaction_initiator_or_transfer_participant",
        }
      : {}),
    ...paginate(result.rows, request, "events"),
  };
}

export function createReader(
  url = process.env.DATABASE_URL,
  testSchema?: string,
): Reader {
  if (!url) throw Error("DATABASE_URL is required");
  if (testSchema && !/^api_test_[a-z0-9_]+$/.test(testSchema))
    throw Error("Invalid test schema");
  const pool = new pg.Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    query_timeout: 4000,
    application_name: "pools-read-api",
    options:
      "-c default_transaction_read_only=on" +
      (testSchema ? ` -c search_path=${testSchema}` : ""),
  });
  // Idle connection errors must not terminate the server or expose credentials.
  pool.on("error", () =>
    process.stderr.write('{"event":"idle_database_connection_error"}\n'),
  );
  return {
    async read(request) {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL statement_timeout = '3000ms'");
        const result = await readData(
          (sql, values) => client.query(sql, values),
          request,
        );
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          broken = true;
        }
        throw error;
      } finally {
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
