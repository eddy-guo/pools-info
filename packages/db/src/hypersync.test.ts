import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  HyperSyncClient,
  collectHyperSyncBroadGroup,
  collectPoolEventGroup,
  contracts,
  Rpc,
  type BroadPoolEventGroup,
  type BroadRegistryCheckpoint,
  type EventHeader,
  type HyperSyncBroadGroup,
  type RawLog,
  type Receipt,
} from "@pools/chain";
import { FakeHyperSync, word } from "@pools/chain/testing";
import {
  broadStreamIdentity,
  commitBatch,
  commitPoolGroup,
  createClient,
  discoveryV2Identity,
  ensureBroadStream,
  ensureDiscovery,
  ensureDiscoveryV2,
  getStream,
  migrate,
  nextPoolGroup,
  resolveBroadPools,
  rewind,
  type Client,
} from "./index";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error("TEST_DATABASE_URL must reference a dedicated test Postgres");
const first = discoveryV2Identity.start;
const hex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
const token = "0x1111111111111111111111111111111111111111";
const initiator = "0x2222222222222222222222222222222222222222";
const apiToken = "x".repeat(16);
const pools = [word(3), word(5)];
const unknown = word(7);
// The db package has no ABI dependency; encode the Swap words by hand.
const swapTopic =
  "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
const swapData = (amounts: [bigint, bigint]): `0x${string}` =>
  `0x${[...amounts, (1n << 96n) + 123n, 100000000000000000001n, -2n, 2500n]
    .map((n) => BigInt.asUintN(256, n).toString(16).padStart(64, "0"))
    .join("")}`;
