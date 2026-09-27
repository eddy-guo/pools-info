import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  HyperSyncClient,
  HyperSyncPacer,
  contracts,
  crowdFactory,
  ledgerPassPolicy,
  swapLogQuery,
} from "@pools/chain";
import {
  FakeHyperSync,
  fakeCrowdLaunch,
  fakeLaunch,
  fakeMetadataRpc,
  fakeSwap,
  fakeTransfer,
  word,
  type FakeHyperSyncLog,
} from "@pools/chain/testing";
import {
  acquireLedgerWriter,
  createClient,
  crowdLedgerStream,
  migrate,
  readLedgerStream,
  releaseLedgerWriter,
  type Client,
} from "@pools/db";
import { runLedgerPass } from "./ledger-pass";
import { runLedgerCrowdRange } from "./ledger-crowd";
import {
  ledgerTipDefaults,
  runLedgerTip,
  type LedgerTipOptions,
} from "./ledger-tip";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };
const start = ledgerPassPolicy.startBlock;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const W = addr(0x3333),
  V = addr(0x4444),
  U = addr(0x6666),
  R = addr(0x7777),
  S = addr(0x5555),
  C = addr(0xc0de),
  TA = addr(0x1111),
  TX = addr(0x2222),
  TY = addr(0x2223),
  AX = addr(0xa0c1),
  AY = addr(0xa0c2);
const apiToken = "x".repeat(16);
const ts = (n: number) => 1_789_000_000 + (n - start) * 20;
const rpc = () =>
  fakeMetadataRpc({
    [TA]: ["Alpha", "A", 18],
    [TX]: ["Crowd", "CRWD", 18],
    [TY]: ["Other", "OTH", 18],
  });

