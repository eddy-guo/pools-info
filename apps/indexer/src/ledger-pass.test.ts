import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
} from "viem";
import {
  HyperSyncClient,
  Rpc,
  collectLedgerRange,
  contracts,
  decodeAggregateRequest,
  encodeAggregateReply,
  ledgerPassPolicy,
  type HyperSyncRetryEvent,
} from "@pools/chain";
import {
  FakeHyperSync,
  fakeLaunch,
  fakeSwap,
  fakeTransfer,
  word,
} from "@pools/chain/testing";
import {
  acquireLedgerWriter,
  applyLedgerBatch,
  commitBatch,
  createClient,
  getStream,
  ledgerLaunchStreamIdentity,
  ledgerRegistry,
  migrate,
  readLedgerStream,
  releaseLedgerWriter,
  type Client,
} from "@pools/db";
import {
  LedgerPassProgress,
  calibrateLedgerRange,
  ledgerBatchOf,
  ledgerPassConfig,
  ledgerPassSafeError,
  runLedgerPass,
  type LedgerRangeProgress,
} from "./ledger-pass";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };
const start = ledgerPassPolicy.startBlock;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const W = addr(0x3333),
  V = addr(0x4444),
  S = addr(0x5555),
  TA = addr(0x1111),
  TB = addr(0x2222);
const apiToken = "x".repeat(16);

