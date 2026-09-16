import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  toEventSelector,
  type Hex,
} from "viem";
import {
  Rpc,
  RpcRateLimitExhausted,
  canonicalMulticall3Address,
  contracts,
  decodeAggregateRequest,
  encodeAggregateReply,
  expandContractReads,
  getInstantDeployment,
  swapEvent,
  transferEvent,
  type RawLog,
  type Receipt,
  type EventHeader,
} from "@pools/chain";
import {
  projectAnalytics,
  loadIndexedAnalytics,
  runAnalyticsOnce,
  analyticsError,
  cachedSenderCode,
  senderCodeRecheckBlocks,
  type AnalyticsInput,
} from "./analytics";
import type { Client } from "@pools/db";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const token = addr(11),
  wallet = addr(22),
  zero = addr(0);
const header = (n: number): EventHeader => ({
  number: `0x${n.toString(16)}`,
  hash: word(n),
  parentHash: word(n - 1),
  timestamp: `0x${(n * 2).toString(16)}`,
});
const keyTypes = [
  { type: "address" },
  { type: "address" },
  { type: "uint24" },
  { type: "int24" },
  { type: "address" },
] as const;
const keyValues = [zero, token, 2500, 25, zero] as const;
const poolId = keccak256(encodeAbiParameters(keyTypes, keyValues));
const launchEvent = parseAbiItem(
  "event TokenLaunched(bytes32 indexed poolId,address indexed token,address indexed finalPositionRecipient,(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)",
);
function base(block: number, index: number): RawLog {
  return {
    address: token,
    topics: [word(0)],
    data: "0x",
    blockNumber: `0x${block.toString(16)}`,
    blockHash: word(block),
    transactionHash: word(block + 1000),
    logIndex: `0x${index.toString(16)}`,
    removed: false,
  };
}
function transfer(
  block: number,
  index: number,
  from: Hex,
  to: Hex,
  amount: bigint,
): RawLog {
  return {
    ...base(block, index),
    topics: [
      toEventSelector(transferEvent),
      `0x${from.slice(2).padStart(64, "0")}`,
      `0x${to.slice(2).padStart(64, "0")}`,
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
  };
}
function fixture(
  options: {
    unsupportedRoute?: boolean;
    birthUnknown?: boolean;
    reorg?: boolean;
    balanceMismatch?: boolean;
  } = {},
) {
  const launchLog: RawLog = {
    ...base(100, 0),
    address: contracts.strategies[0],
    topics: [
      toEventSelector(launchEvent),
      poolId,
      word(11),
      `0x${getInstantDeployment(contracts.strategies[0])!.feeSplitter.slice(2).padStart(64, "0")}`,
    ],
    data: encodeAbiParameters(keyTypes, keyValues),
  };
  const mint = transfer(100, 2, zero, contracts.manager, 1000n);
  const launchReceipt: Receipt = {
    status: "0x1",
    from: wallet,
    to: contracts.launcher,
    blockHash: word(100),
    transactionHash: word(1100),
    logs: [launchLog, { ...base(100, 1), address: contracts.launcher }, mint],
  };
  const swaps: RawLog[] = [],
    transfers: RawLog[] = [mint],
    receipts: Receipt[] = [launchReceipt];
  for (let i = 0; i < 12; i++) {
    const n = 101 + i,
      buy = i % 2 === 0;
    const log: RawLog = {
      ...base(n, 0),
      address: contracts.manager,
      topics: [
        toEventSelector(swapEvent),
        poolId,
        `0x${contracts.router.slice(2).padStart(64, "0")}`,
      ],
      data: encodeAbiParameters(
        [
          { type: "int128" },
          { type: "int128" },
          { type: "uint160" },
          { type: "uint128" },
          { type: "int24" },
          { type: "uint24" },
        ],
        [buy ? -10n : 20n, buy ? 100n : -100n, 1n << 96n, 100n, 0, 2500],
      ),
    };
    const movement = transfer(
      n,
      1,
      buy ? contracts.manager : wallet,
      buy ? wallet : contracts.manager,
      100n,
    );
    swaps.push(log);
    transfers.push(movement);
    receipts.push({
      status: "0x1",
      from: wallet,
      to: options.unsupportedRoute ? addr(99) : contracts.router,
      blockHash: word(n),
      transactionHash: word(n + 1000),
      logs: [log, movement],
    });
  }
  const input: AnalyticsInput = {
    poolId,
    token,
    name: "Test",
    symbol: "TST",
    launchBlock: 100,
    launchTx: word(1100),
    fromBlock: 100,
    toBlock: 120,
    blockHash: word(120),
    launchLog,
    launchReceipt,
    swapLogs: swaps,
    transferLogs: transfers,
    receipts,
    headers: [100, ...Array.from({ length: 12 }, (_, i) => 101 + i), 120].map(
      header,
    ),
    source: { kind: "indexed", stream: `pool:${poolId}`, batch: 120 },
  };
  const rpc = new Rpc();
  let cutoffReads = 0;
  /** Provider calls by method, counting every member of a batch. */
  const counts: Record<string, number> = {};
  const count = (m: string, n = 1) => (counts[m] = (counts[m] ?? 0) + n);
  rpc.call = async <T>(method: string, params: unknown[]) => {
    count(method);
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return "0x1f4" as T;
    const n = Number(params[0]);
    if (n === 120) cutoffReads++;
    return {
      ...header(n),
      ...(options.reorg && cutoffReads > 1 ? { hash: word(999) } : {}),
    } as T;
  };
  const answer = (data: string): Hex =>
    encodeAbiParameters(
      [{ type: "uint256" }],
      [
        data.startsWith("0x313ce567")
          ? 18n
          : data.startsWith("0x18160ddd")
            ? 1000n
            : options.balanceMismatch
              ? 1n
              : 0n,
      ],
    );
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    count(method, params.length);
    return params.map((p) => {
      if (method === "eth_getCode")
        return p[0] === token
          ? Number(p[1]) === 99 && !options.birthUnknown
            ? "0x"
            : "0x6000"
          : "0x";
      if (method === "eth_call") {
        const call = p[0] as { to: string; data: Hex };
        if (call.to !== canonicalMulticall3Address) return answer(call.data);
        return encodeAggregateReply(
          decodeAggregateRequest(call.data).map((c) => ({
            success: true,
            returnData: answer(c.callData),
          })),
        );
      }
      if (method === "eth_getTransactionReceipt")
        return receipts.find((r) => r.transactionHash === p[0]);
      throw Error("Unexpected RPC method");
    }) as T[];
  };
  return { input, rpc, counts };
}

