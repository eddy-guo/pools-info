import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  toEventSelector,
  type Hex,
} from "viem";
import {
  HyperSyncClient,
  HyperSyncPacer,
  Rpc,
  collectLedgerRange,
  contracts,
  decodeAggregateRequest,
  encodeAggregateReply,
  instantDeployments,
  ledgerPassPolicy,
  swapEvent,
  type HyperSyncRetryEvent,
} from "@pools/chain";
import {
  FakeHyperSync,
  fakeLaunch,
  fakeSwap,
  fakeTransfer,
  word,
  type FakeHyperSyncLog,
  type FakeHyperSyncOptions,
} from "@pools/chain/testing";
import {
  acquireLedgerWriter,
  commitBatch,
  createClient,
  ensureLedgerStream,
  getStream,
  ledgerLaunchStreamIdentity,
  ledgerRegistry,
  migrate,
  readLedgerStream,
  releaseLedgerWriter,
  type Client,
} from "@pools/db";
import { reconcileLedgerPass, runLedgerPass } from "./ledger-pass";
import {
  ledgerTipConfig,
  ledgerTipDefaults,
  ledgerTipExitCodes,
  ledgerTipSafeError,
  nextLedgerTipRange,
  runLedgerTip,
  runLedgerTipCycle,
  type LedgerTipOptions,
} from "./ledger-tip";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };
const start = ledgerPassPolicy.startBlock;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const W = addr(0x3333),
  V = addr(0x4444),
  U = addr(0x6666),
  S = addr(0x5555),
  TA = addr(0x1111),
  TB = addr(0x2222),
  TC = addr(0x7777);
const apiToken = "x".repeat(16);
/** Twenty seconds per block, so a round trip two blocks apart is held 40 s. */
const ts = (n: number) => 1_789_000_000 + (n - start) * 20;
const rpcHead = 64798181;
const tokens: Record<string, [string, string, number, bigint]> = {
  [TA]: ["Alpha", "A", 18, 10n ** 27n],
  [TB]: ["Beta", "B", 18, 10n ** 27n],
  [TC]: ["Gamma", "C", 6, 123456789n],
};

