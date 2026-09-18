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
  Rpc,
  decodeAggregateRequest,
  encodeAggregateReply,
  instantDeployments,
  launchEvent,
  ledgerPassPolicy,
  type InstantDeployment,
} from "@pools/chain";
import { FakeHyperSync, fakeLaunch, word } from "@pools/chain/testing";
import {
  acquireLedgerWriter,
  createClient,
  creatorFeeCoverage,
  migrate,
  releaseLedgerWriter,
  retainedLaunchLogs,
  saveCreatorFees,
  unresolvedCreatorFeeBatches,
  type CreatorFeeRow,
  type RetainedLaunchLog,
} from "@pools/db";
import { runLedgerPass } from "./ledger-pass";
import {
  resolveCreatorFees,
  runCreatorFeeBackfill,
} from "./creator-fees-backfill";

const dbTest = { skip: !process.env.TEST_DATABASE_URL };
const start = ledgerPassPolicy.startBlock;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const S = addr(0x5555),
  TA = addr(0x1111),
  TB = addr(0x2222);
const launchTopic = toEventSelector(launchEvent);
const log = (
  n: number,
  deployment: InstantDeployment = instantDeployments[0],
): RetainedLaunchLog => ({
  address: deployment.strategy,
  topic0: launchTopic,
  topic1: word(100 + n),
  transactionHash: word(200 + n),
  blockNumber: 10 + n,
});

test("retained launch logs resolve to the emitting strategy's flag, and anything the lane would not have retained is refused", () => {
  const on = instantDeployments.find((d) => d.creatorFees)!,
    off = instantDeployments.find((d) => !d.creatorFees)!;
  assert.deepEqual(resolveCreatorFees([]), []);
  assert.deepEqual(resolveCreatorFees([log(1, on), log(2, off)]), [
    {
      poolId: word(101),
      launchTx: word(201),
      launchBlock: 11,
      creatorFees: true,
    },
    {
      poolId: word(102),
      launchTx: word(202),
      launchBlock: 12,
      creatorFees: false,
    },
  ]);
  assert.throws(
    () => resolveCreatorFees([{ ...log(1), topic0: word(1) }]),
    /not a launch/,
  );
  assert.throws(
    () => resolveCreatorFees([{ ...log(1), address: addr(0xdead) }]),
    /unknown strategy/,
  );
  assert.throws(
    () => resolveCreatorFees([log(1), { ...log(2), topic1: word(101) }]),
    /Duplicate retained launch/,
  );
});

test("the backfill walks every batch holding an unknown flag, reports a batch that filled fewer pools than selected, and stops where it is told", async () => {
  const stored = new Map<string, boolean>();
  const events: Record<string, unknown>[] = [];
  const deps = (signal?: AbortSignal) => ({
    batches: async () => [
      { batchEnd: 99, pools: 1 },
      { batchEnd: 199, pools: 2 },
    ],
    logs: async (batchEnd: number) =>
      batchEnd === 99 ? [log(1)] : [log(2), log(3, instantDeployments[1])],
    save: async (rows: CreatorFeeRow[]) => {
      let n = 0;
      for (const r of rows)
        if (!stored.has(r.poolId) && r.poolId !== word(103)) {
          stored.set(r.poolId, r.creatorFees);
          n++;
        }
      return n;
    },
    log: (e: Record<string, unknown>) => events.push(e),
    signal,
  });
  assert.deepEqual(await runCreatorFeeBackfill(deps()), {
    batches: 2,
    unresolved: 3,
    filled: 2,
    stopped: false,
  });
  assert.deepEqual(
    [...stored],
    [
      [word(101), true],
      [word(102), true],
    ],
  );
  assert.deepEqual(
    events.map((e) => [e.event, e.batchEnd, e.filled]),
    [
      ["creator_fees_batch", 99, 1],
      ["creator_fees_batch", 199, 1],
      ["creator_fees_batch_short", 199, 1],
    ],
  );
  const stop = new AbortController();
  stop.abort();
  assert.deepEqual(await runCreatorFeeBackfill(deps(stop.signal)), {
    batches: 2,
    unresolved: 3,
    filled: 0,
    stopped: true,
  });
});

