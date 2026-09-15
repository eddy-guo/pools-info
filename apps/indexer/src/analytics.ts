import {
  Rpc,
  RpcRateLimitExhausted,
  auditPool,
  contracts,
  decodeLaunch,
  getInstantDeployment,
  decodeSwap,
  spotPriceWei,
  swapEvent,
  transferEvent,
  type RawLog,
  type Receipt,
  type EventHeader,
} from "@pools/chain";
import { throwIfRateLimitExhausted } from "./rpc-operations";
import {
  buildHolderLedger,
  type ChainSnapshot,
  type ChainTrade,
  type HolderLedger,
} from "@pools/core";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import type { Client } from "@pools/db";
import {
  backfillAccountingRows,
  replaceAccountingRows,
} from "./accounting-projection";

const hex = (n: number): Hex => `0x${n.toString(16)}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const hash = (s: unknown): s is string =>
  typeof s === "string" && /^0x[\da-f]{64}$/i.test(s);
const address = (s: unknown): s is string =>
  typeof s === "string" && /^0x[\da-f]{40}$/i.test(s);
const MAX_BYTES = 32 * 1024 * 1024;
export interface AnalyticsInput {
  poolId: string;
  token: string;
  name: string;
  symbol: string;
  launchBlock: number;
  launchTx: string;
  fromBlock: number;
  toBlock: number;
  blockHash: string;
  launchLog: RawLog;
  launchReceipt: Receipt;
  swapLogs: RawLog[];
  transferLogs: RawLog[];
  receipts: Receipt[];
  headers: EventHeader[];
  source:
    | { kind: "indexed"; stream: string; batch: number }
    | { kind: "rpc_capture" };
}
export interface AnalyticsResult {
  snapshot: ChainSnapshot;
  holders: HolderLedger | null;
  liquidityWei: null;
  evidence: {
    tokenBirthVerified: boolean;
    unsupportedSwaps: number;
    holderError: string | null;
    source: AnalyticsInput["source"];
  };
}
function limited(input: AnalyticsInput) {
  if (
    !hash(input.poolId) ||
    !address(input.token) ||
    !hash(input.blockHash) ||
    !hash(input.launchTx) ||
    !Number.isSafeInteger(input.launchBlock) ||
    input.launchBlock < 1 ||
    input.fromBlock !== input.launchBlock ||
    !Number.isSafeInteger(input.toBlock) ||
    input.toBlock < input.fromBlock ||
    input.swapLogs.length > 4000 ||
    input.transferLogs.length > 20000 ||
    Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES
  )
    throw Error("analytics_input_out_of_bounds");
}
function unique<T>(rows: T[], identity: (row: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const row of rows) {
    const key = identity(row);
    if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(row))
      throw Error("analytics_conflicting_evidence");
    seen.set(key, row);
  }
  return [...seen.values()];
}
async function canonical(rpc: Rpc, n: number) {
  const h = await rpc.call<EventHeader>("eth_getBlockByNumber", [
    hex(n),
    false,
  ]);
  if (
    !h ||
    Number(h.number) !== n ||
    !hash(h.hash) ||
    !Number.isSafeInteger(Number(h.timestamp)) ||
    Number(h.timestamp) < 0
  )
    throw Error("analytics_invalid_header");
  return h;
}
function receiptMatches(log: RawLog, receipt: Receipt) {
  return (
    receipt &&
    receipt.status === "0x1" &&
    address(receipt.from) &&
    same(receipt.transactionHash, log.transactionHash) &&
    same(receipt.blockHash, log.blockHash) &&
    receipt.logs.some(
      (l) =>
        !l.removed &&
        same(l.address, log.address) &&
        Number(l.logIndex) === Number(log.logIndex) &&
        same(l.transactionHash, log.transactionHash) &&
        same(l.blockHash, log.blockHash) &&
        Number(l.blockNumber) === Number(log.blockNumber) &&
        same(l.data, log.data) &&
        same(l.topics.join(), log.topics.join()),
    )
  );
}
/** Reconstructs one pool from birth-contiguous evidence. Pages never invoke this.
 * Failed projection leaves the previous dated publication intact. */
export async function projectAnalytics(
  input: AnalyticsInput,
  rpc: Rpc,
): Promise<AnalyticsResult> {
  const started = Date.now();
  limited(input);
  if (Number(await rpc.call<Hex>("eth_chainId", [])) !== 4663)
    throw Error("analytics_wrong_chain");
  const head = Number(await rpc.call<Hex>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || input.toBlock > head - 128)
    throw Error("analytics_unconfirmed_cutoff");
  const cutoff = await canonical(rpc, input.toBlock);
  if (!same(cutoff.hash, input.blockHash))
    throw Error("analytics_cutoff_changed");
  const launch = decodeLaunch(input.launchLog);
  const deployment = getInstantDeployment(input.launchLog.address);
  if (
    !deployment ||
    !same(launch.poolId, input.poolId) ||
    !same(launch.token, input.token) ||
    Number(input.launchLog.blockNumber) !== input.launchBlock ||
    !same(input.launchLog.transactionHash, input.launchTx) ||
    !receiptMatches(input.launchLog, input.launchReceipt) ||
    !input.launchReceipt.logs.some((l) => same(l.address, deployment.launcher))
  )
    throw Error("analytics_launch_unverified");
  for (const h of input.headers) {
    if (
      !h ||
      !Number.isSafeInteger(Number(h.number)) ||
      Number(h.number) < 0 ||
      !hash(h.hash) ||
      !Number.isSafeInteger(Number(h.timestamp)) ||
      Number(h.timestamp) < 0 ||
      Number(h.timestamp) > Number(cutoff.timestamp)
    )
      throw Error("analytics_invalid_header");
  }
  const headers = new Map(
    unique(input.headers, (h) => String(Number(h.number))).map((h) => [
      Number(h.number),
      h,
    ]),
  );
  headers.set(input.toBlock, cutoff);
  if (!headers.has(input.launchBlock))
    headers.set(input.launchBlock, await canonical(rpc, input.launchBlock));
  const logs = unique(
    [...input.swapLogs, ...input.transferLogs],
    (l) => `${l.transactionHash.toLowerCase()}:${Number(l.logIndex)}`,
  );
  const receipts = new Map(
    unique([...input.receipts, input.launchReceipt], (r) =>
      r.transactionHash.toLowerCase(),
    ).map((r) => [r.transactionHash.toLowerCase(), r]),
  );
  const missing = [
    ...new Set(logs.map((l) => l.transactionHash.toLowerCase())),
  ].filter((h) => !receipts.has(h));
  const fetched = await rpc.batch<Receipt>(
    "eth_getTransactionReceipt",
    missing.map((h) => [h]),
  );
  if (fetched.length !== missing.length)
    throw Error("analytics_missing_receipt");
  fetched.forEach((r, i) => {
    if (!r || !same(r.transactionHash, missing[i]))
      throw Error("analytics_missing_receipt");
    receipts.set(missing[i], r);
  });
  for (const [rows, contract, topic] of [
    [input.swapLogs, contracts.manager, toEventSelector(swapEvent)],
    [input.transferLogs, input.token, toEventSelector(transferEvent)],
  ] as const) {
    for (const l of rows) {
      const n = Number(l.blockNumber),
        h = headers.get(n);
      if (
        l.removed ||
        !same(l.address, contract) ||
        !same(l.topics[0], topic) ||
        l.topics.length !== 3 ||
        (topic === toEventSelector(swapEvent) &&
          !same(l.topics[1], input.poolId)) ||
        !Number.isSafeInteger(n) ||
        n < input.fromBlock ||
        n > input.toBlock ||
        !hash(l.transactionHash) ||
        !Number.isSafeInteger(Number(l.logIndex)) ||
        Number(l.logIndex) < 0 ||
        !h ||
        !same(h.hash, l.blockHash) ||
        !Number.isSafeInteger(Number(h.timestamp)) ||
        Number(h.timestamp) > Number(cutoff.timestamp) ||
        !receiptMatches(l, receipts.get(l.transactionHash.toLowerCase())!)
      )
        throw Error("analytics_event_unverified");
    }
  }
  if (!same(headers.get(input.launchBlock)!.hash, input.launchLog.blockHash))
    throw Error("analytics_launch_unverified");
  const [decimalsData, supplyData] = await rpc.batch<Hex>(
    "eth_call",
    (["decimals", "totalSupply"] as const).map((functionName) => [
      {
        to: input.token,
        data: encodeFunctionData({ abi: erc20Abi, functionName }),
      },
      hex(input.toBlock),
    ]),
  );
  const decimals = Number(
    decodeFunctionResult({
      abi: erc20Abi,
      functionName: "decimals",
      data: decimalsData,
    }),
  );
  const supply = decodeFunctionResult({
    abi: erc20Abi,
    functionName: "totalSupply",
    data: supplyData,
  }).toString();
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw Error("analytics_unsupported_decimals");
  const birthCode = await rpc.batch<Hex>(
    "eth_getCode",
    [input.launchBlock - 1, input.launchBlock].map((n) => [
      input.token,
      hex(n),
    ]),
  );
  const born =
    birthCode[0] === "0x" &&
    typeof birthCode[1] === "string" &&
    /^0x[\da-f]+$/i.test(birthCode[1]);
  const rawSwaps = unique(
    input.swapLogs,
    (l) => `${l.transactionHash}:${l.logIndex}`,
  ).sort(
    (a, b) =>
      Number(a.blockNumber) - Number(b.blockNumber) ||
      Number(a.logIndex) - Number(b.logIndex),
  );
  const transfers = unique(
    input.transferLogs,
    (l) => `${l.transactionHash}:${l.logIndex}`,
  ).sort(
    (a, b) =>
      Number(a.blockNumber) - Number(b.blockNumber) ||
      Number(a.logIndex) - Number(b.logIndex),
  );
  const supported: RawLog[] = [];
  const trades: ChainTrade[] = [];
  const series: { time: number; wei: string }[] = [];
  let unsupportedSwaps = 0;
  for (const l of rawSwaps) {
    try {
      const d = decodeSwap(l),
        timestamp = Number(headers.get(Number(l.blockNumber))!.timestamp);
      trades.push({
        poolId: input.poolId,
        txHash: l.transactionHash,
        logIndex: Number(l.logIndex),
        block: Number(l.blockNumber),
        timestamp,
        side: d.side,
        ethWei: d.ethWei,
        tokenRaw: d.tokenRaw,
      });
      series.push({
        time: timestamp,
        wei: spotPriceWei(d.sqrtPriceX96, decimals),
      });
      supported.push(l);
    } catch (e) {
      if (e instanceof Error && e.message === "Unsupported swap signs")
        unsupportedSwaps++;
      else throw e;
    }
  }
  let holders: HolderLedger | null = null,
    holderError: string | null = null;
  try {
    holders = buildHolderLedger(
      transfers.map((l) => {
        const { args } = decodeEventLog({
          abi: [transferEvent],
          ...l,
          strict: true,
        });
        return {
          token: input.token as Hex,
          txHash: l.transactionHash,
          blockHash: l.blockHash,
          block: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          from: args.from,
          to: args.to,
          valueRaw: args.value.toString(),
        };
      }),
      {
        token: input.token as Hex,
        coverage: {
          fromBlock: input.fromBlock,
          toBlock: input.toBlock,
          cutoffBlockHash: input.blockHash as Hex,
          tokenBirthBlock: born ? input.launchBlock : null,
        },
        totalSupplyRaw: supply,
        infrastructure: [
          { address: contracts.manager, label: "Uniswap PoolManager" },
          { address: contracts.router, label: "Pools router" },
        ],
      },
    );
  } catch {
    holderError = "incomplete_or_unsupported_transfer_history";
  }
  let accounting: Awaited<ReturnType<typeof auditPool>> | undefined;
  // Unknown swap signs could affect the same wallets' basis, so do not silently
  // discard them and publish apparently complete PnL from the remaining rows.
  if (!unsupportedSwaps) {
    const senders = [
      ...new Set(
        supported.map((l) =>
          receipts.get(l.transactionHash.toLowerCase())!.from.toLowerCase(),
        ),
      ),
    ];
    const codes = await rpc.batch<Hex>(
      "eth_getCode",
      senders.map((a) => [a, hex(input.toBlock)]),
    );
    if (
      codes.length !== senders.length ||
      codes.some((c) => !/^0x[\da-f]*$/i.test(c))
    )
      throw Error("analytics_missing_sender_code");
    const codeMap = new Map(senders.map((a, i) => [a, codes[i]]));
    accounting = await auditPool({
      rpc,
      token: input.token as Hex,
      rawSwaps: supported,
      transfers,
      trades,
      toBlock: input.toBlock,
      tokenBornAtLaunch: born,
      receipt: async (h) => {
        const r = receipts.get(h.toLowerCase());
        if (!r) throw Error("analytics_missing_receipt");
        return r;
      },
      code: async (a) => {
        const c = codeMap.get(a.toLowerCase());
        if (c === undefined) throw Error("analytics_missing_sender_code");
        return c;
      },
    });
  }
  if (!same((await canonical(rpc, input.toBlock)).hash, cutoff.hash))
    throw Error("analytics_cutoff_changed");
  const snapshot: ChainSnapshot = {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: new Date().toISOString(),
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    fromTimestamp: Number(headers.get(input.fromBlock)!.timestamp),
    toTimestamp: Number(cutoff.timestamp),
    blockHash: cutoff.hash,
    discoveredLaunches: 1,
    requests: rpc.requests,
    durationMs: Date.now() - started,
    reconciliation: null,
    markets: [
      {
        id: input.poolId,
        token: input.token,
        name: input.name.slice(0, 160),
        symbol: input.symbol.slice(0, 40),
        decimals,
        supply,
        launchBlock: input.launchBlock,
        launchedAt: Number(headers.get(input.launchBlock)!.timestamp),
        launchTx: input.launchTx,
        launchSender: input.launchReceipt.from.toLowerCase(),
        positionRecipient: launch.finalPositionRecipient.toLowerCase(),
        strategy: input.launchLog.address.toLowerCase(),
        creatorFees: deployment.creatorFees,
        fee: launch.key.fee,
        priceWei: unsupportedSwaps ? null : (series.at(-1)?.wei ?? null),
        volumeWei: trades.reduce((n, t) => n + BigInt(t.ethWei), 0n).toString(),
        swaps: trades.length,
        buys: trades.filter((t) => t.side === "buy").length,
        sells: trades.filter((t) => t.side === "sell").length,
        series,
        accounting,
      },
    ],
    trades: [...trades].reverse(),
  };
  if (
    Buffer.byteLength(JSON.stringify({ snapshot, holders })) >
    8 * 1024 * 1024
  )
    throw Error("analytics_publication_too_large");
  return {
    snapshot,
    holders,
    liquidityWei: null,
    evidence: {
      tokenBirthVerified: born,
      unsupportedSwaps,
      holderError,
      source: input.source,
    },
  };
}

/** Loads a repeatable, bounded contiguous prefix. A partially indexed pool can
 * be projected, but its historical cutoff is kept unchanged in every output. */
export async function loadIndexedAnalytics(
  db: Client,
  poolId: string,
): Promise<AnalyticsInput> {
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const p = (
      await db.query(
        `SELECT p.*,s.stream_key,s.start_block,s.cursor_block,s.cursor_hash FROM indexed_pools p JOIN indexer_streams s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id AND s.kind='pool' WHERE p.chain_id=4663 AND p.pool_id=$1`,
        [poolId],
      )
    ).rows[0];
    if (
      !p ||
      p.cursor_block === null ||
      Number(p.start_block) !== Number(p.launch_block)
    )
      throw Error("analytics_missing_birth_coverage");
    const meta = (
      await db.query(
        "SELECT from_block,to_block,block_hash,octet_length(evidence::text) AS bytes FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block<=$2 ORDER BY from_block LIMIT 1001",
        [p.stream_key, p.cursor_block],
      )
    ).rows;
    let next = Number(p.launch_block);
    if (
      !meta.length ||
      meta.length > 1000 ||
      meta.reduce((n, b) => n + Number(b.bytes), 0) > MAX_BYTES
    )
      throw Error("analytics_evidence_too_large");
    for (const b of meta) {
      if (Number(b.from_block) !== next) throw Error("analytics_coverage_gap");
      next = Number(b.to_block) + 1;
    }
    if (
      next !== Number(p.cursor_block) + 1 ||
      meta.at(-1)!.block_hash !== p.cursor_hash
    )
      throw Error("analytics_coverage_gap");
    const batches = (
      await db.query(
        "SELECT evidence FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block<=$2 ORDER BY from_block",
        [p.stream_key, p.cursor_block],
      )
    ).rows;
    const launchBatch = (
      await db.query(
        "SELECT evidence FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2 AND octet_length(evidence::text)<=$3",
        [p.source_stream, p.source_batch, MAX_BYTES],
      )
    ).rows[0]?.evidence;
    const launchLog = launchBatch?.logs.find(
      (l: RawLog) =>
        same(l.transactionHash, p.launch_tx) && same(l.topics[1], poolId),
    );
    const launchReceipt = launchBatch?.receipts.find((r: Receipt) =>
      same(r.transactionHash, p.launch_tx),
    );
    if (!launchLog || !launchReceipt)
      throw Error("analytics_launch_unverified");
    const input: AnalyticsInput = {
      poolId: p.pool_id,
      token: p.token,
      name: p.name,
      symbol: p.symbol,
      launchBlock: Number(p.launch_block),
      launchTx: p.launch_tx,
      fromBlock: Number(p.launch_block),
      toBlock: Number(p.cursor_block),
      blockHash: p.cursor_hash,
      launchLog,
      launchReceipt,
      swapLogs: batches.flatMap((b) => b.evidence.swapLogs),
      transferLogs: batches.flatMap((b) => b.evidence.transferLogs),
      receipts: unique(
        batches.flatMap((b) => b.evidence.receipts),
        (r: Receipt) => r.transactionHash.toLowerCase(),
      ),
      headers: unique(
        batches.flatMap((b) => b.evidence.headers),
        (h: EventHeader) => String(Number(h.number)),
      ),
      source: {
        kind: "indexed",
        stream: p.stream_key,
        batch: Number(p.cursor_block),
      },
    };
    limited(input);
    await db.query("COMMIT");
    return input;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

export async function publishAnalytics(
  db: Client,
  input: AnalyticsInput,
  result: AnalyticsResult,
) {
  const s = result.snapshot;
  if (
    s.markets.length !== 1 ||
    s.markets[0].id !== input.poolId ||
    s.markets[0].token !== input.token ||
    s.toBlock !== input.toBlock ||
    !same(s.blockHash, input.blockHash) ||
    (input.source.kind === "indexed" && input.source.batch !== s.toBlock)
  )
    throw Error("analytics_publication_mismatch");
  await db.query("BEGIN");
  try {
    if (input.source.kind === "indexed") {
      const b = (
        await db.query(
          "SELECT block_hash FROM indexer_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block=$2 FOR SHARE",
          [input.source.stream, input.source.batch],
        )
      ).rows[0];
      if (!b || !same(b.block_hash, s.blockHash))
        throw Error("analytics_source_changed");
    }
    const written = await db.query(
      `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,holders,liquidity_wei,evidence,source_kind,source_stream,source_batch)
      VALUES(4663,$1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11)
      ON CONFLICT(chain_id,pool_id) DO UPDATE SET through_block=excluded.through_block,through_hash=excluded.through_hash,asof_timestamp=excluded.asof_timestamp,generated_at=excluded.generated_at,snapshot=excluded.snapshot,holders=excluded.holders,liquidity_wei=NULL,evidence=excluded.evidence,source_kind=excluded.source_kind,source_stream=excluded.source_stream,source_batch=excluded.source_batch
      WHERE analytics_pool_snapshots.through_block<=excluded.through_block`,
      [
        input.poolId,
        s.toBlock,
        s.blockHash,
        s.toTimestamp,
        s.generatedAt,
        JSON.stringify(s),
        result.holders ? JSON.stringify(result.holders) : null,
        JSON.stringify(result.evidence),
        input.source.kind,
        input.source.kind === "indexed" ? input.source.stream : null,
        input.source.kind === "indexed" ? input.source.batch : null,
      ],
    );
    if ((written.rowCount ?? 0) > 0)
      await replaceAccountingRows(db, {
        snapshot: s,
        holders: result.holders,
        liquidityWei: null,
        sourceKind: input.source.kind,
        generatedAt: s.generatedAt,
      });
    await db.query(
      `INSERT INTO analytics_pool_jobs(chain_id,pool_id,attempted_at,published_at,next_attempt_at,last_error_code) VALUES(4663,$1,now(),CASE WHEN $2 THEN now() ELSE NULL END,now()+interval '30 minutes',NULL)
      ON CONFLICT(chain_id,pool_id) DO UPDATE SET published_at=CASE WHEN $2 THEN now() ELSE analytics_pool_jobs.published_at END,next_attempt_at=now()+interval '30 minutes',last_error_code=NULL`,
      [input.poolId, (written.rowCount ?? 0) > 0],
    );
    await db.query("COMMIT");
    return (written.rowCount ?? 0) > 0;
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}

export async function nextAnalyticsPool(db: Client): Promise<string | null> {
  // Oldest-due pool wins so failures cannot starve other candidates. Recent
  // activity breaks ties for pools with no previous attempt/publication.
  const row = (
    await db.query(`SELECT p.pool_id FROM indexed_pools p JOIN indexer_streams s ON s.chain_id=p.chain_id AND s.pool_id=p.pool_id AND s.kind='pool'
    LEFT JOIN analytics_pool_jobs j ON j.chain_id=p.chain_id AND j.pool_id=p.pool_id
    LEFT JOIN analytics_pool_snapshots a ON a.chain_id=p.chain_id AND a.pool_id=p.pool_id
    WHERE p.chain_id=4663 AND s.cursor_block IS NOT NULL AND s.start_block=p.launch_block AND (a.through_block IS NULL OR a.through_block<s.cursor_block) AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=now())
    ORDER BY coalesce(j.next_attempt_at,'epoch'::timestamptz), (SELECT max(e.block_number) FROM indexed_events e WHERE e.chain_id=4663 AND e.pool_id=p.pool_id AND e.kind='swap') DESC NULLS LAST,p.pool_id LIMIT 1`)
  ).rows[0];
  return row?.pool_id ?? null;
}
export async function runAnalyticsOnce(db: Client, rpc: Rpc, poolId?: string) {
  // Retry any publication skipped because another transaction held its lock
  // during startup. Backfill itself never queries the RPC.
  await backfillAccountingRows(db, 25);
  const selected = poolId ?? (await nextAnalyticsPool(db));
  if (!selected) return false;
  await db.query(
    `INSERT INTO analytics_pool_jobs(chain_id,pool_id,attempted_at,next_attempt_at) VALUES(4663,$1,now(),now()+interval '5 minutes') ON CONFLICT(chain_id,pool_id) DO UPDATE SET attempted_at=now(),next_attempt_at=now()+interval '5 minutes'`,
    [selected],
  );
  try {
    const input = await loadIndexedAnalytics(db, selected);
    const result = await projectAnalytics(input, rpc);
    const published = await publishAnalytics(db, input, result);
    console.log(
      JSON.stringify({
        event: published
          ? "analytics_published"
          : "analytics_older_capture_retained",
        pool: selected,
        toBlock: result.snapshot.toBlock,
        holders: result.holders?.positiveHoldersExcludingInfrastructure ?? null,
        wallets: result.snapshot.markets[0].accounting?.wallets.length ?? 0,
      }),
    );
    return true;
  } catch (e) {
    throwIfRateLimitExhausted(e);
    const code = analyticsError(e);
    await db.query(
      "UPDATE analytics_pool_jobs SET last_error_code=$2 WHERE chain_id=4663 AND pool_id=$1",
      [selected, code],
    );
    throw Error(code);
  }
}
export function analyticsError(e: unknown) {
  if (e instanceof RpcRateLimitExhausted)
    return "analytics_rpc_rate_limit_exhausted";
  return e instanceof Error && /^analytics_[a-z_]+$/.test(e.message)
    ? e.message
    : "analytics_projection_failed";
}

/** Trusted local exporter input, re-derived rather than accepting supplied PnL. */
export async function captureAnalyticsInput(
  db: Client,
  capture: {
    snapshot: ChainSnapshot;
    evidence: {
      launches: RawLog[];
      swaps: RawLog[];
      transfers: RawLog[];
      receipts: Receipt[];
      blocks: EventHeader[];
    };
  },
): Promise<AnalyticsInput> {
  const s = capture?.snapshot,
    e = capture?.evidence;
  if (
    !s ||
    s.schemaVersion !== 1 ||
    s.chainId !== 4663 ||
    s.markets?.length !== 1 ||
    !e ||
    !Array.isArray(e.launches) ||
    !Array.isArray(e.swaps) ||
    !Array.isArray(e.transfers) ||
    !Array.isArray(e.receipts) ||
    !Array.isArray(e.blocks)
  )
    throw Error("analytics_invalid_capture");
  const m = s.markets[0];
  const p = (
    await db.query(
      "SELECT * FROM indexed_pools WHERE chain_id=4663 AND pool_id=$1",
      [m.id.toLowerCase()],
    )
  ).rows[0];
  if (
    !p ||
    !same(p.token, m.token) ||
    !same(p.launch_tx, m.launchTx) ||
    Number(p.launch_block) !== m.launchBlock
  )
    throw Error("analytics_capture_pool_unverified");
  const launchLog = e.launches.find(
    (l) => same(l.transactionHash, p.launch_tx) && same(l.topics[1], p.pool_id),
  );
  const launchReceipt = e.receipts.find((r) =>
    same(r.transactionHash, p.launch_tx),
  );
  if (!launchLog || !launchReceipt) throw Error("analytics_launch_unverified");
  const input: AnalyticsInput = {
    poolId: p.pool_id,
    token: p.token,
    name: p.name,
    symbol: p.symbol,
    launchBlock: Number(p.launch_block),
    launchTx: p.launch_tx,
    fromBlock: Number(p.launch_block),
    toBlock: s.toBlock,
    blockHash: s.blockHash,
    launchLog,
    launchReceipt,
    swapLogs: e.swaps,
    transferLogs: e.transfers,
    receipts: e.receipts,
    headers: e.blocks,
    source: { kind: "rpc_capture" },
  };
  limited(input);
  return input;
}