async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `ledger_tip_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  return db;
}
/** The ledger writer lock is one per server; a sibling test file may hold it. */
async function writer(db: Client) {
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
/** The public RPC as the launch lane reads it: name, symbol, decimals and
 * total supply through Multicall3 at a fixed head, and nothing else. */
function metadataRpc() {
  const rpc = new Rpc();
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return `0x${rpcHead.toString(16)}` as T;
    throw Error(`Unexpected JSON-RPC ${method}`);
  };
  rpc.logs = async () => {
    throw Error("Unexpected JSON-RPC eth_getLogs");
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method !== "eth_call") throw Error(`Unexpected JSON-RPC ${method}`);
    return params.map((p) => {
      const { data } = p[0] as { to: Hex; data: Hex };
      return encodeAggregateReply(
        decodeAggregateRequest(data).map((member) => {
          const fn = decodeFunctionData({
            abi: erc20Abi,
            data: member.callData,
          }).functionName;
          const [name, symbol, decimals, supply] =
            tokens[member.target.toLowerCase()];
          const result =
            fn === "name"
              ? name
              : fn === "symbol"
                ? symbol
                : fn === "decimals"
                  ? decimals
                  : supply;
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result,
            } as Parameters<typeof encodeFunctionResult>[0]),
          };
        }),
      );
    }) as T[];
  };
  return rpc;
}
/** A wallet's own trade: the manager swap and the matching token transfer in
 * one transaction. */
function trade(
  block: number,
  pool: string,
  token: string,
  who: string,
  side: "buy" | "sell",
  eth: bigint,
  amount: bigint,
  tx = word(0xd00000 + block * 10),
): FakeHyperSyncLog[] {
  return [
    fakeSwap({
      block,
      logIndex: 0,
      poolId: pool,
      from: who,
      amounts: side === "buy" ? [-eth, amount] : [eth, -amount],
      transactionHash: tx,
    }),
    fakeTransfer({
      block,
      logIndex: 1,
      token,
      from: side === "buy" ? contracts.manager : who,
      to: side === "buy" ? who : contracts.manager,
      value: amount,
      transactionHash: tx,
      sender: who,
    }),
  ];
}
/** Launches A and B and a flash round trip in the pass's two ranges; in the
 * three ranges after them, launch C with a flash round trip, five more round
 * trips for W, a long hold, a plain transfer, a buy of B and an unsupported
 * swap. `forked` replaces W's sale at 380 with a larger one at 381. */
function tipChain(
  options: {
    forked?: boolean;
    intercept?: FakeHyperSyncOptions["intercept"];
  } = {},
) {
  const a = fakeLaunch({
    block: start,
    token: TA,
    sender: S,
    transactionHash: word(0xa1),
    metadata: { description: "A", website: "", image: "" },
  });
  const b = fakeLaunch({
    block: start + 150,
    token: TB,
    sender: S,
    transactionHash: word(0xb1),
  });
  // C launches from the fees-off strategy: the tip writes the emitting
  // deployment's flag, as the pass does for A and B.
  const c = fakeLaunch({
    block: start + 230,
    token: TC,
    sender: S,
    transactionHash: word(0xc1),
    deployment: instantDeployments[1],
  });
  const A = (
    block: number,
    who: string,
    side: "buy" | "sell",
    eth: bigint,
    n: bigint,
  ) => trade(block, a.poolId, TA, who, side, eth, n);
  const logs: FakeHyperSyncLog[] = [
    ...a.logs,
    ...b.logs,
    ...c.logs,
    ...A(start + 5, W, "buy", 10n, 200n),
    ...A(start + 7, W, "sell", 12n, 200n),
    ...A(start + 20, V, "buy", 10n, 100n),
    ...trade(start + 240, c.poolId, TC, U, "buy", 5n, 50n),
    ...trade(start + 242, c.poolId, TC, U, "sell", 6n, 50n),
    ...[0, 1, 2, 3, 4].flatMap((i) => [
      ...A(start + 250 + 2 * i, W, "buy", 10n, 100n),
      ...A(start + 251 + 2 * i, W, "sell", 11n + BigInt(i), 100n),
    ]),
    ...A(start + 300, W, "buy", 10n, 100n),
    ...(options.forked
      ? A(start + 381, W, "sell", 20n, 100n)
      : A(start + 380, W, "sell", 15n, 100n)),
    fakeTransfer({
      block: start + 390,
      logIndex: 0,
      token: TA,
      from: V,
      to: U,
      value: 50n,
      transactionHash: word(0xe1),
    }),
    ...trade(start + 450, b.poolId, TB, V, "buy", 4n, 40n),
    fakeSwap({
      block: start + 460,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [5n, 5n],
      transactionHash: word(0xe2),
    }),
  ];
  const fake = new FakeHyperSync({
    height: start + 499 + 128,
    logs,
    timestamp: ts,
    intercept: options.intercept,
  });
  if (options.forked) fake.reorgFrom = start + 350;
  return { fake, poolA: a.poolId, poolC: c.poolId };
}
const passClient = (fake: FakeHyperSync) =>
  new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    retryBaseMs: 1,
    fetch: fake.fetch,
  });
/** The pass over its two ranges, leaving the stream in mode 'pass' at
 * start + 199, as a stopped pass leaves it. */
async function passTwoRanges(db: Client, fake: FakeHyperSync) {
  const height = fake.height;
  fake.height = start + 199 + 128;
  const summary = await runLedgerPass(db, passClient(fake), {
    rangeBlocks: 100,
    maxRangeBlocks: 100,
    maxPages: 16,
    rpc: metadataRpc,
    maxRanges: 2,
  });
  fake.height = height;
  assert.equal(summary.stopped, "ranges");
  assert.equal((await readLedgerStream(db)).cursor, start + 199);
}
/** Tip options over a fake: 100-block ranges (the pass's boundaries), a
 * refresh on every cycle, and a wait that ends the run at the confirmed tip. */
function tipOptions(
  fake: FakeHyperSync,
  log: Record<string, unknown>[],
  extra: Partial<LedgerTipOptions> & {
    fetch?: typeof globalThis.fetch;
    onRetry?: (e: HyperSyncRetryEvent) => void;
    waits?: number[];
  } = {},
): LedgerTipOptions & { controller: AbortController } {
  const controller = new AbortController();
  const pacer = new HyperSyncPacer();
  const { fetch, onRetry, waits, ...rest } = extra;
  return {
    controller,
    client: () =>
      new HyperSyncClient({
        token: apiToken,
        minIntervalMs: 0,
        retryBaseMs: 1,
        maxRequests: ledgerTipDefaults.maxRequestsPerCycle,
        pacer,
        fetch: fetch ?? fake.fetch,
        signal: controller.signal,
        onRetry,
      }),
    rpc: metadataRpc,
    rangeBlocks: 100,
    maxRangeBlocks: 100,
    maxPages: 16,
    pollMs: 60000,
    windowRefreshMs: 0,
    signal: controller.signal,
    log: (e) => log.push(e),
    wait: async (ms) => {
      waits?.push(ms);
      if (ms === 60000) controller.abort();
    },
    ...rest,
  };
}
/** Every ledger table and the catalogue with surrogates resolved and amounts
 * kept exact (jsonb text); `windows` adds the leaderboard tables. */
async function snapshot(db: Client, windows = false) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    stream: await q(
      "SELECT cursor_block::text,encode(cursor_hash,'hex') AS hash,cursor_timestamp::text,mode FROM agg_streams",
    ),
    launches: (await getStream(db, ledgerLaunchStreamIdentity.key)).cursor,
    catalog: await q(
      "SELECT pool_id,token,name,symbol,decimals,token_total_supply_raw::text AS supply,token_supply_block::text AS supply_block,creator_fees,launch_block::text,launch_sender,source_stream,source_batch::text FROM indexed_pools ORDER BY launch_block,pool_id",
    ),
    wallets: await q(
      "SELECT encode(address,'hex') AS address,first_block::text FROM agg_wallets ORDER BY address",
    ),
    positions: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,(to_jsonb(x)-'pool_ref'-'wallet_ref')::text AS row FROM agg_positions x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2",
    ),
    walletHours: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,x.hour,(to_jsonb(x)-'pool_ref'-'wallet_ref')::text AS row FROM agg_wallet_hours x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2,3",
    ),
    poolHours: await q(
      "SELECT p.pool_id,x.hour,(to_jsonb(x)-'pool_ref')::text AS row FROM agg_pool_hours x JOIN indexed_pools p USING(pool_ref) ORDER BY 1,2",
    ),
    poolState: await q(
      "SELECT p.pool_id,(to_jsonb(x)-'pool_ref')::text AS row FROM agg_pool_state x JOIN indexed_pools p USING(pool_ref) ORDER BY 1",
    ),
    liveTrades: await q(
      "SELECT encode(x.tx_hash,'hex') AS tx,x.log_index,p.pool_id,encode(w.address,'hex') AS wallet,(to_jsonb(x)-'pool_ref'-'wallet_ref')::text AS row FROM agg_live_trades x JOIN indexed_pools p USING(pool_ref) LEFT JOIN agg_wallets w USING(wallet_ref) ORDER BY x.block_number,x.log_index",
    ),
    batches: await q(
      "SELECT from_block::text,to_block::text,encode(block_hash,'hex') AS hash,encode(content_hash,'hex') AS content,swaps,transfers,launches,attributed,unattributed,unregistered_swaps,registry_pools FROM agg_batches ORDER BY to_block",
    ),
    ...(windows
      ? {
          windows: await q(
            `SELECT x."window",encode(w.address,'hex') AS wallet,(to_jsonb(x)-'wallet_ref'-'window_start'-'refreshed_at')::text AS row FROM agg_wallet_windows x JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2`,
          ),
          refreshes: await q(
            `SELECT "window",through_block::text,window_start,wallets,ranked FROM agg_window_refreshes ORDER BY "window"`,
          ),
        }
      : {}),
  };
}

test(
  "the tip loop takes the stream over from the pass and follows the chain: launches arrive with decimals and supply, trades fold into the pass's tables, hold times and windows follow",
  dbTest,
  async (t) => {
    // The same history folded by the pass alone.
    const straight = await database(t);
    await writer(straight);
    const { fake: whole } = tipChain();
    const passed = await runLedgerPass(straight, passClient(whole), {
      rangeBlocks: 100,
      maxRangeBlocks: 100,
      maxPages: 16,
      rpc: metadataRpc,
    });
    assert.equal(passed.stopped, "complete");
    const expected = await snapshot(straight);
    await releaseLedgerWriter(straight);

    const db = await database(t);
    await writer(db);
    const { fake, poolA, poolC } = tipChain();
    await passTwoRanges(db, fake);
    const log: Record<string, unknown>[] = [];
    const waits: number[] = [];
    const summary = await runLedgerTip(db, tipOptions(fake, log, { waits }));
    assert.equal(summary.stopped, "aborted");
    assert.deepEqual(
      [
        summary.cycles,
        summary.ranges,
        summary.from,
        summary.through,
        summary.launches,
        summary.swaps,
        summary.failures,
      ],
      [3, 3, start + 200, start + 499, 1, 15, 0],
    );
    assert.deepEqual(waits, [60000]);
    assert.ok(log.some((e) => e.event === "ledger_tip_took_over"));
    const cycles = log.filter((e) => e.event === "ledger_tip_cycle") as {
      atTip: boolean;
      remainingBlocks: number;
      range: { from: number; to: number };
    }[];
    assert.deepEqual(
      cycles.map((c) => [c.range.from, c.range.to, c.atTip, c.remainingBlocks]),
      [
        [start + 200, start + 299, false, 200],
        [start + 300, start + 399, false, 100],
        [start + 400, start + 499, true, 0],
      ],
    );
    // The same ledger and catalogue as the pass alone.
    assert.deepEqual(await snapshot(db), expected);
    // The launch that arrived at the tip is complete.
    const c = await db.query(
      "SELECT symbol,decimals,token_total_supply_raw::text AS supply,token_supply_block::int AS block,creator_fees,source_stream,source_batch::int AS batch FROM indexed_pools WHERE pool_id=$1",
      [poolC],
    );
    assert.deepEqual(c.rows, [
      {
        symbol: "C",
        decimals: 6,
        supply: "123456789",
        block: rpcHead,
        creator_fees: false,
        source_stream: "launches:agg:v1",
        batch: start + 299,
      },
    ]);
    assert.deepEqual(
      (
        await db.query(
          "SELECT creator_fees FROM indexed_pools WHERE pool_id<>$1 ORDER BY launch_block",
          [poolC],
        )
      ).rows,
      [{ creator_fees: true }, { creator_fees: true }],
    );
    // The head beside the cursor.
    const head = (
      await db.query(
        "SELECT head_block::int AS head,head_timestamp::int AS at,checked_at IS NOT NULL AS checked,mode FROM agg_streams",
      )
    ).rows[0];
    assert.deepEqual(head, {
      head: start + 627,
      at: ts(start + 627),
      checked: true,
      mode: "tip",
    });
    // Hold times folded at closure: U held C 40 s; W closed seven cycles on A,
    // six of them in under 60 s (the shortest 20 s), one held 1,600 s.
    const cyclesOf = async (pool: string, who: string) =>
      (
        await db.query(
          `SELECT closed_cycles,flash_cycles,shortest_cycle_seconds::int AS shortest FROM agg_positions p
           JOIN indexed_pools i USING (pool_ref) JOIN agg_wallets w USING (wallet_ref)
           WHERE i.pool_id=$1 AND w.address=decode($2,'hex')`,
          [pool, who.slice(2)],
        )
      ).rows[0];
    assert.deepEqual(await cyclesOf(poolC, U), {
      closed_cycles: 1,
      flash_cycles: 1,
      shortest: 40,
    });
    assert.deepEqual(await cyclesOf(poolA, W), {
      closed_cycles: 7,
      flash_cycles: 6,
      shortest: 20,
    });
    // The windows reflect the cursor; W's fourteen trades rank it.
    const refreshes = await db.query(
      `SELECT "window",through_block::int AS through FROM agg_window_refreshes ORDER BY "window"`,
    );
    assert.equal(refreshes.rows.length, 6);
    assert.ok(refreshes.rows.every((r) => r.through === start + 499));
    const board = await db.query(
      `SELECT '0x'||encode(w.address,'hex') AS wallet,x.rank,x.supported_trades,x.flash_closures FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref) WHERE x."window"='All' AND x.rank IS NOT NULL`,
    );
    assert.deepEqual(board.rows, [
      { wallet: W, rank: 1, supported_trades: 14, flash_closures: 6 },
    ]);
    // A quiet cycle at the tip is three requests: height, head, cursor.
    const cycleOptions = {
      rangeBlocks: 100,
      maxPages: 16,
      windowRefreshMs: 0,
      rpc: metadataRpc,
    };
    const tipClient = passClient(fake);
    const quiet = await runLedgerTipCycle(db, tipClient, cycleOptions);
    assert.deepEqual(
      [quiet.range, quiet.atTip, quiet.requests, quiet.windows],
      [null, true, 3, null],
    );
    // Fifty new blocks without a launch or trade: the three lanes of the
    // three-pool registry and the cutoff header make it seven. A tip range
    // selects every manager swap and sends no pool-id list.
    fake.height += 50;
    const sent = fake.requests.length;
    const small = await runLedgerTipCycle(db, passClient(fake), cycleOptions);
    assert.deepEqual(
      [small.range?.from, small.range?.to, small.atTip, small.requests],
      [start + 500, start + 549, true, 7],
    );
    assert.equal(small.range?.swapSelection, "manager");
    const swapBodies = fake.requests
      .slice(sent)
      .map((r) => r.body)
      .filter((b) => b?.logs?.[0].address?.[0] === contracts.manager);
    assert.deepEqual(
      swapBodies.map((b) => b!.logs),
      [
        [
          {
            address: [contracts.manager],
            topics: [[toEventSelector(swapEvent)]],
          },
        ],
      ],
    );
    assert.equal(
      small.sentBytes,
      fake.requests
        .slice(sent)
        .reduce(
          (n, r) =>
            n + (r.body ? Buffer.byteLength(JSON.stringify(r.body)) : 0),
          0,
        ),
    );
    assert.equal(small.windows?.throughBlock, start + 549);
  },
);

test(
  "a reorg below the cursor walks the journal back to the surviving checkpoint, restoring every pre-image, and the recollection equals a fresh build of the fork",
  dbTest,
  async (t) => {
    // A fresh build of the forked history, windows included.
    const fresh = await database(t);
    await writer(fresh);
    const { fake: forked } = tipChain({ forked: true });
    await passTwoRanges(fresh, forked);
    assert.equal(
      (await runLedgerTip(fresh, tipOptions(forked, []))).stopped,
      "aborted",
    );
    const expected = await snapshot(fresh, true);
    await releaseLedgerWriter(fresh);

    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    const log: Record<string, unknown>[] = [];
    // One cycle to start + 299: the checkpoint the fork leaves canonical.
    await runLedgerTip(db, tipOptions(fake, log, { maxCycles: 1 }));
    assert.equal((await readLedgerStream(db)).cursor, start + 299);
    const atAncestor = await snapshot(db);
    await runLedgerTip(db, tipOptions(fake, log));
    assert.equal((await readLedgerStream(db)).cursor, start + 499);
    const sale = await db.query(
      "SELECT block_number::int AS block FROM agg_live_trades WHERE side='sell' AND block_number>$1",
      [start + 300],
    );
    assert.deepEqual(sale.rows, [{ block: start + 380 }]);
    // The fork: new hashes from start + 350 and W's sale replaced.
    const replaced = tipChain({ forked: true }).fake;
    fake.logs = replaced.logs;
    fake.reorgFrom = start + 350;
    await reconcileLedgerPass(db, passClient(fake), (e) => log.push(e));
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_walk_back" &&
          e.from === start + 499 &&
          e.to === start + 299 &&
          e.removed === 2,
      ),
    );
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_launch_rewind" &&
          e.from === start + 499 &&
          e.to === start + 299,
      ),
    );
    // Walked back: exactly the ledger the checkpoint had, and the windows
    // that reflected a removed batch are due for a rebuild.
    assert.deepEqual(await snapshot(db), atAncestor);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM agg_window_refreshes"))
        .rows[0].n,
      0,
    );
    // Recollected on the fork: a fresh build of it.
    const again = await runLedgerTip(db, tipOptions(fake, log));
    assert.equal(again.through, start + 499);
    assert.deepEqual(await snapshot(db, true), expected);
    const forkedSale = await db.query(
      "SELECT block_number::int AS block,eth_wei::text AS eth,encode(block_hash,'hex') AS hash FROM agg_live_trades WHERE side='sell' AND block_number>$1",
      [start + 300],
    );
    assert.deepEqual(forkedSale.rows, [
      {
        block: start + 381,
        eth: "20",
        hash: fake.hashOf(start + 381).slice(2),
      },
    ]);
  },
);

test(
  "the loop can stop at any request and resumes to the same ledger, windows included, with its streams in lockstep at every stop",
  dbTest,
  async (t) => {
    const straight = await database(t);
    await writer(straight);
    const { fake: whole } = tipChain();
    await passTwoRanges(straight, whole);
    await runLedgerTip(straight, tipOptions(whole, []));
    const expected = await snapshot(straight, true);
    await releaseLedgerWriter(straight);

    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    let stops = 0;
    for (let budget = 1; budget < 200; budget++) {
      let requests = 0;
      const options = tipOptions(fake, [], {
        fetch: async (input, init) => {
          if (++requests === budget) options.controller.abort();
          return fake.fetch(input, init);
        },
      });
      const summary = await runLedgerTip(db, options);
      assert.equal(summary.stopped, "aborted");
      // Every stop leaves the cursor on a committed batch, both streams on it.
      const ledger = await readLedgerStream(db);
      const launches = await getStream(db, ledgerLaunchStreamIdentity.key);
      const newest = await db.query(
        "SELECT max(to_block)::int AS to_block FROM agg_batches",
      );
      assert.deepEqual(
        [launches.cursor, newest.rows[0].to_block],
        [ledger.cursor, ledger.cursor],
      );
      stops++;
      const refreshed = await db.query(
        "SELECT min(through_block)::int AS through FROM agg_window_refreshes",
      );
      if (
        ledger.cursor === start + 499 &&
        refreshed.rows[0].through === start + 499
      )
        break;
    }
    // A range cycle is seven requests: the first seven runs stop after each
    // of them in turn and commit nothing; the next three each commit a range
    // and stop inside the cycle after it, the last at the tip.
    assert.equal(stops, 10);
    assert.deepEqual(await snapshot(db, true), expected);
  },
);

test(
  "a stop between a range's launch commit and its ledger commit is rewound on the next cycle",
  dbTest,
  async (t) => {
    const straight = await database(t);
    await writer(straight);
    const { fake: whole } = tipChain();
    await passTwoRanges(straight, whole);
    await runLedgerTip(straight, tipOptions(whole, []));
    const expected = await snapshot(straight, true);
    await releaseLedgerWriter(straight);

    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    // The process dies after committing range 200-299's launches.
    const range = await collectLedgerRange(passClient(fake), metadataRpc(), {
      fromBlock: start + 200,
      toBlock: start + 299,
      parentHash: fake.hashOf(start + 199),
      height: fake.height,
      registry: await ledgerRegistry(db, start + 199),
    });
    await commitBatch(db, await getStream(db, ledgerLaunchStreamIdentity.key), {
      from: start + 200,
      to: start + 299,
      hash: range.blockHash,
      evidence: range.launch.evidence,
      pools: range.launch.pools.map((p) => ({ ...p })),
    });
    const log: Record<string, unknown>[] = [];
    await runLedgerTip(db, tipOptions(fake, log));
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_launch_rewind" &&
          e.from === start + 299 &&
          e.to === start + 199,
      ),
    );
    assert.deepEqual(await snapshot(db, true), expected);
  },
);

test(
  "a sustained throttle stops the loop for good on a committed batch: no retry cycle, exit code 75",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    // The first cycle's seven requests pass; every later one is throttled.
    let requests = 0;
    const throttledFetch: typeof globalThis.fetch = async (input, init) =>
      ++requests > 7
        ? new Response("slow down", {
            status: 429,
            headers: { "retry-after": "0" },
          })
        : fake.fetch(input, init);
    let throttled = 0;
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerTip(
      db,
      tipOptions(fake, log, {
        fetch: throttledFetch,
        onRetry: (e) => {
          if (e.reason === "throttled") throttled++;
        },
        throttled: () => throttled,
      }),
    );
    assert.equal(summary.stopped, "throttled");
    assert.equal(ledgerTipExitCodes[summary.stopped], 75);
    assert.match(summary.error!, /^hypersync_rate_limit_exhausted/);
    assert.deepEqual(
      [summary.cycles, summary.through, summary.throttled, summary.failures],
      [1, start + 299, 3, 0],
    );
    // One throttled request of four attempts, then nothing.
    assert.equal(requests, 11);
    assert.ok(!log.some((e) => e.event === "ledger_tip_cycle_failed"));
    assert.ok(
      log.some(
        (e) =>
          e.event === "ledger_tip_stopped_for_good" &&
          e.stopped === "throttled",
      ),
    );
    const ledger = await readLedgerStream(db);
    assert.equal(ledger.cursor, start + 299);
    assert.equal(
      (await getStream(db, ledgerLaunchStreamIdentity.key)).cursor,
      start + 299,
    );
  },
);

test(
  "other failures back off and give up after five cycles in a row, and a later run resumes from the cursor",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    let failing = true;
    const flaky: typeof globalThis.fetch = async (input, init) =>
      failing && String(input).endsWith("/query")
        ? new Response("unavailable", { status: 503 })
        : fake.fetch(input, init);
    const waits: number[] = [];
    const log: Record<string, unknown>[] = [];
    const summary = await runLedgerTip(
      db,
      tipOptions(fake, log, { fetch: flaky, waits }),
    );
    assert.equal(summary.stopped, "failed");
    assert.equal(ledgerTipExitCodes[summary.stopped], 1);
    assert.deepEqual(waits, [2000, 4000, 8000, 16000]);
    assert.equal(summary.failures, 5);
    assert.equal((await readLedgerStream(db)).cursor, start + 199);
    // One failure, then the provider recovers: the count resets.
    let once = true;
    const blip: typeof globalThis.fetch = async (input, init) => {
      if (once && String(input).endsWith("/query")) {
        once = false;
        return new Response("bad request", { status: 400 });
      }
      return fake.fetch(input, init);
    };
    failing = false;
    const resumed = await runLedgerTip(
      db,
      tipOptions(fake, [], { fetch: blip }),
    );
    assert.deepEqual(
      [resumed.stopped, resumed.failures, resumed.through],
      ["aborted", 1, start + 499],
    );
  },
);

test(
  "the loop refuses a database that holds no ledger, or one restored without its positions, without creating the stream or making a request",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    const log: Record<string, unknown>[] = [];
    const empty = await runLedgerTip(db, tipOptions(fake, log));
    assert.equal(empty.stopped, "inspection");
    assert.equal(ledgerTipExitCodes[empty.stopped], 78);
    assert.match(empty.error!, /^ledger_tip_requires_pass/);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM agg_streams")).rows[0].n,
      0,
    );
    // A stream the pass created but never advanced is refused the same way.
    await ensureLedgerStream(db, "pass");
    const unstarted = await runLedgerTip(db, tipOptions(fake, log));
    assert.equal(unstarted.stopped, "inspection");
    assert.equal((await readLedgerStream(db)).mode, "pass");
    assert.equal(fake.requests.length, 0);
    // A ledger restored without its positions (as production's first restore
    // was) would fold sales without their buys: refused until they are back.
    const copy = await database(t);
    await releaseLedgerWriter(db);
    await writer(copy);
    await passTwoRanges(copy, fake);
    const passRequests = fake.requests.length;
    await copy.query("CREATE TEMP TABLE kept AS SELECT * FROM agg_positions");
    await copy.query("DELETE FROM agg_positions");
    const partial = await runLedgerTip(copy, tipOptions(fake, log));
    assert.equal(partial.stopped, "inspection");
    assert.match(partial.error!, /^ledger_tip_ledger_incomplete/);
    assert.equal(fake.requests.length, passRequests);
    assert.equal((await readLedgerStream(copy)).mode, "pass");
    await copy.query("INSERT INTO agg_positions SELECT * FROM kept");
    const restored = await runLedgerTip(copy, tipOptions(fake, log));
    assert.deepEqual(
      [restored.stopped, restored.through],
      ["aborted", start + 499],
    );
  },
);

test("the configuration gates the loop, keeps the free-tier floor, refuses Alchemy and another chain's endpoint", () => {
  const off = ledgerTipConfig({});
  assert.deepEqual(off, {
    enabled: false,
    url: "https://4663.hypersync.xyz",
    token: null,
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    rangeBlocks: 2000,
    maxRangeBlocks: 100000,
    minIntervalMs: 2000,
    maxPages: 16,
    maxRequestsPerCycle: 400,
    pollMs: 60000,
    windowRefreshMs: 60000,
  });
  const on = ledgerTipConfig({
    LEDGER_TIP_ENABLED: "1",
    ENVIO_API_TOKEN: apiToken,
    LEDGER_TIP_POLL_MS: "90000",
    LEDGER_TIP_RANGE_BLOCKS: "5000",
    LEDGER_TIP_MIN_INTERVAL_MS: "3000",
  });
  assert.deepEqual(
    [
      on.enabled,
      on.token,
      on.pollMs,
      on.rangeBlocks,
      on.maxRangeBlocks,
      on.minIntervalMs,
    ],
    [true, apiToken, 90000, 5000, 100000, 3000],
  );
  for (const [env, pattern] of [
    [
      { LEDGER_TIP_MIN_INTERVAL_MS: "1999" },
      /Invalid LEDGER_TIP_MIN_INTERVAL_MS/,
    ],
    [{ LEDGER_TIP_ENABLED: "yes" }, /Invalid LEDGER_TIP_ENABLED/],
    [{ LEDGER_TIP_MAX_PAGES: "17" }, /Invalid LEDGER_TIP_MAX_PAGES/],
    [
      { LEDGER_TIP_RANGE_BLOCKS: "5000", LEDGER_TIP_MAX_RANGE_BLOCKS: "4000" },
      /Invalid LEDGER_TIP_MAX_RANGE_BLOCKS/,
    ],
    [
      {
        ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/secret",
      },
      /must be the public RPC; the ledger tip loop never reads Alchemy/,
    ],
    [
      { ROBINHOOD_RPC_URL: "https://proxy.example/alchemy/v2/secret" },
      /must be the public RPC/,
    ],
    [
      { HYPERSYNC_URL: "https://1.hypersync.xyz" },
      /HYPERSYNC_URL must be chain 4663's HyperSync endpoint/,
    ],
  ] as const)
    assert.throws(() => ledgerTipConfig(env), pattern);
  try {
    ledgerTipConfig({
      ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/secret",
    });
  } catch (e) {
    assert.equal(
      ledgerTipSafeError(e),
      "ledger_tip_configuration_invalid: ROBINHOOD_RPC_URL must be the public RPC; the ledger tip loop never reads Alchemy",
    );
  }
  assert.equal(
    ledgerTipSafeError(Error("ledger_walkback_unavailable")),
    "ledger_walkback_unavailable",
  );
  assert.equal(
    ledgerTipSafeError(
      Object.assign(Error("x"), { name: "HyperSyncRateLimitExhausted" }),
    ).split(":")[0],
    "hypersync_rate_limit_exhausted",
  );
  assert.equal(
    ledgerTipSafeError(Error("secret provider text")),
    "operation_failed: saved checkpoint preserved; inspect configuration and retry",
  );
  assert.deepEqual(ledgerTipExitCodes, {
    aborted: 0,
    cycles: 0,
    throttled: 75,
    capacity: 76,
    unauthorized: 77,
    inspection: 78,
    failed: 1,
  });
});

test("ranges grow while behind, shrink to what a cut range covered, and hold at the tip", () => {
  const bounds = { rangeBlocks: 2000, maxRangeBlocks: 100000 };
  const range = (blocks: number, cut: boolean) =>
    ({ blocks, cut }) as Parameters<typeof nextLedgerTipRange>[0];
  assert.equal(nextLedgerTipRange(null, 8000, bounds), 8000);
  assert.equal(nextLedgerTipRange(range(8000, false), 8000, bounds), 16000);
  assert.equal(nextLedgerTipRange(range(64000, false), 64000, bounds), 100000);
  assert.equal(nextLedgerTipRange(range(12345, true), 64000, bounds), 12345);
  assert.equal(nextLedgerTipRange(range(700, true), 64000, bounds), 2000);
  assert.equal(nextLedgerTipRange(range(640, false), 8000, bounds), 8000);
});

test(
  "reader warming yields to every indexing cycle and retries an interrupted set in the next idle window",
  dbTest,
  async (t) => {
    const { DatabaseWarmth } = await import("@pools/api/warmup");
    const db = await database(t);
    await writer(db);
    const { fake } = tipChain();
    await passTwoRanges(db, fake);
    const log: Record<string, unknown>[] = [];
    let active = false,
      started = 0,
      cancelled = 0,
      waits = 0;
    const starts = Array.from({ length: 2 }, () => {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    });
    const warmth = new DatabaseWarmth(async ({ signal }) => {
      assert.equal(active, false);
      active = true;
      started++;
      starts[started - 1].resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            active = false;
            cancelled++;
            resolve();
          },
          { once: true },
        ),
      );
    });
    t.after(() => warmth.close());
    const options = tipOptions(fake, log, {
      warmth,
      client: () => {
        assert.equal(
          active,
          false,
          "warm connection cancelled before next chain cycle",
        );
        return passClient(fake);
      },
      wait: async () => {
        // Let the warmer enter its statement, but deliberately never complete.
        await starts[waits].promise;
        assert.equal(active, true);
        if (++waits === 2) options.controller.abort();
      },
    });
    const summary = await runLedgerTip(db, options);
    await warmth.close();
    assert.equal(summary.stopped, "aborted");
    assert.equal(summary.through, start + 499);
    assert.equal(started, 2);
    assert.equal(cancelled, 2);
    assert.equal(active, false);
  },
);