test("background projection produces exact realized PnL and holder preload from verified full-birth evidence", async () => {
  const { input, rpc, counts } = fixture();
  const result = await projectAnalytics(input, rpc);
  const market = result.snapshot.markets[0];
  // The unit pair and every trader balance travel as one aggregate each;
  // before batching this projection made 3 eth_calls (2 units + 1 balance).
  assert.deepEqual(counts, {
    eth_chainId: 1,
    eth_blockNumber: 1,
    eth_getBlockByNumber: 2,
    eth_getTransactionReceipt: 0,
    eth_call: 2,
    eth_getCode: 3, // the token's birth pair and one sender
  });
  assert.deepEqual(
    result.evidence.calls.map((c) => c.kind),
    ["multicall3", "multicall3"],
  );
  const reads = expandContractReads(result.evidence.calls);
  assert.deepEqual(
    reads.map((r) => [r.to, r.data.slice(0, 10), r.block]),
    [
      [token, "0x313ce567", "0x78"],
      [token, "0x18160ddd", "0x78"],
      [token, "0x70a08231", "0x78"],
    ],
  );
  assert.equal(
    reads[2].result,
    encodeAbiParameters([{ type: "uint256" }], [0n]),
  );
  assert.equal("calls" in (market.accounting ?? {}), false);
  assert.equal(market.accounting?.wallets[0].realizedWei, "60");
  assert.equal(market.accounting?.wallets[0].eligible, true);
  assert.equal(market.accounting?.wallets[0].balanceMatches, true);
  assert.equal(market.accounting?.executions?.length, 12);
  assert.equal(result.holders?.complete, true);
  assert.equal(result.holders?.trackedSupplyRaw, "1000");
  assert.equal(result.holders?.positiveHoldersExcludingInfrastructure, 0);
  assert.equal(
    result.holders?.balances[0].infrastructureLabel,
    "Uniswap PoolManager",
  );
  assert.equal(result.snapshot.toTimestamp, 240);
  assert.equal(result.snapshot.fromBlock, 100);
  assert.equal(result.liquidityWei, null);
});
test("unsupported route, unknown token birth and mismatched balance never become ranked profit", async () => {
  for (const options of [
    { unsupportedRoute: true },
    { birthUnknown: true },
    { balanceMismatch: true },
  ]) {
    const { input, rpc } = fixture(options),
      result = await projectAnalytics(input, rpc);
    assert.equal(
      result.snapshot.markets[0].accounting?.wallets[0].realizedWei,
      null,
    );
    assert.equal(
      result.snapshot.markets[0].accounting?.wallets[0].eligible,
      false,
    );
    assert.ok(result.holders); // Holder evidence remains useful independently.
    if (options.birthUnknown) assert.equal(result.holders.complete, false);
  }
});
test("projection rejects reorg, altered receipts, source escape and truncation before publication", async () => {
  const reorg = fixture({ reorg: true });
  await assert.rejects(
    projectAnalytics(reorg.input, reorg.rpc),
    /analytics_cutoff_changed/,
  );
  const wrong = fixture();
  wrong.input.swapLogs[0] = { ...wrong.input.swapLogs[0], address: token };
  await assert.rejects(
    projectAnalytics(wrong.input, wrong.rpc),
    /analytics_event_unverified/,
  );
  const missing = fixture();
  missing.input.receipts[1].logs = [];
  await assert.rejects(
    projectAnalytics(missing.input, missing.rpc),
    /analytics_event_unverified/,
  );
  const truncated = fixture();
  truncated.input.fromBlock = 101;
  await assert.rejects(
    projectAnalytics(truncated.input, truncated.rpc),
    /analytics_input_out_of_bounds/,
  );
});
test("indexed loader refuses non-contiguous saved batches and rolls its read transaction back", async () => {
  const calls: string[] = [];
  const db = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql.includes("SELECT p.*"))
        return {
          rows: [
            {
              stream_key: "pool:test",
              launch_block: "100",
              start_block: "100",
              cursor_block: "120",
              cursor_hash: word(120),
            },
          ],
        };
      if (sql.includes("SELECT from_block"))
        return {
          rows: [
            {
              from_block: "100",
              to_block: "109",
              block_hash: word(109),
              bytes: 1,
            },
            {
              from_block: "111",
              to_block: "120",
              block_hash: word(120),
              bytes: 1,
            },
          ],
        };
      return { rows: [] };
    },
  } as unknown as Client;
  await assert.rejects(
    loadIndexedAnalytics(db, poolId),
    /analytics_coverage_gap/,
  );
  assert.equal(calls.at(-1), "ROLLBACK");
});