const chainLog = (
  block: number,
  index: number,
  id = pools[0],
  amounts: [bigint, bigint] = [-10n, 200000000000000000001n],
  txHash = word(block * 100 + index),
) => ({
  block,
  logIndex: index,
  transactionHash: txHash,
  address: contracts.manager,
  topics: [swapTopic, id, word(4)],
  data: swapData(amounts),
  from: initiator,
});
const registry = (throughBlock: number): BroadRegistryCheckpoint => ({
  stream: "discovery:v2",
  revision: discoveryV2Identity.registryRevision,
  sourceRevision: discoveryV2Identity.registrySourceRevision,
  throughBlock,
  blockHash: word(throughBlock),
});
async function database(t: TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = `hypersync_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const launches = pools.map((id, i) => ({
    id,
    token,
    name: `Pool ${i}`,
    symbol: `P${i}`,
    launchBlock: first,
    launchTx: word(i + 100),
    launchSender: initiator,
    launchedAt: first * 2,
  }));
  const v1 = await ensureDiscovery(db, first);
  await commitBatch(db, v1, {
    from: first,
    to: first + 9,
    hash: word(first + 9),
    evidence: {},
    pools: launches,
  });
  const v2 = await ensureDiscoveryV2(db);
  for (const [from, to, batchPools] of [
    [first, first + 9, launches],
    [first + 10, first + 19, []],
  ] as const)
    await commitBatch(db, await getStream(db, v2.key), {
      from,
      to,
      hash: word(to),
      evidence: {
        registryRevision: discoveryV2Identity.registryRevision,
        registrySourceRevision: discoveryV2Identity.registrySourceRevision,
      },
      pools: [...batchPools],
    });
  for (const id of pools)
    await commitBatch(db, await getStream(db, `pool:${id}`), {
      from: first,
      to: first + 4,
      hash: word(first + 4),
      token,
      evidence: { deep: "retained" },
      events: [],
    });
  // Equal waiting ages isolate canonical activity rank from within-band RR.
  await db.query(
    "UPDATE indexer_streams SET attempted_at=statement_timestamp()-interval '4 hours' WHERE kind='pool'",
  );
  await ensureBroadStream(db);
  return db;
}
function client(fake: FakeHyperSync) {
  return new HyperSyncClient({
    url: "https://4663.hypersync.xyz",
    token: apiToken,
    fetch: fake.fetch,
    minIntervalMs: 0,
  });
}
async function collect(
  db: Client,
  fake: FakeHyperSync,
  from: number,
  to: number,
  through = first + 9,
) {
  const pin = registry(through);
  return collectHyperSyncBroadGroup(
    {
      fromBlock: from,
      toBlock: to,
      registry: pin,
      resolvePools: (ids) => resolveBroadPools(db, ids, pin),
    },
    client(fake),
  );
}
async function commit(
  db: Client,
  group: HyperSyncBroadGroup | BroadPoolEventGroup,
) {
  return commitPoolGroup(db, {
    mode: "broad",
    expected: await getStream(db, broadStreamIdentity.key),
    group,
  });
}
async function counts(db: Client) {
  return (
    await db.query(
      "SELECT (SELECT count(*)::int FROM broad_batches) AS batches,(SELECT count(*)::int FROM broad_swaps) AS swaps,(SELECT count(*)::int FROM broad_registry_members) AS members,(SELECT count(*)::int FROM indexer_batches WHERE stream_key='swaps:broad:v1') AS manifests",
    )
  ).rows[0];
}
/** The receipt-shaped collector over a mock RPC, for mixed-source continuity. */
async function collectRpc(
  logs: RawLog[],
  from: number,
  to: number,
  through = first + 19,
) {
  const rpc = new Rpc("http://127.0.0.1:1/no-network");
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return hex(4663) as T;
    if (method === "eth_blockNumber") return hex(first + 20000) as T;
    throw Error("Unexpected RPC method");
  };
  rpc.logs = async () => structuredClone(logs);
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p): EventHeader => {
        const n = Number(p[0]);
        return {
          number: hex(n),
          hash: word(n),
          parentHash: word(n - 1),
          timestamp: hex(n * 2),
        };
      }) as T[];
    if (method !== "eth_getTransactionReceipt")
      throw Error("Unexpected RPC batch");
    return params.map((p): Receipt => {
      const own = logs.filter((l) => l.transactionHash === p[0]);
      return {
        transactionHash: p[0] as `0x${string}`,
        blockHash: own[0].blockHash,
        status: "0x1",
        from: initiator,
        to: contracts.router,
        logs: structuredClone(own),
      };
    }) as T[];
  };
  return collectPoolEventGroup(
    {
      mode: "broad",
      fromBlock: from,
      toBlock: to,
      registry: registry(through),
      resolvePools: async (ids) =>
        pools
          .filter((id) => ids.includes(id))
          .map((poolId) => ({ poolId, token, launchBlock: first })),
    },
    rpc,
  );
}

test("a HyperSync group commits through the broad path with exact rows, retained evidence and idempotent replay", async (t) => {
  const db = await database(t);
  const fake = new FakeHyperSync({
    height: first + 10000,
    logs: [
      chainLog(first + 1, 0),
      // Two legs of one transaction keep distinct log indexes.
      chainLog(
        first + 1,
        1,
        pools[1],
        [12n, -90071992547409930001n],
        word((first + 1) * 100),
      ),
      chainLog(first + 1, 2, pools[0], [0n, 1n]),
      chainLog(first + 2, 0, unknown),
    ],
  });
  const group = await collect(db, fake, first, first + 2);
  assert.equal(group.swaps.length, 3);
  assert.equal(await commit(db, group), true);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 3,
    members: 2,
    manifests: 1,
  });
  const batch = (
    await db.query(
      "SELECT x.*,b.content_hash,b.evidence,b.block_hash FROM broad_batches x JOIN indexer_batches b ON b.chain_id=x.chain_id AND b.stream_key=x.stream_key AND b.to_block=x.batch_end",
    )
  ).rows[0];
  const serialized = JSON.stringify({ ...group, requests: 0 });
  assert.equal(batch.serialized_group, serialized);
  assert.equal(
    batch.content_hash,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.deepEqual(batch.evidence, { broadSerializerVersion: 1 });
  assert.equal(batch.block_hash, word(first + 2));
  assert.equal(batch.parent_hash, word(first - 1));
  assert.equal(Number(batch.timestamp), (first + 2) * 2);
  assert.equal(batch.observed_swaps, 4);
  assert.equal(batch.unregistered_swaps, 1);
  assert.equal(batch.unsupported_swaps, 1);
  assert.equal(batch.discovery_batch, String(first + 9));
  const retained = JSON.parse(batch.serialized_group);
  assert.equal(retained.evidence.source, "hypersync");
  assert.deepEqual(retained.evidence.unregistered, {
    swaps: 1,
    poolIds: [unknown],
  });
  assert.equal(retained.evidence.logs.length, 3);
  assert.equal(retained.evidence.transactions.length, 2);
  const rows = (await db.query("SELECT * FROM broad_swaps ORDER BY log_index"))
    .rows;
  assert.equal(rows[0].amount0, "-10");
  assert.equal(rows[0].eth_wei, "10");
  assert.equal(rows[0].token_raw, "200000000000000000001");
  assert.equal(rows[0].transaction_sender, initiator);
  assert.equal(
    rows[0].manager_sender,
    "0x0000000000000000000000000000000000000004",
  );
  assert.equal(Number(rows[0].timestamp), (first + 1) * 2);
  assert.equal(rows[1].side, "sell");
  assert.equal(rows[1].tx_hash, rows[0].tx_hash);
  assert.equal(rows[2].side, null);
  assert.deepEqual(rows[2].flags, [
    "missing_transfer_history",
    "unsupported_swap_signs",
  ]);
  assert.ok(rows.every((r) => r.supported === false));
  const stream = await getStream(db, broadStreamIdentity.key);
  assert.equal(stream.cursor, first + 2);
  assert.equal(stream.hash, word(first + 2));
  // Deep finance is untouched and the scheduler ranks the observed volume.
  const finance = (
    await db.query(
      "SELECT (SELECT count(*)::int FROM analytics_accounting_positions) AS positions,(SELECT count(*)::int FROM analytics_accounting_trades) AS trades",
    )
  ).rows[0];
  assert.deepEqual(finance, { positions: 0, trades: 0 });
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, pools[1]);
  // Replay is idempotent; a tampered row fails verification before the
  // replay lookup, and a consistent but different group for the same range
  // is a conflicting replay.
  assert.equal(await commit(db, group), false);
  const tampered = structuredClone(group);
  tampered.swaps[0].ethWei = "11";
  await assert.rejects(
    commit(db, tampered),
    /HyperSync broad rows disagree with retained evidence/,
  );
  const other = new FakeHyperSync({
    height: first + 10000,
    logs: [...fake.logs, chainLog(first + 2, 1, pools[1])],
  });
  await assert.rejects(
    commit(db, await collect(db, other, first, first + 2)),
    /Conflicting broad replay/,
  );
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 3,
    members: 2,
    manifests: 1,
  });
});

test("the writer re-derives every row and re-resolves every observed id before accepting a HyperSync group", async (t) => {
  const db = await database(t);
  const fake = new FakeHyperSync({
    height: first + 10000,
    logs: [chainLog(first + 1, 0), chainLog(first + 2, 0, unknown)],
  });
  const good = await collect(db, fake, first, first + 2);
  const tampered = (change: (g: HyperSyncBroadGroup) => void) => {
    const copy = structuredClone(good);
    change(copy);
    return copy;
  };
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.swaps[0].ethWei = "11")),
    ),
    /disagree with retained evidence/,
  );
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.swaps[0].transactionSender = unknown.slice(0, 42))),
    ),
    /disagree with retained evidence/,
  );
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.evidence.transactions[0].status = 0)),
    ),
    /lacks a consistent successful transaction/,
  );
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.observedSwaps = 1)),
    ),
    /disagree with retained evidence/,
  );
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.evidence.pages[0].archiveHeight = first + 2)),
    ),
    /pages disagree with the range/,
  );
  await assert.rejects(
    commit(
      db,
      tampered((g) => (g.tokenUnits = [])),
    ),
    /Invalid HyperSync broad group/,
  );
  // A registered pool claimed as unregistered is caught by the registry pin,
  // even though the rows themselves are internally consistent.
  const hidden = await collectHyperSyncBroadGroup(
    {
      fromBlock: first,
      toBlock: first + 2,
      registry: registry(first + 9),
      resolvePools: async () => [],
    },
    client(fake),
  );
  assert.deepEqual(hidden.evidence.unregistered.poolIds, [pools[0], unknown]);
  await assert.rejects(
    commit(db, hidden),
    /Broad registry members or source identity changed/,
  );
  assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  assert.equal(await commit(db, good), true);
  // Coverage never exceeds the pinned discovery checkpoint.
  await assert.rejects(
    collect(db, fake, first + 3, first + 25, first + 19),
    /Invalid HyperSync broad range|Invalid broad registry checkpoint/,
  );
});

test("HyperSync and receipt-shaped batches share one contiguous stream, and canonical rewind removes both", async (t) => {
  const db = await database(t);
  const fake = new FakeHyperSync({
    height: first + 10000,
    logs: [chainLog(first + 1, 0)],
  });
  assert.equal(
    await commit(db, await collect(db, fake, first, first + 2)),
    true,
  );
  const rpcLog: RawLog = {
    address: contracts.manager,
    topics: [swapTopic, pools[1], word(4)],
    data: swapData([-7n, 5n]),
    blockNumber: hex(first + 4),
    blockHash: word(first + 4),
    transactionHash: word(9),
    logIndex: hex(0),
    removed: false,
  };
  const rpcGroup = await collectRpc([rpcLog], first + 3, first + 5);
  assert.equal(rpcGroup.fromBlockParentHash, word(first + 2));
  assert.equal(await commit(db, rpcGroup), true);
  // A second HyperSync batch continues after the receipt-shaped one.
  const later = new FakeHyperSync({
    height: first + 10000,
    logs: [chainLog(first + 7, 0)],
  });
  assert.equal(
    await commit(db, await collect(db, later, first + 6, first + 8)),
    true,
  );
  assert.deepEqual(await counts(db), {
    batches: 3,
    swaps: 3,
    members: 3,
    manifests: 3,
  });
  const sources = (
    await db.query(
      "SELECT batch_end::int AS batch_end, serialized_group::jsonb->'evidence'->>'source' AS source FROM broad_batches ORDER BY batch_end",
    )
  ).rows;
  assert.deepEqual(sources, [
    { batch_end: first + 2, source: "hypersync" },
    { batch_end: first + 5, source: null },
    { batch_end: first + 8, source: "hypersync" },
  ]);
  // A gap or a wrong parent is refused whichever variant follows.
  await assert.rejects(
    commit(db, await collect(db, later, first + 10, first + 12, first + 19)),
    /Stale broad checkpoint or noncontiguous batch/,
  );
  // A parent that disagrees with the saved cursor hash is refused at commit
  // even though the batch is internally consistent.
  const shifted = new FakeHyperSync({
    height: first + 10000,
    logs: [],
    hash: (n) => (n === first + 8 ? word(n + 1000000) : word(n)),
  });
  await assert.rejects(
    commit(db, await collect(db, shifted, first + 9, first + 9)),
    /Stale broad checkpoint or noncontiguous batch/,
  );
  // Rewinding to the first checkpoint drops the later batches of both kinds.
  await rewind(db, await getStream(db, broadStreamIdentity.key), first + 2);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 1,
    members: 1,
    manifests: 1,
  });
  await rewind(db, await getStream(db, broadStreamIdentity.key), null);
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
});
