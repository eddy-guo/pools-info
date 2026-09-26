import test from "node:test";
import assert from "node:assert/strict";
import { HyperSyncClient } from "./hypersync";
import {
  collectCrowdRange,
  crowdCreationQuery,
  crowdLaunchQuery,
  verifyCrowdLaunchBatch,
  type CrowdLaunchBatch,
} from "./hypersync-crowd";
import { ledgerPassPolicy } from "./hypersync-ledger";
import {
  FakeHyperSync,
  fakeCrowdLaunch,
  fakeMetadataRpc,
  fakeSwap,
  fakeTransfer,
  word,
} from "./hypersync-fake";
import { crowdStrategies, type CrowdAuction } from "./crowd";

const start = ledgerPassPolicy.startBlock;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const T = addr(0x1111),
  A = addr(0xa0c1),
  C = addr(0xc0de),
  W = addr(0x3333),
  X = addr(0x4444);
const client = (fake: FakeHyperSync) =>
  new HyperSyncClient({
    token: "x".repeat(16),
    minIntervalMs: 0,
    fetch: fake.fetch,
  });
const launch = (overrides?: Parameters<typeof fakeCrowdLaunch>[0]["overrides"]) =>
  fakeCrowdLaunch({
    creationBlock: start + 10,
    migrationBlock: start + 500,
    token: T,
    auction: A,
    creator: C,
    creationTx: word(0xc1),
    migrationTx: word(0xc2),
    metadata: { description: "crowd", website: "https://x.test", image: "https://x.test/a.png" },
    overrides,
  });

test("a crowd launch registers at its migration with its creator, metadata and trades from the migration on", async () => {
  const l = launch();
  const fake = new FakeHyperSync({
    height: start + 2000,
    logs: [
      ...l.logs,
      // An auction claim before the pool exists is not the pool's history.
      fakeTransfer({ block: start + 400, logIndex: 0, token: T, from: A, to: W, value: 5n }),
      fakeSwap({ block: start + 600, logIndex: 1, poolId: l.poolId, from: W, transactionHash: word(0x601) }),
      fakeTransfer({ block: start + 600, logIndex: 2, token: T, from: "0x8366a39cc670b4001a1121b8f6a443a643e40951", to: W, value: 200n, transactionHash: word(0x601), sender: W }),
    ],
  });
  const c = await collectCrowdRange(client(fake), fakeMetadataRpc({ [T]: ["Crowd", "CRWD", 18] }), {
    fromBlock: start,
    toBlock: start + 1000,
    parentHash: null,
    height: fake.height,
    registry: [],
    pending: [],
  });
  assert.equal(c.toBlock, start + 1000);
  assert.equal(c.launch.pools.length, 1);
  const pool = c.launch.pools[0];
  assert.equal(pool.id, l.poolId);
  assert.equal(pool.launchType, "crowd");
  assert.equal(pool.launchBlock, start + 500);
  assert.equal(pool.launchTx, word(0xc2));
  // The creator started the auction; a keeper sent the migration.
  assert.equal(pool.launchSender, C);
  assert.equal(pool.creatorFees, true);
  assert.equal(pool.name, "Crowd");
  assert.equal(pool.imageUrl, "https://x.test/a.png");
  assert.equal(c.launch.auctions.length, 1);
  assert.equal(c.launch.auctions[0].auction, A);
  assert.deepEqual(
    c.swaps.map((s) => [s.block, s.initiator]),
    [[start + 600, W]],
  );
  assert.deepEqual(
    c.transfers.map((t) => t.block),
    [start + 600],
  );
  // Launch lane, the creation block read again, swaps, transfers, the cutoff
  // and (first range) the parent header.
  assert.equal(c.requests, 6);
  assert.deepEqual(c.query.creations, [crowdCreationQuery(start + 10)]);
  verifyCrowdLaunchBatch(c.launch);
});

test("a creation remembered from an earlier range graduates in a later one", async () => {
  const l = launch();
  const fake = new FakeHyperSync({ height: start + 2000, logs: l.logs });
  const first = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start,
    toBlock: start + 100,
    parentHash: null,
    height: fake.height,
    registry: [],
    pending: [],
  });
  assert.equal(first.launch.pools.length, 0);
  assert.equal(first.launch.auctions.length, 1);
  verifyCrowdLaunchBatch(first.launch);
  const second = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start + 101,
    toBlock: start + 1000,
    parentHash: first.blockHash,
    height: fake.height,
    registry: [],
    pending: first.launch.auctions,
  });
  assert.deepEqual(
    second.launch.pools.map((p) => p.id),
    [l.poolId],
  );
  assert.equal(second.launch.auctions.length, 0);
  // Without the remembered creation, the migration is someone else's.
  const unknown = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start + 101,
    toBlock: start + 1000,
    parentHash: first.blockHash,
    height: fake.height,
    registry: [],
    pending: [],
  });
  assert.equal(unknown.launch.pools.length, 0);
  assert.equal(unknown.launch.evidence.migrations.length, 0);
});