test("analytics preserves terminal rate limits without publication or generic retry classification", async () => {
  for (const terminal of [true, false]) {
    const { input, rpc } = fixture();
    const calls: string[] = [];
    const db = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT p.*"))
          return {
            rows: [
              {
                pool_id: input.poolId,
                token: input.token,
                name: input.name,
                symbol: input.symbol,
                launch_block: input.launchBlock,
                launch_tx: input.launchTx,
                source_stream: "discovery:v1",
                source_batch: 100,
                stream_key: `pool:${input.poolId}`,
                start_block: input.fromBlock,
                cursor_block: input.toBlock,
                cursor_hash: input.blockHash,
              },
            ],
          };
        if (sql.startsWith("SELECT from_block"))
          return {
            rows: [
              {
                from_block: input.fromBlock,
                to_block: input.toBlock,
                block_hash: input.blockHash,
                bytes: 100,
              },
            ],
          };
        if (sql.startsWith("SELECT evidence") && sql.includes("to_block<="))
          return {
            rows: [
              {
                evidence: {
                  swapLogs: input.swapLogs,
                  transferLogs: input.transferLogs,
                  receipts: input.receipts,
                  headers: input.headers,
                },
              },
            ],
          };
        if (sql.startsWith("SELECT evidence"))
          return {
            rows: [
              {
                evidence: {
                  logs: [input.launchLog],
                  receipts: [input.launchReceipt],
                },
              },
            ],
          };
        return { rows: [] };
      },
    } as unknown as Client;
    const error = terminal
      ? new RpcRateLimitExhausted()
      : Error("private_provider_url");
    let rpcCalls = 0;
    rpc.call = async () => {
      rpcCalls++;
      throw error;
    };
    await assert.rejects(
      runAnalyticsOnce(db, rpc, input.poolId),
      (e: unknown) =>
        terminal
          ? e === error
          : e instanceof Error && e.message === "analytics_projection_failed",
    );
    assert.equal(rpcCalls, 1);
    assert.equal(
      calls.some((sql) => sql.includes("INSERT INTO analytics_pool_snapshots")),
      false,
    );
    assert.equal(
      calls.some((sql) => sql.includes("SET last_error_code")),
      !terminal,
    );
    assert.equal(
      analyticsError(error),
      terminal
        ? "analytics_rpc_rate_limit_exhausted"
        : "analytics_projection_failed",
    );
  }
});