async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `ledger_crowd_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  return db;
}
async function writer(db: Client) {
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
function trade(
  block: number,
  pool: string,
  token: string,
  who: string,
  side: "buy" | "sell",
  eth: bigint,
  amount: bigint,
): FakeHyperSyncLog[] {
  const tx = word(0xd00000 + block * 10);
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
/** An Instant launch A traded by W, and a pools.xyz crowd launch X created at
 * +20 and graduated at +150: an auction entrant V claims at +140, buys and sells,
 * W and the creator trade it inside the pass's range and W again at the tip.
 * Another template auction (Y) is created and never graduates. `fork`
 * changes W's sale at +380 into one at +381, from +350 on. */
function chain(options: { fork?: boolean } = {}) {
  const a = fakeLaunch({
    block: start,
    token: TA,
    sender: S,
    transactionHash: word(0xa1),
  });
  const x = fakeCrowdLaunch({
    creationBlock: start + 20,
    migrationBlock: start + 150,
    token: TX,
    auction: AX,
    creator: C,
    creationTx: word(0xc1),
    migrationTx: word(0xc2),
    metadata: { description: "X", website: "", image: "" },
  });
  const y = fakeCrowdLaunch({
    creationBlock: start + 30,
    migrationBlock: start + 10_000_000,
    token: TY,
    auction: AY,
    creator: C,
    creationTx: word(0xc3),
    migrationTx: word(0xc4),
  });
  const logs: FakeHyperSyncLog[] = [
    ...a.logs,
    ...x.logs,
    ...y.logs.slice(0, -1),
    ...trade(start + 5, a.poolId, TA, W, "buy", 10n, 200n),
    ...trade(start + 7, a.poolId, TA, W, "sell", 12n, 200n),
    // V's claim of auction tokens: no swap, so a zero-cost inflow.
    fakeTransfer({
      block: start + 140,
      logIndex: 0,
      token: TX,
      from: AX,
      to: V,
      value: 50n,
      transactionHash: word(0xe1),
      sender: V,
    }),
    fakeTransfer({
      block: start + 145,
      logIndex: 0,
      token: TX,
      from: V,
      to: R,
      value: 20n,
      transactionHash: word(0xe2),
      sender: V,
    }),
    ...trade(start + 170, x.poolId, TX, W, "buy", 10n, 100n),
    ...trade(start + 175, x.poolId, TX, C, "buy", 3n, 30n),
    ...trade(start + 180, x.poolId, TX, W, "sell", 15n, 100n),
    ...trade(start + 185, x.poolId, TX, V, "buy", 4n, 40n),
    ...trade(start + 190, x.poolId, TX, V, "sell", 7n, 50n),
    ...trade(start + 195, x.poolId, TX, R, "buy", 5n, 50n),
    ...trade(start + 250, a.poolId, TA, W, "buy", 10n, 100n),
    ...trade(start + 260, x.poolId, TX, W, "buy", 10n, 100n),
    // U first trades the crowd pool, then the Instant one.
    ...trade(start + 360, x.poolId, TX, U, "buy", 2n, 20n),
    ...trade(start + 370, a.poolId, TA, U, "buy", 2n, 20n),
    ...(options.fork
      ? trade(start + 381, x.poolId, TX, W, "sell", 20n, 100n)
      : trade(start + 380, x.poolId, TX, W, "sell", 16n, 100n)),
    ...trade(start + 420, a.poolId, TA, W, "sell", 11n, 100n),
  ];
  const fake = new FakeHyperSync({
    height: start + 499 + 128,
    logs,
    timestamp: ts,
  });
  if (options.fork) fake.reorgFrom = start + 350;
  return { fake, poolA: a.poolId, poolX: x.poolId };
}
const passClient = (fake: FakeHyperSync) =>
  new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    retryBaseMs: 1,
    fetch: fake.fetch,
  });
async function passTwoRanges(db: Client, fake: FakeHyperSync) {
  const height = fake.height;
  fake.height = start + 199 + 128;
  const summary = await runLedgerPass(db, passClient(fake), {
    rangeBlocks: 100,
    maxRangeBlocks: 100,
    maxPages: 16,
    rpc,
    maxRanges: 2,
  });
  fake.height = height;
  assert.equal(summary.stopped, "ranges");
}
function tipOptions(
  fake: FakeHyperSync,
  log: Record<string, unknown>[],
  extra: Partial<LedgerTipOptions> & {
    fetch?: typeof globalThis.fetch;
    waits?: number[];
  } = {},
): LedgerTipOptions {
  const controller = new AbortController();
  const pacer = new HyperSyncPacer();
  const { fetch, waits, ...rest } = extra;
  return {
    client: () =>
      new HyperSyncClient({
        token: apiToken,
        minIntervalMs: 0,
        retryBaseMs: 1,
        maxRequests: ledgerTipDefaults.maxRequestsPerCycle,
        pacer,
        fetch: fetch ?? fake.fetch,
        signal: controller.signal,
      }),
    rpc,
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
/** The ledger's rows per pool, keyed by pool id and wallet address; `pools`
 * restricts them to those pools. */
async function rows(db: Client, pools?: string[]) {
  const q = async (sql: string) =>
    (await db.query(sql, pools ? [pools] : [])).rows;
  const where = pools ? " WHERE p.pool_id=ANY($1::text[])" : "";
  return {
    catalog: await q(
      `SELECT p.pool_id,p.token,p.name,p.launch_type,p.launch_block::text,p.launch_tx,p.launch_sender,p.creator_fees,p.source_stream,p.image_url,p.description FROM indexed_pools p${where} ORDER BY 1`,
    ),
    positions: await q(
      `SELECT p.pool_id,encode(w.address,'hex') AS wallet,(to_jsonb(x)-'pool_ref'-'wallet_ref')::text AS row FROM agg_positions x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref)${where} ORDER BY 1,2`,
    ),
    walletHours: await q(
      `SELECT p.pool_id,encode(w.address,'hex') AS wallet,x.hour,(to_jsonb(x)-'pool_ref'-'wallet_ref')::text AS row FROM agg_wallet_hours x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref)${where} ORDER BY 1,2,3`,
    ),
    poolHours: await q(
      `SELECT p.pool_id,x.hour,(to_jsonb(x)-'pool_ref')::text AS row FROM agg_pool_hours x JOIN indexed_pools p USING(pool_ref)${where} ORDER BY 1,2`,
    ),
    poolState: await q(
      `SELECT p.pool_id,(to_jsonb(x)-'pool_ref')::text AS row FROM agg_pool_state x JOIN indexed_pools p USING(pool_ref)${where} ORDER BY 1`,
    ),
    liveTrades: await q(
      `SELECT encode(x.tx_hash,'hex') AS tx,x.log_index,p.pool_id,encode(w.address,'hex') AS wallet,(to_jsonb(x)-'pool_ref'-'wallet_ref'-'stream_key'-'batch_end')::text AS row FROM agg_live_trades x JOIN indexed_pools p USING(pool_ref) LEFT JOIN agg_wallets w USING(wallet_ref)${where} ORDER BY x.block_number,x.log_index`,
    ),
  };
}
const windows = async (db: Client) =>
  (
    await db.query(
      `SELECT x."window",encode(w.address,'hex') AS wallet,x.realized_wei::text,x.trades,x.supported_positions,x.excluded_positions,x.rank FROM agg_wallet_windows x JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2`,
    )
  ).rows;
const mainBatches = async (db: Client) =>
  (
    await db.query(
      "SELECT to_block::text,encode(content_hash,'hex') AS content FROM agg_batches WHERE stream_key='ledger:agg:v1' ORDER BY to_block",
    )
  ).rows;

test(
  "a page cut before migration commits and the next crowd range graduates the pool",
  dbTest,
  async (t) => {
    const db = await database(t);
    await writer(db);
    const { fake, poolX } = chain();
    await passTwoRanges(db, fake);
    const firstSwapQuery = swapLogQuery(
      { fromBlock: start, toBlock: start + 199 },
      [poolX],
      ledgerPassPolicy.poolIdsPerQuery,
    );
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (
        typeof init?.body === "string" &&
        isDeepStrictEqual(JSON.parse(init.body), firstSwapQuery)
      )
        return Response.json(
          fake.respond({ ...firstSwapQuery, to_block: start + 145 }),
        );
      return fake.fetch(input, init);
    };
    const client = new HyperSyncClient({
      token: apiToken,
      minIntervalMs: 0,
      fetch,
    });
    const options = {
      rangeBlocks: 200,
      maxPages: 1,
      height: fake.height,
      rpc,
    };
    const first = await runLedgerCrowdRange(db, client, options);
    if (first.idle) throw Error("crowd range did not run");
    assert.equal(first.to, start + 144);
    assert.equal(first.launches, 0);
    assert.equal(
      (await readLedgerStream(db, crowdLedgerStream.key)).cursor,
      first.to,
    );

    const second = await runLedgerCrowdRange(db, client, options);
    if (second.idle) throw Error("crowd range did not continue");
    assert.equal(second.from, start + 145);
    assert.equal(second.to, start + 199);
    assert.equal(second.launches, 1);
    assert.equal(
      (await readLedgerStream(db, crowdLedgerStream.key)).cursor,
      second.to,
    );
    const crowd = await rows(db, [poolX]);
    assert.deepEqual(
      crowd.catalog.map((p) => p.pool_id),
      [poolX],
    );
    assert.equal(
      JSON.parse(crowd.positions.find((p) => p.wallet === R.slice(2))!.row)
        .supported,
      false,
    );
    await releaseLedgerWriter(db);
  },
);

test(
  "the crowd lane catches a crowd launch up inside the tip loop, folds its pool like any other, excludes the auction entrant and leaves every Instant row as it was",
  dbTest,
  async (t) => {
    // The same chain with the crowd lane off: today's ledger.
    const off = await database(t);
    await writer(off);
    const plain = chain();
    await passTwoRanges(off, plain.fake);
    await runLedgerTip(off, tipOptions(plain.fake, []));
    const instantOff = await rows(off, [plain.poolA]);
    const batchesOff = await mainBatches(off);
    await releaseLedgerWriter(off);

    const db = await database(t);
    await writer(db);
    const { fake, poolA, poolX } = chain();
    await passTwoRanges(db, fake);
    const log: Record<string, unknown>[] = [];
    const waits: number[] = [];
    const summary = await runLedgerTip(
      db,
      tipOptions(fake, log, { crowdEnabled: true, waits }),
    );
    assert.equal(summary.stopped, "aborted");
    assert.deepEqual(waits, [60000]);
    // The main stream is exactly today's, batch for batch.
    assert.deepEqual(await mainBatches(db), batchesOff);
    assert.deepEqual(await rows(db, [poolA]), instantOff);
    // The crowd stream caught up in one range, then followed each cycle.
    const cycles = log.filter((e) => e.event === "ledger_tip_cycle") as {
      crowd: {
        level: boolean;
        ranges: {
          from: number;
          to: number;
          launches: number;
          auctions: number;
        }[];
      };
    }[];
    assert.deepEqual(
      cycles.map((c) =>
        c.crowd.ranges.map((r) => [r.from, r.to, r.launches, r.auctions]),
      ),
      [
        [[start, start + 299, 1, 2]],
        [[start + 300, start + 399, 0, 0]],
        [[start + 400, start + 499, 0, 0]],
      ],
    );
    assert.ok(cycles.every((c) => c.crowd.level));
    const crowd = await readLedgerStream(db, crowdLedgerStream.key);
    assert.deepEqual([crowd.cursor, crowd.mode], [start + 499, "tip"]);
    assert.equal(crowd.hash, (await readLedgerStream(db)).hash);
    // X registers at its migration, credited to the auction's creator.
    const x = await rows(db, [poolX]);
    assert.deepEqual(x.catalog, [
      {
        pool_id: poolX,
        token: TX,
        name: "Crowd",
        launch_type: "crowd",
        launch_block: String(start + 150),
        launch_tx: word(0xc2),
        launch_sender: C,
        creator_fees: true,
        source_stream: "launches:crowd:v1",
        image_url: null,
        description: "X",
      },
    ]);
    const position = (wallet: string) =>
      JSON.parse(x.positions.find((p) => p.wallet === wallet.slice(2))!.row);
    // W's round trip is a supported position; the entrant's is excluded.
    assert.equal(position(W).supported, true);
    assert.equal(position(W).realized_wei, 5 + 6);
    assert.equal(position(V).supported, false);
    assert.deepEqual(position(V).flags, [
      "unattributed_outflow",
      "zero_cost_inflow",
    ]);
    assert.equal(position(V).buys, 1);
    assert.equal(position(V).inflow_raw, 50);
    assert.equal(position(V).outflow_raw, 20);
    assert.equal(position(V).quantity_raw, 20);
    assert.equal(position(R).supported, false);
    assert.deepEqual(position(R).flags, ["zero_cost_inflow"]);
    assert.equal(position(R).buys, 1);
    assert.equal(position(R).inflow_raw, 20);
    assert.equal(position(R).quantity_raw, 70);
    assert.equal(position(C).supported, true);
    const state = JSON.parse(x.poolState[0].row);
    assert.equal(state.trades, 9);
    assert.equal(state.volume_wei, 10 + 3 + 4 + 15 + 7 + 5 + 10 + 2 + 16);
    assert.equal(state.holders, 4);
    // The pending auction is remembered, not registered.
    const pending = await db.query(
      "SELECT auction FROM crowd_auctions ORDER BY auction",
    );
    assert.deepEqual(
      pending.rows.map((r) => r.auction),
      [AX, AY],
    );
    // The windows count the crowd trades, as a full rebuild does.
    const incremental = await windows(db);
    await db.query("DELETE FROM agg_window_refreshes");
    const { refreshLedgerWindows } = await import("@pools/db");
    await refreshLedgerWindows(db, { rebuild: true });
    assert.deepEqual(incremental, await windows(db));
    assert.ok(
      incremental.some(
        (w) =>
          w.window === "All" &&
          w.wallet === W.slice(2) &&
          w.realized_wei === String(2 + 1 + 5 + 6),
      ),
    );
    await releaseLedgerWriter(db);
  },
);

test(
  "a crowd lane that fails is backed off and the main stream carries on unchanged",
  dbTest,
  async (t) => {
    const off = await database(t);
    await writer(off);
    const plain = chain();
    await passTwoRanges(off, plain.fake);
    await runLedgerTip(off, tipOptions(plain.fake, []));
    const batchesOff = await mainBatches(off);
    await releaseLedgerWriter(off);

    const db = await database(t);
    await writer(db);
    const { fake } = chain();
    await passTwoRanges(db, fake);
    const log: Record<string, unknown>[] = [];
    // The crowd launch lane's queries are refused; everything else answers.
    const refusing: typeof globalThis.fetch = async (input, init) => {
      if (
        typeof init?.body === "string" &&
        init.body.includes(crowdFactory.address)
      )
        return new Response("bad request", { status: 400 });
      return fake.fetch(input, init);
    };
    const summary = await runLedgerTip(
      db,
      tipOptions(fake, log, { crowdEnabled: true, fetch: refusing }),
    );
    assert.equal(summary.stopped, "aborted");
    assert.equal(summary.failures, 0);
    assert.deepEqual(await mainBatches(db), batchesOff);
    const failed = log.filter((e) => e.event === "ledger_crowd_failed");
    // The first cycle's failure skips the lane for the second; the third
    // tries again.
    assert.equal(failed.length, 2);
    const cycles = log.filter((e) => e.event === "ledger_tip_cycle") as {
      crowd: { failed: string | null } | null;
    }[];
    assert.deepEqual(
      cycles.map((c) => c.crowd && !!c.crowd.failed),
      [true, null, true],
    );
    assert.equal(
      (await readLedgerStream(db, crowdLedgerStream.key)).cursor,
      null,
    );
    await releaseLedgerWriter(db);
  },
);

test(
  "after a reorg both streams walk back and fold the canonical chain as a straight run does",
  dbTest,
  async (t) => {
    const straight = await database(t);
    await writer(straight);
    const forked = chain({ fork: true });
    await passTwoRanges(straight, forked.fake);
    await runLedgerTip(
      straight,
      tipOptions(forked.fake, [], { crowdEnabled: true }),
    );
    const expected = await rows(straight);
    const expectedWindows = await windows(straight);
    await releaseLedgerWriter(straight);

    const db = await database(t);
    await writer(db);
    const first = chain();
    await passTwoRanges(db, first.fake);
    await runLedgerTip(db, tipOptions(first.fake, [], { crowdEnabled: true }));
    // The provider now serves the fork from +350 on, and more blocks.
    const second = chain({ fork: true });
    second.fake.height += 100;
    const log: Record<string, unknown>[] = [];
    await runLedgerTip(
      db,
      tipOptions(second.fake, log, { crowdEnabled: true }),
    );
    assert.ok(log.some((e) => e.event === "ledger_walk_back"));
    assert.ok(log.some((e) => e.event === "ledger_crowd_walk_back"));
    assert.deepEqual(await rows(db), expected);
    assert.deepEqual(await windows(db), expectedWindows);
    await releaseLedgerWriter(db);
  },
);