async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `ledger_pass_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  return db;
}
/** The ledger writer lock is one per server; each test's connection takes it
 * for its life and waits for a sibling test file that holds it. */
async function writer(db: Client) {
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
function metadataRpc(tokens: Record<string, [string, string, number]> = {}) {
  const rpc = new Rpc();
  const calls: Record<string, number> = {};
  const count = (m: string) => (calls[m] = (calls[m] ?? 0) + 1);
  rpc.call = async <T>(method: string) => {
    count(method);
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return "0x3dcbde5" as T;
    throw Error(`Unexpected JSON-RPC ${method}`);
  };
  rpc.logs = async () => {
    throw Error("Unexpected JSON-RPC eth_getLogs");
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    for (const _ of params) count(method);
    if (method !== "eth_call") throw Error(`Unexpected JSON-RPC ${method}`);
    return params.map((p) => {
      const { data } = p[0] as { to: Hex; data: Hex };
      return encodeAggregateReply(
        decodeAggregateRequest(data).map((member) => {
          const fn = decodeFunctionData({
            abi: erc20Abi,
            data: member.callData,
          }).functionName as "name" | "symbol" | "decimals";
          const [name, symbol, decimals] = tokens[
            member.target.toLowerCase()
          ] ?? ["Token", "TKN", 18];
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result:
                fn === "name" ? name : fn === "symbol" ? symbol : decimals,
            }),
          };
        }),
      );
    }) as T[];
  };
  return { rpc, calls };
}
const tokens = { [TA]: ["Alpha", "A", 18], [TB]: ["Beta", "B", 6] } as Record<
  string,
  [string, string, number]
>;
/** Two launches, three trades, one plain transfer and one unsupported swap
 * across three 100-block ranges below the confirmed cutoff. */
function fakeChain(
  options: {
    intercept?: FakeHyperSync["fetch"] extends infer _
      ? ConstructorParameters<typeof FakeHyperSync>[0]["intercept"]
      : never;
  } = {},
) {
  const height = start + 299 + 128;
  const a = fakeLaunch({
    block: start,
    token: TA,
    sender: S,
    transactionHash: word(0xa1),
    metadata: {
      description: "Token A",
      website: "https://a.example",
      image: "https://a.example/a.png",
    },
  });
  const b = fakeLaunch({
    block: start + 150,
    token: TB,
    sender: S,
    transactionHash: word(0xb1),
  });
  const logs = [
    ...a.logs,
    ...b.logs,
    fakeSwap({
      block: start + 5,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [-10n, 200n],
      transactionHash: word(0xc1),
    }),
    fakeTransfer({
      block: start + 5,
      logIndex: 1,
      token: TA,
      from: contracts.manager,
      to: W,
      value: 200n,
      transactionHash: word(0xc1),
      sender: W,
    }),
    fakeSwap({
      block: start + 120,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [8n, -100n],
      transactionHash: word(0xc2),
    }),
    fakeTransfer({
      block: start + 120,
      logIndex: 1,
      token: TA,
      from: W,
      to: contracts.manager,
      value: 100n,
      transactionHash: word(0xc2),
    }),
    fakeTransfer({
      block: start + 130,
      logIndex: 0,
      token: TA,
      from: W,
      to: V,
      value: 50n,
      transactionHash: word(0xc3),
    }),
    fakeSwap({
      block: start + 160,
      logIndex: 0,
      poolId: b.poolId,
      from: V,
      amounts: [-4n, 40n],
      transactionHash: word(0xc4),
    }),
    fakeTransfer({
      block: start + 160,
      logIndex: 1,
      token: TB,
      from: contracts.manager,
      to: V,
      value: 40n,
      transactionHash: word(0xc4),
      sender: V,
    }),
    fakeSwap({
      block: start + 170,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [5n, 5n],
      transactionHash: word(0xc5),
    }),
  ];
  const fake = new FakeHyperSync({
    height,
    logs,
    intercept: options.intercept,
  });
  return { fake, height, poolA: a.poolId, poolB: b.poolId };
}
function passClient(
  fake: FakeHyperSync,
  onRetry?: (e: HyperSyncRetryEvent) => void,
) {
  return new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    retryBaseMs: 1,
    fetch: fake.fetch,
    onRetry,
  });
}
const runOptions = (
  log: Record<string, unknown>[],
  extra: {
    maxRanges?: number;
    throttled?: () => number;
    maxRangeBlocks?: number;
    catchUpMargin?: number;
    swapSelection?: "manager" | "pool_ids";
  } = {},
) => ({
  rangeBlocks: 100,
  maxRangeBlocks: 100,
  maxPages: 16,
  rpc: () => metadataRpc(tokens).rpc,
  log: (e: Record<string, unknown>) => log.push(e),
  ...extra,
});
async function positions(db: Client) {
  const r = await db.query(
    `SELECT encode(w.address,'hex') AS wallet,p.pool_id,quantity_raw::text AS quantity,cost_wei::text AS cost,invested_wei::text AS invested,proceeds_wei::text AS proceeds,disposed_cost_wei::text AS disposed,realized_wei::text AS realized,inflow_raw::text AS inflow,outflow_raw::text AS outflow,outflow_cost_wei::text AS outflow_cost,buys,sells,supported,flags
     FROM agg_positions x JOIN agg_wallets w ON w.wallet_ref=x.wallet_ref JOIN indexed_pools p ON p.pool_ref=x.pool_ref ORDER BY p.launch_block,w.address`,
  );
  return r.rows.map((r) => ({ ...r, wallet: "0x" + r.wallet }));
}
async function batches(db: Client) {
  const r = await db.query(
    "SELECT from_block::int AS from_block,to_block::int AS to_block,encode(block_hash,'hex') AS hash,encode(content_hash,'hex') AS content,swaps,transfers,launches,attributed,unattributed,registry_pools,requests FROM agg_batches ORDER BY to_block",
  );
  return r.rows;
}

/** Everything the fold wrote, keyed by addresses and pool ids rather than
 * the surrogates. */
async function ledgerRows(db: Client) {
  const rows = async (sql: string) => (await db.query(sql)).rows;
  return {
    positions: await positions(db),
    walletHours: await rows(
      `SELECT encode(w.address,'hex') AS wallet,p.pool_id,to_jsonb(x)-'wallet_ref'-'pool_ref' AS row FROM agg_wallet_hours x JOIN agg_wallets w USING (wallet_ref) JOIN indexed_pools p USING (pool_ref) ORDER BY 1,2,x.hour`,
    ),
    poolHours: await rows(
      `SELECT p.pool_id,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_hours x JOIN indexed_pools p USING (pool_ref) ORDER BY 1,x.hour`,
    ),
    poolState: await rows(
      `SELECT p.pool_id,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_state x JOIN indexed_pools p USING (pool_ref) ORDER BY 1`,
    ),
    liveTrades: await rows(
      `SELECT p.pool_id,encode(w.address,'hex') AS wallet,to_jsonb(x)-'pool_ref'-'wallet_ref' AS row FROM agg_live_trades x JOIN indexed_pools p USING (pool_ref) LEFT JOIN agg_wallets w USING (wallet_ref) ORDER BY x.block_number,x.log_index`,
    ),
    batches: (
      await rows(
        "SELECT from_block::int AS from_block,to_block::int AS to_block,encode(from_parent_hash,'hex') AS parent,encode(block_hash,'hex') AS hash,encode(content_hash,'hex') AS content,to_timestamp,registry_pools,swaps,transfers,launches,attributed,unattributed,unregistered_swaps FROM agg_batches ORDER BY to_block",
      )
    ).map((r) => ({ ...r, to_timestamp: Number(r.to_timestamp) })),
  };
}

test(
  "the pass folds the same ledger whichever way the swap lane selects, and records how it did",
  dbTest,
  async (t) => {
    const other = word(0xdead);
    const run = async (swapSelection: "manager" | "pool_ids") => {
      const db = await database(t);
      await writer(db);
      const { fake } = fakeChain();
      // A pool outside the registry trades beside the registered ones, once
      // inside a registered swap's transaction.
      fake.logs.push(
        fakeSwap({
          block: start + 5,
          logIndex: 7,
          poolId: other,
          from: W,
          transactionHash: word(0xc1),
        }),
        fakeSwap({ block: start + 160, logIndex: 3, poolId: other, from: V }),
        fakeSwap({ block: start + 250, logIndex: 0, poolId: other, from: V }),
      );
      const log: Record<string, unknown>[] = [];
      const summary = await runLedgerPass(
        db,
        passClient(fake),
        runOptions(log, { swapSelection }),
      );
      assert.equal(summary.stopped, "complete");
      const query = await db.query(
        "SELECT query->'swaps' AS swaps FROM agg_batches ORDER BY to_block",
      );
      const rows = await ledgerRows(db);
      await releaseLedgerWriter(db);
      return {
        rows,
        swapQueries: query.rows.map((r) => r.swaps),
        progress: log.filter((e) => e.event === "ledger_progress"),
      };
    };
    const lists = await run("pool_ids");
    const manager = await run("manager");
    assert.deepEqual(manager.rows, lists.rows);
    assert.equal(manager.rows.batches.length, 3);
    assert.ok(manager.rows.positions.length > 0);
    assert.ok(manager.rows.poolHours.length > 0);
    // The writer found every committed swap registered either way.
    assert.ok(manager.rows.batches.every((b) => b.unregistered_swaps === 0));
    assert.deepEqual(
      manager.progress.map((p) => [p.swapSelection, p.unregisteredSwaps]),
      [
        ["manager", 1],
        ["manager", 1],
        ["manager", 1],
      ],
    );
    assert.deepEqual(
      lists.progress.map((p) => [p.swapSelection, p.unregisteredSwaps]),
      [
        ["pool_ids", 0],
        ["pool_ids", 0],
        ["pool_ids", 0],
      ],
    );
    assert.ok(manager.progress.every((p) => (p.sentBytes as number) > 0));
    assert.deepEqual(
      manager.swapQueries.map((q) =>
        q.map((r: Record<string, unknown>) => [
          r.selection,
          (r.registry as { count: number }).count,
          r.unregistered,
        ]),
      ),
      [[["manager", 1, 1]], [["manager", 2, 1]], [["manager", 2, 1]]],
    );
    assert.deepEqual(
      lists.swapQueries.map((q) =>
        q.map((r: Record<string, unknown>) => [r.selection, r.count]),
      ),
      [[["pool_ids", 1]], [["pool_ids", 2]], [["pool_ids", 2]]],
    );
  },
);

test(
  "a recorded pass folds launches, swaps and transfers into the ledger, hands over at the cutoff and replays as a no-op",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake, height, poolA, poolB } = fakeChain();
    const client = passClient(fake);
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerPass(db, client, runOptions(log));
    assert.equal(summary.stopped, "complete");
    assert.deepEqual(
      [
        summary.ranges,
        summary.blocks,
        summary.launches,
        summary.swaps,
        summary.transfers,
        summary.from,
        summary.through,
      ],
      [3, 300, 2, 3, 4, start, start + 299],
    );
    assert.equal(summary.throttled, 0);
    assert.equal(summary.total.pairsPerSwap, 1);
    assert.equal(summary.total.batches, 3);
    const ledger = await readLedgerStream(db);
    assert.deepEqual(
      [ledger.cursor, ledger.hash, ledger.mode],
      [start + 299, fake.hashOf(start + 299), "tip"],
    );
    const launches = await getStream(db, ledgerLaunchStreamIdentity.key);
    assert.deepEqual(
      [launches.cursor, launches.hash],
      [start + 299, fake.hashOf(start + 299)],
    );
    const rows = await batches(db);
    assert.deepEqual(
      rows.map((r) => [
        r.from_block,
        r.to_block,
        r.launches,
        r.swaps,
        r.transfers,
        r.attributed,
        r.unattributed,
        r.registry_pools,
      ]),
      [
        [start, start + 99, 1, 1, 1, 1, 0, 1],
        [start + 100, start + 199, 1, 2, 3, 2, 0, 2],
        [start + 200, start + 299, 0, 0, 0, 0, 0, 2],
      ],
    );
    for (const r of rows) assert.ok(r.requests >= 4);
    assert.equal(rows[1].hash, fake.hashOf(start + 199).slice(2));
    // The catalog: both launches with name, symbol, decimals and metadata.
    const catalog = await db.query(
      "SELECT pool_id,token,name,symbol,decimals,launch_block::int AS launch_block,launch_sender,description,source_stream,source_batch::int AS source_batch FROM indexed_pools ORDER BY launch_block",
    );
    assert.deepEqual(catalog.rows, [
      {
        pool_id: poolA,
        token: TA,
        name: "Alpha",
        symbol: "A",
        decimals: 18,
        launch_block: start,
        launch_sender: S,
        description: "Token A",
        source_stream: "launches:agg:v1",
        source_batch: start + 99,
      },
      {
        pool_id: poolB,
        token: TB,
        name: "Beta",
        symbol: "B",
        decimals: 6,
        launch_block: start + 150,
        launch_sender: S,
        description: null,
        source_stream: "launches:agg:v1",
        source_batch: start + 199,
      },
    ]);
    const evidence = await db.query(
      "SELECT evidence->>'source' AS source,evidence->>'stream' AS stream,jsonb_array_length(evidence->'logs') AS launches,jsonb_array_length(evidence->'calls') AS calls FROM indexer_batches WHERE stream_key=$1 ORDER BY to_block",
      [ledgerLaunchStreamIdentity.key],
    );
    assert.deepEqual(evidence.rows, [
      { source: "hypersync", stream: "launches:agg:v1", launches: 1, calls: 1 },
      { source: "hypersync", stream: "launches:agg:v1", launches: 1, calls: 1 },
      { source: "hypersync", stream: "launches:agg:v1", launches: 0, calls: 0 },
    ]);
    // The positions: W's average-cost history on A, V's zero-cost inflow on A
    // and V's buy on B.
    assert.deepEqual(
      (await positions(db)).map((p) => [
        p.wallet,
        p.pool_id === poolA ? "A" : "B",
        p.quantity,
        p.cost,
        p.invested,
        p.proceeds,
        p.disposed,
        p.realized,
        p.inflow,
        p.outflow,
        p.outflow_cost,
        p.buys,
        p.sells,
        p.supported,
        p.flags,
      ]),
      [
        [
          W,
          "A",
          "50",
          "3",
          "10",
          "8",
          "5",
          "3",
          "0",
          "50",
          "2",
          1,
          1,
          true,
          [],
        ],
        [
          V,
          "A",
          "50",
          "0",
          "0",
          "0",
          "0",
          "0",
          "50",
          "0",
          "0",
          0,
          0,
          true,
          ["zero_cost_inflow"],
        ],
        [V, "B", "40", "4", "4", "0", "0", "0", "0", "0", "0", 1, 0, true, []],
      ],
    );
    const state = await db.query(
      "SELECT p.pool_id,trades::int AS trades,volume_wei::text AS volume,holders FROM agg_pool_state s JOIN indexed_pools p ON p.pool_ref=s.pool_ref ORDER BY p.launch_block",
    );
    assert.deepEqual(state.rows, [
      { pool_id: poolA, trades: 2, volume: "18", holders: 2 },
      { pool_id: poolB, trades: 1, volume: "4", holders: 1 },
    ]);
    // The counters the acceptance reads.
    const progress = log.filter((e) => e.event === "ledger_progress");
    assert.equal(progress.length, 3);
    const last = progress[2] as {
      run: Record<string, unknown>;
      total: Record<string, unknown>;
      unsupportedSwaps: number;
      remainingBlocks: number;
    };
    assert.equal(last.remainingBlocks, 0);
    assert.equal(last.run.ranges, 3);
    assert.equal(last.run.blocks, 300);
    assert.ok((last.run.requestsPerMillionBlocks as number) > 0);
    assert.equal(last.total.batches, 3);
    assert.equal(last.total.swaps, 3);
    assert.equal(last.total.positions, 3);
    assert.equal(last.total.wallets, 2);
    assert.equal(last.total.pairsPerSwap, 1);
    assert.equal(
      (progress[1] as { unsupportedSwaps: number }).unsupportedSwaps,
      1,
    );
    assert.ok(log.some((e) => e.event === "ledger_pass_started"));
    assert.ok(log.some((e) => e.event === "ledger_pass_complete"));
    // Handed over: a second run writes nothing.
    const again = await runLedgerPass(db, client, runOptions(log));
    assert.equal(again.stopped, "handed_over");
    assert.equal((await batches(db)).length, 3);
    // The content-hash replay: the first range collected again applies as a
    // no-op with the stored hash.
    const first = await collectLedgerRange(client, metadataRpc(tokens).rpc, {
      fromBlock: start,
      toBlock: start + 99,
      parentHash: null,
      height,
      registry: [],
    });
    const replay = await applyLedgerBatch(db, ledgerBatchOf(first));
    assert.equal(replay.changed, false);
    assert.equal(replay.contentHash.slice(2), rows[0].content);
    assert.deepEqual(
      (await batches(db)).map((r) => r.content),
      rows.map((r) => r.content),
    );
    // A differing row for a committed range is refused, not replaced.
    const forged = ledgerBatchOf(first);
    forged.swaps = forged.swaps.map((s) => ({ ...s, ethWei: "11" }));
    await assert.rejects(applyLedgerBatch(db, forged), /ledger_batch_conflict/);
  },
);

test(
  "a stopped pass resumes from its cursor, rewinds a launch commit that outran the ledger, and matches a straight run",
  dbTest,
  async (t) => {
    const straight = await database(t);
    await writer(straight);
    const { fake, height } = fakeChain();
    const quiet: Record<string, unknown>[] = [];
    assert.equal(
      (await runLedgerPass(straight, passClient(fake), runOptions(quiet)))
        .stopped,
      "complete",
    );
    const expected = {
      batches: await batches(straight),
      positions: await positions(straight),
    };
    await releaseLedgerWriter(straight);
    const db = await database(t);
    await writer(db);
    const client = passClient(fake);
    const log: Record<string, unknown>[] = [];
    const partial = await runLedgerPass(
      db,
      client,
      runOptions(log, { maxRanges: 1 }),
    );
    assert.equal(partial.stopped, "ranges");
    assert.equal((await readLedgerStream(db)).cursor, start + 99);
    // A stop between the launch commit and the ledger commit of range 2.
    const second = await collectLedgerRange(client, metadataRpc(tokens).rpc, {
      fromBlock: start + 100,
      toBlock: start + 199,
      parentHash: fake.hashOf(start + 99),
      height,
      registry: await ledgerRegistry(db, start + 99),
    });
    await commitBatch(db, await getStream(db, ledgerLaunchStreamIdentity.key), {
      from: start + 100,
      to: start + 199,
      hash: second.blockHash,
      evidence: second.launch.evidence,
      pools: second.launch.pools.map((p) => ({ ...p })),
    });
    assert.equal(
      (await getStream(db, ledgerLaunchStreamIdentity.key)).cursor,
      start + 199,
    );
    const resumed = await runLedgerPass(db, client, runOptions(log));
    assert.equal(resumed.stopped, "complete");
    assert.deepEqual(
      [resumed.ranges, resumed.from, resumed.through],
      [2, start + 100, start + 299],
    );
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_launch_rewind" &&
          e.from === start + 199 &&
          e.to === start + 99,
      ),
    );
    assert.deepEqual(await batches(db), expected.batches);
    assert.deepEqual(await positions(db), expected.positions);
    assert.equal(
      (await getStream(db, ledgerLaunchStreamIdentity.key)).cursor,
      start + 299,
    );
  },
);

test(
  "a sustained throttle stops the pass with its cursor intact and counts the throttled retries",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    let queries = 0;
    const { fake } = fakeChain({
      intercept: (request) => {
        if (request.path !== "/query") return undefined;
        // Range 1 needs launch, swap, transfer and two headers: five queries.
        return ++queries > 5
          ? new Response("slow down", {
              status: 429,
              headers: { "retry-after": "0" },
            })
          : undefined;
      },
    });
    let throttled = 0;
    const client = passClient(fake, (e) => {
      if (e.reason === "throttled") throttled++;
    });
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerPass(
      db,
      client,
      runOptions(log, { throttled: () => throttled }),
    );
    assert.equal(summary.stopped, "throttled");
    assert.match(summary.error!, /^hypersync_rate_limit_exhausted/);
    assert.deepEqual([summary.ranges, summary.through], [1, start + 99]);
    assert.equal(summary.throttled, 3);
    assert.equal((await readLedgerStream(db)).cursor, start + 99);
    assert.equal((await readLedgerStream(db)).mode, "pass");
    assert.ok(log.some((e) => e.event === "ledger_pass_throttled"));
  },
);

test(
  "a fresh archive height still above the margin extends the pass, but a gap under the margin hands it over instead of chasing the tip forever",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    // A chain whose reported height keeps climbing on every /height check,
    // as a live tip does: the pass must stop once the gap left after the
    // safety lag falls under the margin, not wait for it to hit exactly
    // zero, which a chain that never stops producing blocks would never do.
    const heights = [start + 227, start + 527, start + 567];
    let heightCalls = 0;
    const fake = new FakeHyperSync({
      height: heights[0],
      logs: [],
      intercept: (request) => {
        if (request.path === "/height") {
          heightCalls++;
          fake.height = heights[Math.min(heightCalls, heights.length) - 1];
        }
        return undefined;
      },
    });
    const client = passClient(fake);
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerPass(
      db,
      client,
      runOptions(log, { catchUpMargin: 50 }),
    );
    assert.equal(summary.stopped, "complete");
    assert.equal(summary.ranges, 4);
    assert.equal(summary.through, start + 399);
    // Exactly the two idle checks the scenario is built for: the loop did
    // not keep polling height after the gap fell under the margin.
    assert.equal(heightCalls, 3);
    const complete = log.find((e) => e.event === "ledger_pass_complete") as
      { cursor: number; archiveHeight: number; safeTo: number } | undefined;
    assert.deepEqual(
      complete && [complete.cursor, complete.archiveHeight, complete.safeTo],
      [start + 399, start + 567, start + 439],
    );
    const ledger = await readLedgerStream(db);
    assert.deepEqual(
      [ledger.cursor, ledger.hash, ledger.mode],
      [start + 399, fake.hashOf(start + 399), "tip"],
    );
  },
);

test(
  "a reorg below the cursor walks the ledger and the launch stream back to the surviving checkpoint and rebuilds",
  dbTest,
  async (t) => {
    const fresh = await database(t);
    await writer(fresh);
    const { fake } = fakeChain();
    fake.reorgFrom = start + 150;
    const expected = {
      batches: await (async () => {
        await runLedgerPass(fresh, passClient(fake), runOptions([]));
        return batches(fresh);
      })(),
      positions: await positions(fresh),
    };
    await releaseLedgerWriter(fresh);
    fake.reorgFrom = null;
    const db = await database(t);
    await writer(db);
    const client = passClient(fake);
    const log: Record<string, unknown>[] = [];
    const before = await runLedgerPass(
      db,
      client,
      runOptions(log, { maxRanges: 2 }),
    );
    assert.equal(before.stopped, "ranges");
    const old = await batches(db);
    assert.equal(old[1].hash, fake.hashOf(start + 199).slice(2));
    fake.reorgFrom = start + 150;
    const after = await runLedgerPass(db, client, runOptions(log));
    assert.equal(after.stopped, "complete");
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_walk_back" &&
          e.from === start + 199 &&
          e.to === start + 99,
      ),
    );
    assert.ok(
      log.some(
        (e) => e.event === "ledger_launch_rewind" && e.to === start + 99,
      ),
    );
    const rebuilt = await batches(db);
    assert.deepEqual(rebuilt, expected.batches);
    assert.equal(rebuilt[1].hash, fake.hashOf(start + 199).slice(2));
    assert.notEqual(rebuilt[1].hash, old[1].hash);
    assert.deepEqual(await positions(db), expected.positions);
    const launchB = await db.query(
      "SELECT source_batch::int AS source_batch FROM indexed_pools WHERE launch_block=$1",
      [start + 150],
    );
    assert.deepEqual(launchB.rows, [{ source_batch: start + 199 }]);
  },
);

test(
  "calibrate collects a range exactly as the pass would and writes nothing",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake } = fakeChain();
    const client = passClient(fake);
    await runLedgerPass(db, client, runOptions([]));
    const rows = await batches(db);
    const c = await calibrateLedgerRange(db, client, metadataRpc(tokens).rpc, {
      fromBlock: start,
      toBlock: start + 199,
    });
    assert.deepEqual(
      { ...c, requests: c.requests > 0, bytes: c.bytes > 0 },
      {
        fromBlock: start,
        toBlock: start + 199,
        registryPools: 2,
        launches: 2,
        swaps: 3,
        unsupportedSwaps: 1,
        transactions: 3,
        pairs: 2,
        wallets: 2,
        pools: 2,
        transfers: 4,
        transfersInSwapTransactions: 3,
        transfersOutside: 1,
        requests: true,
        bytes: true,
        archiveHeight: fake.height,
      },
    );
    assert.deepEqual(await batches(db), rows);
  },
);

test("the configuration gates the pass, keeps the free-tier pacing floor and refuses an Alchemy endpoint", () => {
  const off = ledgerPassConfig({});
  assert.deepEqual(
    { ...off, token: off.token },
    {
      enabled: false,
      url: "https://4663.hypersync.xyz",
      token: null,
      rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
      rangeBlocks: 100000,
      minIntervalMs: 2000,
      maxPages: 16,
      maxRequests: 100000,
      maxRanges: null,
      maxRangeBlocks: 1000000,
    },
  );
  const on = ledgerPassConfig({
    LEDGER_PASS_ENABLED: "1",
    ENVIO_API_TOKEN: apiToken,
    LEDGER_PASS_RANGE_BLOCKS: "50000",
    LEDGER_PASS_MIN_INTERVAL_MS: "3000",
    LEDGER_PASS_MAX_RANGES: "2",
    ROBINHOOD_RPC_URL: "https://rpc.mainnet.chain.robinhood.com/",
  });
  assert.deepEqual(
    [on.enabled, on.token, on.rangeBlocks, on.minIntervalMs, on.maxRanges],
    [true, apiToken, 50000, 3000, 2],
  );
  assert.throws(
    () => ledgerPassConfig({ LEDGER_PASS_MIN_INTERVAL_MS: "1999" }),
    /Invalid LEDGER_PASS_MIN_INTERVAL_MS/,
  );
  assert.throws(
    () => ledgerPassConfig({ LEDGER_PASS_ENABLED: "yes" }),
    /Invalid LEDGER_PASS_ENABLED/,
  );
  assert.throws(
    () => ledgerPassConfig({ LEDGER_PASS_RANGE_BLOCKS: "1000001" }),
    /Invalid LEDGER_PASS_RANGE_BLOCKS/,
  );
  const alchemy = () =>
    ledgerPassConfig({
      ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/secret",
    });
  assert.throws(alchemy, /must be the public RPC/);
  try {
    alchemy();
  } catch (e) {
    assert.equal(
      ledgerPassSafeError(e),
      "ledger_pass_configuration_invalid: ROBINHOOD_RPC_URL must be the public RPC; the ledger pass never reads Alchemy",
    );
  }
  assert.equal(
    ledgerPassSafeError(
      Error("Ledger pass disabled; set LEDGER_PASS_ENABLED=1"),
    ),
    "ledger_pass_disabled: Ledger pass disabled; set LEDGER_PASS_ENABLED=1",
  );
  assert.equal(
    ledgerPassSafeError(Error("ledger_batch_conflict")),
    "ledger_batch_conflict",
  );
  assert.equal(
    ledgerPassSafeError(Error("HyperSync swap outside the registry")),
    "ledger_evidence_rejected: HyperSync rows failed validation; inspect the range before resuming",
  );
  assert.equal(
    ledgerPassSafeError(
      Object.assign(Error("boom"), { name: "RpcRateLimitExhausted" }),
    ).split(":")[0],
    "rpc_rate_limit_exhausted",
  );
  assert.equal(
    ledgerPassSafeError(Error("secret provider text")),
    "operation_failed: saved checkpoint preserved; inspect configuration and retry",
  );
  assert.deepEqual(
    [
      ledgerPassConfig({
        LEDGER_PASS_RANGE_BLOCKS: "500",
        LEDGER_PASS_MAX_RANGE_BLOCKS: "4000",
      }).maxRangeBlocks,
      ledgerPassConfig({ LEDGER_PASS_RANGE_BLOCKS: "500" }).maxRangeBlocks,
    ],
    [4000, 1000000],
  );
  assert.throws(
    () =>
      ledgerPassConfig({
        LEDGER_PASS_RANGE_BLOCKS: "500",
        LEDGER_PASS_MAX_RANGE_BLOCKS: "400",
      }),
    /Invalid LEDGER_PASS_MAX_RANGE_BLOCKS/,
  );
});

test(
  "quiet ranges grow up to the ceiling and a cut range resets to the base size",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake } = fakeChain();
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerPass(
      db,
      passClient(fake),
      runOptions(log, { maxRangeBlocks: 400 }),
    );
    assert.equal(summary.stopped, "complete");
    assert.deepEqual(
      (await batches(db)).map((r) => [r.from_block, r.to_block]),
      [
        [start, start + 99],
        [start + 100, start + 299],
      ],
    );
    const progress = log.filter((e) => e.event === "ledger_progress") as {
      rangeBlocks: number;
      cut: boolean;
      singlePage: boolean;
    }[];
    assert.deepEqual(
      progress.map((p) => [p.rangeBlocks, p.cut, p.singlePage]),
      [
        [100, false, true],
        [200, false, true],
      ],
    );
    assert.equal((await positions(db)).length, 3);
    // A range cut by a lane cap resets the next range to the base size.
    const dense = await database(t);
    await releaseLedgerWriter(db);
    await writer(dense);
    const { fake: denseFake } = fakeChain();
    denseFake.maxLogsPerPage = 1;
    const denseLog: Record<string, unknown>[] = [];
    const cutRun = await runLedgerPass(dense, passClient(denseFake), {
      ...runOptions(denseLog, { maxRangeBlocks: 400 }),
      maxPages: 2,
    });
    assert.equal(cutRun.stopped, "complete");
    const cuts = denseLog.filter((e) => e.event === "ledger_progress") as {
      rangeBlocks: number;
      cut: boolean;
      from: number;
      to: number;
    }[];
    assert.ok(cuts.some((p) => p.cut));
    const afterCut = cuts.findIndex((p) => p.cut);
    assert.equal(cuts[afterCut + 1]?.rangeBlocks, 100);
    assert.equal(cuts.at(-1)!.to, start + 299);
    assert.deepEqual(await positions(dense), await positions(db));
  },
);

test("the progress counters accumulate per run and per million blocks of history", () => {
  let now = 0;
  const progress = new LedgerPassProgress(
    {
      positions: 10,
      wallets: 4,
      batches: 2,
      swaps: 20,
      transfers: 30,
      launches: 1,
      requests: 12,
      bytes: 1000,
    },
    start,
    () => now,
  );
  const range = (
    from: number,
    to: number,
    swaps: number,
  ): LedgerRangeProgress => ({
    idle: false,
    from,
    to,
    blocks: to - from + 1,
    launches: 1,
    swaps,
    unsupportedSwaps: 0,
    transfers: swaps,
    attributed: swaps,
    unattributed: 0,
    unregisteredSwaps: 0,
    positionsChanged: swaps,
    newPositions: 5,
    newWallets: 2,
    registryPools: 3,
    swapSelection: "manager",
    pages: 3,
    requests: 6,
    bytes: 500,
    sentBytes: 2000,
    elapsedMs: 10,
    archiveHeight: start + 5_000_000,
    replayed: false,
    rangeBlocks: to - from + 1,
    cut: false,
    singlePage: true,
  });
  now = 1000;
  const first = progress.observe(range(start + 200_000, start + 699_999, 100), {
    safeTo: start + 4_000_000,
    throttled: 0,
  });
  assert.equal(first.million.length, 0);
  const p1 = first.progress as {
    run: Record<string, number>;
    total: Record<string, number>;
  };
  assert.equal(p1.run.ranges, 1);
  assert.equal(p1.run.blocks, 500_000);
  assert.equal(p1.run.blocksPerSecond, 500_000);
  assert.equal(p1.run.requestsPerMillionBlocks, 12);
  assert.equal(p1.run.etaSeconds, Math.ceil(3_300_001 / 500_000));
  assert.equal(p1.total.swaps, 120);
  assert.equal(p1.total.positions, 15);
  assert.equal(p1.total.pairsPerSwap, Number((15 / 120).toFixed(4)));
  now = 2000;
  const second = progress.observe(
    range(start + 700_000, start + 1_199_999, 50),
    { safeTo: start + 4_000_000, throttled: 1 },
  );
  assert.equal(second.million.length, 1);
  const m = second.million[0] as Record<string, unknown>;
  assert.deepEqual(
    [
      m.million,
      m.partial,
      m.blocks,
      m.swaps,
      m.requests,
      m.requestsPerMillionBlocks,
    ],
    [0, true, 1_000_000, 150, 12, 12],
  );
  const p2 = second.progress as {
    run: Record<string, number>;
    total: Record<string, number>;
  };
  assert.equal(p2.run.throttled, 1);
  assert.equal(p2.total.batches, 4);
  const replayed = progress.observe(
    { ...range(start + 1_200_000, start + 1_299_999, 7), replayed: true },
    { safeTo: start + 4_000_000, throttled: 1 },
  );
  assert.equal(
    (replayed.progress as { total: Record<string, number> }).total.swaps,
    170,
  );
  assert.equal(
    (replayed.progress as { run: Record<string, number> }).run.ranges,
    3,
  );
});