test("unsupported swap signs preserve holder preload without silently publishing partial PnL", async () => {
  const { input, rpc } = fixture();
  input.swapLogs[0].data = encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [10n, 100n, 1n << 96n, 100n, 0, 2500],
  );
  const result = await projectAnalytics(input, rpc);
  assert.equal(result.evidence.unsupportedSwaps, 1);
  assert.equal(result.snapshot.markets[0].accounting, undefined);
  assert.equal(result.snapshot.markets[0].priceWei, null);
  assert.equal(result.holders?.complete, true);
});

test(
  "Postgres: older projection preserves newer publication and job publication time",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { createClient } = await import("@pools/db");
    const { readFile } = await import("node:fs/promises");
    const { randomBytes } = await import("node:crypto");
    const { publishAnalytics, nextAnalyticsPool } = await import("./analytics");
    const db = createClient(process.env.TEST_DATABASE_URL),
      schema = "analytics_test_" + randomBytes(8).toString("hex");
    await db.connect();
    try {
      await db.query(`CREATE SCHEMA ${schema}`);
      await db.query(`SET search_path TO ${schema}`);
      for (const file of [
        "001_indexer.sql",
        "002_read_indexes.sql",
        "003_analytics.sql",
        "005_accounting_rows.sql",
        "013_sender_code_observations.sql",
      ])
        await db.query(
          await readFile(
            new URL(`../../../packages/db/migrations/${file}`, import.meta.url),
            "utf8",
          ),
        );
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',100,100,$1)",
        [word(100)],
      );
      await db.query(
        "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,'discovery:v1',100,100,$1,'proof','{}')",
        [word(100)],
      );
      await db.query(
        "INSERT INTO indexed_pools VALUES(4663,$1,$2,'Test','TST',100,$3,$4,200,'discovery:v1',100)",
        [poolId, token, word(1100), wallet],
      );
      await db.query(
        "INSERT INTO indexer_streams(chain_id,stream_key,kind,pool_id,start_block,cursor_block,cursor_hash) VALUES(4663,$1,'pool',$2,100,120,$3)",
        [`pool:${poolId}`, poolId, word(120)],
      );
      for (const [from, to] of [
        [100, 110],
        [111, 120],
      ])
        await db.query(
          "INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence) VALUES(4663,$1,$2,$3,$4,'proof','{}')",
          [`pool:${poolId}`, from, to, word(to)],
        );
      const newer = fixture(),
        newResult = await projectAnalytics(newer.input, newer.rpc, {
          senderCode: cachedSenderCode(db, newer.rpc),
        });
      assert.equal(await publishAnalytics(db, newer.input, newResult), true);
      // The sender's code was read once at the cutoff and saved.
      assert.equal(newer.counts.eth_getCode, 3);
      assert.deepEqual(
        (
          await db.query(
            "SELECT address,code_hash,observed_block::text FROM sender_code_observations",
          )
        ).rows,
        [{ address: wallet, code_hash: null, observed_block: "120" }],
      );
      // A projection of the same sender at an earlier cutoff answers from the
      // saved observation: only the token's birth pair is read.
      const cached = fixture();
      cached.input.toBlock = 110;
      cached.input.blockHash = word(110);
      cached.input.source = {
        kind: "indexed",
        stream: `pool:${poolId}`,
        batch: 110,
      };
      for (const key of ["swapLogs", "transferLogs", "headers"] as const)
        cached.input[key] = (
          cached.input[key] as { blockNumber?: string; number?: string }[]
        ).filter((r) => Number(r.blockNumber ?? r.number) <= 110) as never;
      const cachedResult = await projectAnalytics(cached.input, cached.rpc, {
        senderCode: cachedSenderCode(db, cached.rpc),
      });
      assert.equal(cached.counts.eth_getCode, 2);
      assert.equal(
        cachedResult.snapshot.markets[0].accounting?.wallets[0].flags.includes(
          "contract_sender",
        ),
        false,
      );
      // A zero recheck horizon records but never reuses an observation.
      const uncached = fixture();
      await projectAnalytics(uncached.input, uncached.rpc, {
        senderCode: cachedSenderCode(db, uncached.rpc, 0),
      });
      assert.equal(uncached.counts.eth_getCode, 3);
      assert.equal(senderCodeRecheckBlocks(undefined), 1000000);
      assert.equal(senderCodeRecheckBlocks("0"), 0);
      assert.throws(() => senderCodeRecheckBlocks("-1"), /recheck/);
      const { backfillAccountingRows } =
        await import("./accounting-projection");
      assert.deepEqual(
        (
          await db.query(
            "SELECT realized_wei::text,quantity_raw::text FROM analytics_accounting_positions",
          )
        ).rows,
        [{ realized_wei: "60", quantity_raw: "0" }],
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT count(*)::int AS trades,sum(realized_wei)::text AS gain,count(closed_gain_wei)::int AS closures,sum(closed_hold_seconds)::text AS hold FROM analytics_accounting_trades",
          )
        ).rows[0],
        { trades: 12, gain: "60", closures: 6, hold: "12" },
      );
      // A saved publication from the previous application version is upgraded
      // without RPC, and a bounded second pass has no repeated work.
      await db.query("DELETE FROM analytics_accounting_pools");
      await db.query(
        "UPDATE analytics_pool_snapshots SET generated_at=generated_at + interval '123 microseconds'",
      );
      const lockingWriter = createClient(process.env.TEST_DATABASE_URL);
      await lockingWriter.connect();
      try {
        await lockingWriter.query(`SET search_path TO ${schema}`);
        await lockingWriter.query("BEGIN");
        await lockingWriter.query(
          "SELECT pool_id FROM analytics_pool_snapshots FOR UPDATE",
        );
        assert.equal(await backfillAccountingRows(db, 1), 0);
        await lockingWriter.query("ROLLBACK");
      } finally {
        await lockingWriter.end();
      }
      assert.equal(await backfillAccountingRows(db, 1), 1);
      assert.equal(await backfillAccountingRows(db, 1), 0);
      const originalRows = (
        await db.query(
          "SELECT * FROM analytics_accounting_trades ORDER BY block_number,log_index",
        )
      ).rows;
      const malformed = structuredClone(newResult);
      malformed.snapshot.markets[0].series[0].wei = "-1";
      await assert.rejects(
        publishAnalytics(db, newer.input, malformed),
        /check constraint/,
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT * FROM analytics_accounting_trades ORDER BY block_number,log_index",
          )
        ).rows,
        originalRows,
      );
      assert.equal(
        (
          await db.query(
            "SELECT snapshot->'markets'->0->'series'->0->>'wei' AS price FROM analytics_pool_snapshots",
          )
        ).rows[0].price,
        newResult.snapshot.markets[0].series[0].wei,
      );
      const published = (
        await db.query("SELECT published_at FROM analytics_pool_jobs")
      ).rows[0].published_at.toISOString();
      const older = fixture();
      older.input.toBlock = 110;
      older.input.blockHash = word(110);
      older.input.source = {
        kind: "indexed",
        stream: `pool:${poolId}`,
        batch: 110,
      };
      older.input.swapLogs = older.input.swapLogs.filter(
        (l) => Number(l.blockNumber) <= 110,
      );
      older.input.transferLogs = older.input.transferLogs.filter(
        (l) => Number(l.blockNumber) <= 110,
      );
      older.input.headers = older.input.headers.filter(
        (h) => Number(h.number) <= 110,
      );
      const oldResult = await projectAnalytics(older.input, older.rpc);
      assert.equal(await publishAnalytics(db, older.input, oldResult), false);
      const saved = (
        await db.query(
          "SELECT through_block,snapshot FROM analytics_pool_snapshots",
        )
      ).rows[0];
      assert.equal(saved.through_block, "120");
      assert.equal(
        (
          await db.query(
            "SELECT through_block::text FROM analytics_accounting_pools",
          )
        ).rows[0].through_block,
        "120",
      );
      assert.equal(
        saved.snapshot.markets[0].accounting.wallets[0].realizedWei,
        "60",
      );
      assert.equal(
        (
          await db.query("SELECT published_at FROM analytics_pool_jobs")
        ).rows[0].published_at.toISOString(),
        published,
      );
      await db.query("UPDATE analytics_pool_jobs SET next_attempt_at='epoch'");
      assert.equal(await nextAnalyticsPool(db), null);
      await db.query(
        "UPDATE indexer_streams SET cursor_block=121,cursor_hash=$1 WHERE stream_key=$2",
        [word(121), `pool:${poolId}`],
      );
      assert.equal(await nextAnalyticsPool(db), poolId);
      await db.query(
        "DELETE FROM indexer_batches WHERE stream_key=$1 AND to_block=120",
        [`pool:${poolId}`],
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM analytics_pool_snapshots",
          )
        ).rows[0].n,
        0,
      );
      for (const table of [
        "analytics_accounting_pools",
        "analytics_accounting_positions",
        "analytics_accounting_trades",
        "analytics_accounting_prices",
      ])
        assert.equal(
          (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,
          0,
        );
      await assert.rejects(
        publishAnalytics(db, newer.input, newResult),
        /analytics_source_changed/,
      );
      // Two pending publications prove the caller's batch bound is honored,
      // and the next invocation resumes without replaying completed rows.
      for (const n of [901, 902]) {
        const empty = structuredClone(newResult.snapshot);
        empty.markets[0] = {
          ...empty.markets[0],
          id: word(n),
          token: addr(n),
          swaps: 0,
          buys: 0,
          sells: 0,
          volumeWei: "0",
          series: [],
          accounting: {
            wallets: [],
            executions: [],
            unattributedSwaps: 0,
            transfersChecked: 0,
          },
        };
        empty.trades = [];
        await db.query(
          "INSERT INTO indexed_pools VALUES(4663,$1,$2,'Empty','EMPTY',100,$3,$4,200,'discovery:v1',100)",
          [word(n), addr(n), word(n + 1000), wallet],
        );
        await db.query(
          "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,source_kind) VALUES(4663,$1,$2,$3,$4,$5,$6,'rpc_capture')",
          [
            word(n),
            empty.toBlock,
            empty.blockHash,
            empty.toTimestamp,
            empty.generatedAt,
            JSON.stringify(empty),
          ],
        );
      }
      assert.equal(await backfillAccountingRows(db, 1), 1);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM analytics_accounting_pools",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(await backfillAccountingRows(db, 1), 1);
      assert.equal(await backfillAccountingRows(db, 1), 0);
    } finally {
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    }
  },
);