test("the template rule keeps other launchpads' auctions out", async () => {
  for (const overrides of [
    { amount: 10n ** 26n },
    { tokensRecipient: addr(0xbeef) },
    { blocks: 1200 },
  ]) {
    const l = launch(overrides);
    const fake = new FakeHyperSync({ height: start + 2000, logs: l.logs });
    const c = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
      fromBlock: start,
      toBlock: start + 1000,
      parentHash: null,
      height: fake.height,
      registry: [],
      pending: [],
    });
    assert.equal(c.launch.pools.length, 0, Object.keys(overrides)[0]);
    assert.equal(c.launch.auctions.length, 0);
    assert.equal(c.launch.evidence.creations.length, 0);
  }
  // A hooked pool or an unpinned fee splitter is not admitted either.
  for (const overrides of [{ hook: addr(0x99) }, { positionRecipient: addr(0x98) }]) {
    const l = launch(overrides);
    const fake = new FakeHyperSync({ height: start + 2000, logs: l.logs });
    const c = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
      fromBlock: start,
      toBlock: start + 1000,
      parentHash: null,
      height: fake.height,
      registry: [],
      pending: [],
    });
    assert.equal(c.launch.auctions.length, 0, Object.keys(overrides)[0]);
  }
});

test("a graduation without pools.xyz's launcher in its creation is recorded and refused", async () => {
  const l = fakeCrowdLaunch({
    creationBlock: start + 10,
    migrationBlock: start + 500,
    token: T,
    auction: A,
    creator: C,
    creationTx: word(0xc1),
    migrationTx: word(0xc2),
    launcher: false,
  });
  const fake = new FakeHyperSync({ height: start + 2000, logs: l.logs });
  const c = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start,
    toBlock: start + 1000,
    parentHash: null,
    height: fake.height,
    registry: [],
    pending: [],
  });
  assert.equal(c.launch.pools.length, 0);
  assert.deepEqual(c.launch.evidence.rejected, [{ auction: A, reason: "no_launcher" }]);
  verifyCrowdLaunchBatch(c.launch);
});

test("the verifier refuses a crowd batch its evidence does not support", async () => {
  const l = launch();
  const fake = new FakeHyperSync({ height: start + 2000, logs: l.logs });
  const c = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start,
    toBlock: start + 1000,
    parentHash: null,
    height: fake.height,
    registry: [],
    pending: [],
  });
  const batch = c.launch;
  const tampered: ((b: CrowdLaunchBatch) => CrowdLaunchBatch)[] = [
    (b) => ({ ...b, pools: [{ ...b.pools[0], launchSender: X }] }),
    (b) => ({ ...b, pools: [{ ...b.pools[0], creatorFees: false }] }),
    (b) => ({ ...b, pools: [] }),
    (b) => ({ ...b, auctions: [] }),
    (b) => ({
      ...b,
      auctions: [{ ...b.auctions[0], poolId: word(7) } as CrowdAuction],
    }),
    (b) => ({ ...b, evidence: { ...b.evidence, rejected: [{ auction: A, reason: "no_launcher" }] } }),
    (b) => ({ ...b, evidence: { ...b.evidence, launches: [] } }),
    (b) => ({
      ...b,
      evidence: {
        ...b.evidence,
        launches: [{ ...b.evidence.launches[0], logs: b.evidence.launches[0].logs.slice(1) }],
      },
    }),
    (b) => ({
      ...b,
      evidence: { ...b.evidence, query: crowdLaunchQuery({ fromBlock: start + 1, toBlock: start + 1000 }) },
    }),
    (b) => ({ ...b, evidence: { ...b.evidence, creations: b.evidence.creations.slice(1) } }),
  ];
  for (const [i, change] of tampered.entries())
    assert.throws(() => verifyCrowdLaunchBatch(change(structuredClone(batch))), Error, `case ${i}`);
  verifyCrowdLaunchBatch(structuredClone(batch));
});

test("a migration on the other strategy does not graduate an auction it did not register", async () => {
  const l = launch();
  const other = crowdStrategies[0].strategy;
  const migrated = l.logs[l.logs.length - 1];
  const fake = new FakeHyperSync({
    height: start + 2000,
    logs: [...l.logs.slice(0, -1), { ...migrated, address: other }],
  });
  const c = await collectCrowdRange(client(fake), fakeMetadataRpc(), {
    fromBlock: start,
    toBlock: start + 1000,
    parentHash: null,
    height: fake.height,
    registry: [],
    pending: [],
  });
  assert.equal(c.launch.pools.length, 0);
  assert.deepEqual(c.launch.evidence.rejected, [{ auction: A, reason: "pool_mismatch" }]);
});