function metadataRpc() {
  const rpc = new Rpc();
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return "0x3dcbde5" as T;
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
          }).functionName as "name" | "symbol" | "decimals" | "totalSupply";
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result:
                fn === "name"
                  ? "Token"
                  : fn === "symbol"
                    ? "TKN"
                    : fn === "decimals"
                      ? 18
                      : 10n ** 27n,
            }),
          };
        }),
      );
    }) as T[];
  };
  return rpc;
}
async function database(t: TestContext) {
  const db = createClient(process.env.TEST_DATABASE_URL!);
  await db.connect();
  const schema = `creator_fees_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return db;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}

test(
  "Postgres: the backfill restores, from the launch stream's retained logs alone, the flags the lane wrote at discovery",
  dbTest,
  async (t) => {
    const db = await database(t);
    // Two launches the pass records in two batches: A from a fees-on
    // strategy, B from the fees-off strategy of the same generation.
    const a = fakeLaunch({
      block: start,
      token: TA,
      sender: S,
      transactionHash: word(0xa1),
    });
    const b = fakeLaunch({
      block: start + 150,
      token: TB,
      sender: S,
      transactionHash: word(0xb1),
      deployment: instantDeployments[1],
    });
    const fake = new FakeHyperSync({
      height: start + 299 + 128,
      logs: [...a.logs, ...b.logs],
    });
    const summary = await runLedgerPass(
      db,
      new HyperSyncClient({
        token: "x".repeat(16),
        minIntervalMs: 0,
        retryBaseMs: 1,
        fetch: fake.fetch,
      }),
      {
        rangeBlocks: 100,
        maxRangeBlocks: 100,
        maxPages: 16,
        rpc: () => metadataRpc(),
        log: () => {},
      },
    );
    await releaseLedgerWriter(db);
    assert.equal(summary.stopped, "complete");
    assert.equal(summary.launches, 2);
    const flags = async () =>
      (
        await db.query(
          "SELECT pool_id,creator_fees FROM indexed_pools ORDER BY launch_block",
        )
      ).rows.map((r) => [r.pool_id, r.creator_fees]);
    const written = [
      [a.poolId, true],
      [b.poolId, false],
    ];
    assert.deepEqual(await flags(), written);
    assert.deepEqual(await unresolvedCreatorFeeBatches(db, "all"), []);

    // Rows written before migration 021 hold no flag.
    await db.query("UPDATE indexed_pools SET creator_fees=NULL");
    assert.deepEqual(await creatorFeeCoverage(db), {
      pools: 2,
      known: 0,
      unknown: 2,
      unknownUnpublished: 2,
    });
    assert.deepEqual(await unresolvedCreatorFeeBatches(db, "unpublished"), [
      { batchEnd: start + 99, pools: 1 },
      { batchEnd: start + 199, pools: 1 },
    ]);
    const events: Record<string, unknown>[] = [];
    const run = () =>
      runCreatorFeeBackfill({
        batches: () => unresolvedCreatorFeeBatches(db, "unpublished"),
        logs: (batchEnd) => retainedLaunchLogs(db, batchEnd),
        save: (rows) => saveCreatorFees(db, rows),
        log: (e) => events.push(e),
      });
    assert.deepEqual(await run(), {
      batches: 2,
      unresolved: 2,
      filled: 2,
      stopped: false,
    });
    assert.deepEqual(await flags(), written);
    assert.deepEqual(
      events.map((e) => [e.event, e.batchEnd, e.launches, e.filled]),
      [
        ["creator_fees_batch", start + 99, 1, 1],
        ["creator_fees_batch", start + 199, 1, 1],
      ],
    );
    // Idempotent: nothing left to fill, nothing rewritten.
    assert.deepEqual(await run(), {
      batches: 0,
      unresolved: 0,
      filled: 0,
      stopped: false,
    });
    assert.deepEqual(await creatorFeeCoverage(db), {
      pools: 2,
      known: 2,
      unknown: 0,
      unknownUnpublished: 0,
    });
  },
);
