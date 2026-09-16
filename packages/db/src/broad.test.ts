import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  collectPoolEventGroup,
  contracts,
  Rpc,
  type BroadPoolIdentity,
  type BroadPoolEventGroup,
  type EventHeader,
  type RawLog,
  type Receipt,
} from "@pools/chain";
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
  rewind,
  type Client,
} from "./index";

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw Error("TEST_DATABASE_URL must reference a dedicated test Postgres");
const first = discoveryV2Identity.start;
const word = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: number): `0x${string}` => `0x${n.toString(16)}`;
const token = "0x1111111111111111111111111111111111111111";
const initiator = "0x2222222222222222222222222222222222222222";
const header = (n: number): EventHeader => ({
  number: hex(n),
  hash: word(n),
  parentHash: word(n - 1),
  timestamp: hex(n * 2),
});
const pool = (id = word(3)): BroadPoolIdentity => ({
  poolId: id,
  token,
  launchBlock: first,
});
const pools = [pool(), pool(word(5))];
const unknown = word(7);
function swap(
  id = pools[0].poolId,
  index = 0,
  amounts = [-10n, 200000000000000000001n],
  block = first + 1,
): RawLog {
  const abiWords = [
    ...amounts,
    (1n << 96n) + 123n,
    100000000000000000001n,
    -2n,
    2500n,
  ]
    .map((n) => BigInt.asUintN(256, n).toString(16).padStart(64, "0"))
    .join("");
  return {
    address: contracts.manager,
    topics: [
      "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f",
      id as `0x${string}`,
      word(4),
    ],
    data: `0x${abiWords}`,
    blockNumber: hex(block),
    blockHash: word(block),
    transactionHash: word(block + 100),
    logIndex: hex(index),
    removed: false,
  };
}
async function collect(
  logs = [swap(), swap(pools[1].poolId, 1), swap(unknown, 2)],
  from: number = first,
  to: number = first + 2,
  checkpoint: number = first + 9,
  identities = pools,
): Promise<BroadPoolEventGroup> {
  const rpc = new Rpc("http://127.0.0.1:1/no-network");
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return hex(4663) as T;
    if (method === "eth_blockNumber") return hex(first + 20000) as T;
    throw Error("Unexpected RPC method");
  };
  rpc.logs = async () => structuredClone(logs);
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p) => header(Number(p[0]))) as T[];
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
      registry: {
        stream: "discovery:v2",
        revision: discoveryV2Identity.registryRevision,
        sourceRevision: discoveryV2Identity.registrySourceRevision,
        throughBlock: checkpoint,
        blockHash: word(checkpoint),
      },
      resolvePools: async (ids) =>
        identities.filter((p) => ids.includes(p.poolId)),
    },
    rpc,
  );
}
async function database(t: TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = `broad_${randomUUID().replaceAll("-", "")}`;
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const launches = pools.map((p, i) => ({
    id: p.poolId,
    token: p.token,
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
  await commitBatch(db, v2, {
    from: first,
    to: first + 9,
    hash: word(first + 9),
    evidence: {
      registryRevision: discoveryV2Identity.registryRevision,
      registrySourceRevision: discoveryV2Identity.registrySourceRevision,
    },
    pools: launches,
  });
  await commitBatch(db, await getStream(db, v2.key), {
    from: first + 10,
    to: first + 19,
    hash: word(first + 19),
    evidence: {
      registryRevision: discoveryV2Identity.registryRevision,
      registrySourceRevision: discoveryV2Identity.registrySourceRevision,
    },
    pools: [],
  });
  for (const p of pools)
    await commitBatch(db, await getStream(db, `pool:${p.poolId}`), {
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
  const saved = await cursors(db);
  await ensureBroadStream(db);
  return { db, saved, schema };
}
async function cursors(db: Client) {
  return (
    await db.query(
      "SELECT * FROM indexer_streams WHERE kind<>'broad' ORDER BY stream_key",
    )
  ).rows;
}
async function commit(db: Client, group: BroadPoolEventGroup) {
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

test("deep scheduler loses broad activity priority when its canonical source rewinds", async (t) => {
  const { db } = await database(t);
  await commit(
    db,
    await collect([swap(), swap(pools[1].poolId, 1, [-100n, 1n])]),
  );
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, pools[1].poolId);
  await rewind(db, await getStream(db, broadStreamIdentity.key), null);
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, pools[0].poolId);
});

test("broad collection persists one shared retained range and exact unsupported activity without changing deep/v1 coverage", async (t) => {
  const { db, saved, schema } = await database(t);
  const group = await collect([
    swap(),
    swap(pools[1].poolId, 1, [12n, -90071992547409930001n]),
    swap(pools[0].poolId, 2, [0n, 1n]),
    swap(unknown, 3),
  ]);
  assert.equal(await commit(db, group), true);
  // The deep scheduler consumes surviving normalized broad volume without
  // treating raw token-unit Swap liquidity as comparable ETH liquidity.
  assert.equal((await nextPoolGroup(db, 1))[0].poolId, pools[1].poolId);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 3,
    members: 2,
    manifests: 1,
  });
  const batch = (
    await db.query(
      "SELECT x.*,b.content_hash,b.evidence FROM broad_batches x JOIN indexer_batches b ON b.chain_id=x.chain_id AND b.stream_key=x.stream_key AND b.to_block=x.batch_end",
    )
  ).rows[0];
  const serialized = JSON.stringify({ ...group, requests: 0 });
  assert.equal(batch.serialized_group, serialized);
  assert.equal(
    batch.content_hash,
    createHash("sha256").update(serialized).digest("hex"),
  );
  assert.deepEqual(batch.evidence, { broadSerializerVersion: 1 });
  assert.equal(JSON.parse(serialized).evidence.receipts.length, 1);
  const rows = (await db.query("SELECT * FROM broad_swaps ORDER BY log_index"))
    .rows;
  assert.equal(rows[0].amount0, "-10");
  assert.equal(rows[0].amount1, "200000000000000000001");
  assert.equal(rows[0].sqrt_price_x96, ((1n << 96n) + 123n).toString());
  assert.equal(rows[0].liquidity, "100000000000000000001");
  assert.equal(rows[0].tick, -2);
  assert.equal(rows[0].fee, 2500);
  assert.equal(
    rows[0].manager_sender,
    "0x0000000000000000000000000000000000000004",
  );
  assert.equal(rows[0].transaction_sender, initiator);
  assert.equal(rows[1].side, "sell");
  assert.equal(rows[1].token_raw, "90071992547409930001");
  assert.equal(rows[2].side, null);
  assert.equal(rows[2].eth_wei, null);
  assert.equal(rows[2].token_raw, null);
  assert.deepEqual(rows[2].flags, [
    "missing_transfer_history",
    "unsupported_swap_signs",
  ]);
  assert.ok(rows.every((r) => r.supported === false));
  const finance = (
    await db.query(
      "SELECT (SELECT count(*)::int FROM analytics_accounting_positions) AS positions,(SELECT count(*)::int FROM analytics_accounting_trades) AS trades",
    )
  ).rows[0];
  assert.deepEqual(finance, { positions: 0, trades: 0 });
  const columns = (
    await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='broad_swaps'",
      [schema],
    )
  ).rows.map((r) => r.column_name);
  for (const forbidden of [
    "beneficiary",
    "wallet",
    "cost_wei",
    "realized_wei",
    "quantity_raw",
  ])
    assert.ok(!columns.includes(forbidden));
  for (const sql of [
    "UPDATE broad_swaps SET supported=true",
    "UPDATE broad_swaps SET amount0=amount0+0.5",
    "UPDATE broad_swaps SET sqrt_price_x96=sqrt_price_x96+0.1",
    "UPDATE broad_swaps SET flags='{}'",
    "UPDATE broad_swaps SET side=NULL WHERE log_index=0",
    "UPDATE broad_swaps SET eth_wei=NULL WHERE log_index=0",
    "UPDATE broad_swaps SET token_raw=1 WHERE log_index=2",
  ])
    await assert.rejects(db.query(sql), /check constraint/);
  assert.deepEqual(await cursors(db), saved);
});

test("exact replay is a no-op with telemetry changes; changed evidence or source identity rejects", async (t) => {
  const { db, saved } = await database(t);
  const group = await collect();
  const expected = await getStream(db, broadStreamIdentity.key);
  assert.equal(
    await commitPoolGroup(db, { mode: "broad", expected, group }),
    true,
  );
  const before = await getStream(db, expected.key);
  assert.equal(
    await commitPoolGroup(db, {
      mode: "broad",
      expected,
      group: { ...group, requests: 999 },
    }),
    false,
  );
  const altered = structuredClone(group);
  altered.evidence.receipts[0].from = token;
  altered.swaps.forEach((s) => {
    s.transactionSender = token;
  });
  await assert.rejects(commit(db, altered), /Conflicting broad replay/);
  const duplicate = swap(pools[0].poolId, 0, undefined, first + 4);
  duplicate.transactionHash = group.swaps[0].txHash as `0x${string}`;
  await assert.rejects(
    commit(db, await collect([duplicate], first + 3, first + 5)),
    /duplicate key/,
  );
  await db.query("UPDATE indexed_pools SET launch_sender=$1 WHERE pool_id=$2", [
    token,
    pools[0].poolId,
  ]);
  await assert.rejects(commit(db, group), /replay source identity changed/);
  await db.query("UPDATE indexed_pools SET launch_sender=$1 WHERE pool_id=$2", [
    initiator,
    pools[0].poolId,
  ]);
  assert.deepEqual(await getStream(db, expected.key), before);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 2,
    members: 2,
    manifests: 1,
  });
  assert.deepEqual(await cursors(db), saved);
});

test("checkpoint revisions and launch source bounds fail closed; empty replay also pins discovery content", async (t) => {
  const { db } = await database(t);
  const group = await collect();
  await db.query(
    "UPDATE indexer_batches SET evidence=jsonb_set(evidence,'{registryRevision}','\"wrong\"') WHERE stream_key='discovery:v2' AND to_block=$1",
    [first + 19],
  );
  await assert.rejects(
    commit(db, await collect([], first, first + 2, first + 19)),
    /checkpoint changed/,
  );
  await db.query(
    "UPDATE indexer_batches SET evidence=jsonb_set(evidence,'{registryRevision}',to_jsonb($1::text)) WHERE stream_key='discovery:v2' AND to_block=$2",
    [discoveryV2Identity.registryRevision, first + 19],
  );
  await db.query(
    "UPDATE pool_launch_sources SET batch_end=$1 WHERE stream_key='discovery:v2' AND pool_id=$2",
    [first + 19, pools[0].poolId],
  );
  await assert.rejects(
    commit(db, await collect(undefined, first, first + 2, first + 19)),
    /launch source identity changed/,
  );
  await db.query(
    "UPDATE pool_launch_sources SET batch_end=$1 WHERE stream_key='discovery:v2' AND pool_id=$2",
    [first + 9, pools[0].poolId],
  );
  await db.query(
    "UPDATE indexer_streams SET registry_revision='wrong' WHERE stream_key='discovery:v2'",
  );
  await assert.rejects(commit(db, group), /coverage or identity changed/);
  await db.query(
    "UPDATE indexer_streams SET registry_revision=$1 WHERE stream_key='discovery:v2'",
    [discoveryV2Identity.registryRevision],
  );
  await assert.rejects(
    db.query(
      "UPDATE indexer_streams SET registry_revision=NULL WHERE kind='broad'",
    ),
    /check constraint/,
  );
  const empty = await collect([]);
  await commit(db, empty);
  await db.query(
    "UPDATE indexer_batches SET content_hash=$1 WHERE stream_key='discovery:v2' AND to_block=$2",
    ["f".repeat(64), first + 9],
  );
  await assert.rejects(commit(db, empty), /discovery source identity changed/);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 0,
    members: 0,
    manifests: 1,
  });
});

test("input mutation during the first database await cannot omit retained members", async (t) => {
  const { db } = await database(t);
  const group = await collect();
  const original = structuredClone(group);
  const pending = commitPoolGroup(db, {
    mode: "broad",
    expected: await getStream(db, broadStreamIdentity.key),
    group,
  });
  group.swaps.pop();
  group.pools.pop();
  group.evidence.swapLogs = [];
  assert.equal(await pending, true);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 2,
    members: 2,
    manifests: 1,
  });
  assert.deepEqual(
    JSON.parse(
      (await db.query("SELECT serialized_group FROM broad_batches")).rows[0]
        .serialized_group,
    ),
    { ...original, requests: 0 },
  );
});

test("a database failure on the second pool rolls back every member, evidence batch and broad cursor", async (t) => {
  const { db, saved } = await database(t);
  await db.query(
    `CREATE FUNCTION fail_second_pool() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pool_id='${pools[1].poolId}' THEN RAISE EXCEPTION 'second pool failure'; END IF; RETURN NEW; END; $$`,
  );
  await db.query(
    "CREATE TRIGGER fail_second_pool BEFORE INSERT ON broad_swaps FOR EACH ROW EXECUTE FUNCTION fail_second_pool()",
  );
  const before = await getStream(db, broadStreamIdentity.key);
  await assert.rejects(commit(db, await collect()), /second pool failure/);
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  assert.deepEqual(await getStream(db, before.key), before);
  assert.deepEqual(await cursors(db), saved);
  await db.query("DROP TRIGGER fail_second_pool ON broad_swaps");
  assert.equal(await commit(db, await collect()), true);
});

test("missing registered members, late source additions and changed token identity cannot advance", async (t) => {
  const { db, saved } = await database(t);
  const group = await collect();
  const missing = await collect(undefined, undefined, undefined, undefined, [
    pools[0],
  ]);
  await assert.rejects(
    commit(db, missing),
    /registry members or source identity changed/,
  );
  await db.query("UPDATE indexed_pools SET token=$1 WHERE pool_id=$2", [
    initiator,
    pools[1].poolId,
  ]);
  await assert.rejects(
    commit(db, group),
    /registry members or source identity changed/,
  );
  await db.query("UPDATE indexed_pools SET token=$1 WHERE pool_id=$2", [
    token,
    pools[1].poolId,
  ]);
  // A registry lookup occurred before this independent source became available.
  const v1 = await getStream(db, "discovery:v1");
  await commitBatch(db, v1, {
    from: first + 10,
    to: first + 19,
    hash: word(first + 19),
    evidence: {},
    pools: [
      {
        id: unknown,
        token,
        name: "late",
        symbol: "L",
        launchBlock: first + 10,
        launchTx: word(900),
        launchSender: initiator,
        launchedAt: (first + 10) * 2,
      },
    ],
  });
  const lateLog = swap(unknown, 2, undefined, first + 11);
  const late = await collect([lateLog], first, first + 12, first + 19, []);
  await db.query(
    "INSERT INTO pool_launch_sources(chain_id,pool_id,stream_key,batch_end) VALUES(4663,$1,'discovery:v2',$2)",
    [unknown, first + 19],
  );
  await assert.rejects(
    commit(db, late),
    /registry members or source identity changed/,
  );
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
  // The test intentionally advanced v1, but persistence never changed it.
  const now = await cursors(db);
  assert.deepEqual(
    now.filter(
      (s) =>
        s.stream_key !== "discovery:v1" && s.stream_key !== `pool:${unknown}`,
    ),
    saved.filter((s) => s.stream_key !== "discovery:v1"),
  );
});

test("saved historical checkpoints survive tip rollback; dependent broad suffix and empty ranges rewind atomically", async (t) => {
  const { db } = await database(t);
  await commit(db, await collect());
  await commit(db, await collect([], first + 3, first + 5, first + 19));
  await commit(db, await collect([], first + 6, first + 8, first + 9));
  assert.deepEqual(await counts(db), {
    batches: 3,
    swaps: 2,
    members: 2,
    manifests: 3,
  });
  const independent = (await cursors(db)).filter(
    (s) => s.stream_key !== "discovery:v2",
  );
  const v2 = await getStream(db, "discovery:v2");
  const broadBefore = await getStream(db, broadStreamIdentity.key);
  // Fail after dependency cascades but before discovery's cursor update.
  await db.query(
    "CREATE FUNCTION fail_discovery_rewind() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.stream_key='discovery:v2' THEN RAISE EXCEPTION 'rewind failure'; END IF; RETURN NEW; END; $$",
  );
  await db.query(
    "CREATE TRIGGER fail_discovery_rewind BEFORE UPDATE ON indexer_streams FOR EACH ROW EXECUTE FUNCTION fail_discovery_rewind()",
  );
  await assert.rejects(rewind(db, v2, first + 9), /rewind failure/);
  assert.deepEqual(await counts(db), {
    batches: 3,
    swaps: 2,
    members: 2,
    manifests: 3,
  });
  assert.deepEqual(await getStream(db, v2.key), v2);
  assert.deepEqual(await getStream(db, broadBefore.key), broadBefore);
  await db.query("DROP TRIGGER fail_discovery_rewind ON indexer_streams");
  await rewind(db, v2, first + 9);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 2,
    members: 2,
    manifests: 1,
  });
  assert.equal((await getStream(db, broadBefore.key)).cursor, first + 2);
  assert.equal((await getStream(db, broadBefore.key)).hash, word(first + 2));
  assert.deepEqual(
    (await cursors(db)).filter((s) => s.stream_key !== "discovery:v2"),
    independent,
  );
  await rewind(db, await getStream(db, v2.key), null);
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  assert.equal((await getStream(db, broadBefore.key)).cursor, null);
  assert.equal((await getStream(db, broadBefore.key)).hash, null);
  assert.deepEqual(
    (await cursors(db)).filter((s) => s.stream_key !== "discovery:v2"),
    independent,
  );
});

test("gaps, bad parent, wrong/missing discovery checkpoint, excess coverage and fabricated rows reject whole ranges", async (t) => {
  const { db, saved } = await database(t);
  const group = await collect();
  const mutations: Array<[BroadPoolEventGroup, RegExp]> = [];
  const pinHash = structuredClone(group);
  pinHash.registry.blockHash = word(999);
  mutations.push([pinHash, /checkpoint changed/]);
  const revision = structuredClone(group);
  revision.registry.revision = "wrong";
  mutations.push([revision, /coverage or identity changed/]);
  const invented = structuredClone(group);
  invented.swaps[0].amount0 = "-0.5";
  mutations.push([invented, /rows disagree/]);
  const supported = structuredClone(group);
  Object.assign(supported.swaps[0], {
    supported: true,
    beneficiary: initiator,
    realizedWei: "0",
  });
  mutations.push([supported, /rows disagree/]);
  const missing = structuredClone(group);
  missing.swaps.pop();
  mutations.push([missing, /rows disagree/]);
  const badReceipt = structuredClone(group);
  badReceipt.evidence.receipts[0].blockHash = word(999);
  mutations.push([badReceipt, /receipt evidence/]);
  const notCheckpoint = await collect([], first, first + 2, first + 8);
  mutations.push([notCheckpoint, /checkpoint changed/]);
  const overCoverage = await collect([], first, first + 20, first + 21);
  mutations.push([overCoverage, /coverage or identity changed/]);
  const gap = await collect([], first + 3, first + 5);
  mutations.push([gap, /noncontiguous/]);
  for (const [invalid, pattern] of mutations) {
    await assert.rejects(commit(db, invalid), pattern);
    assert.deepEqual(await counts(db), {
      batches: 0,
      swaps: 0,
      members: 0,
      manifests: 0,
    });
    assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
  }
  await commit(db, group);
  const badParent = await collect([], first + 3, first + 5);
  badParent.fromBlockParentHash = word(999);
  badParent.evidence.headers.find(
    (h) => Number(h.number) === first + 3,
  )!.parentHash = word(999);
  await assert.rejects(commit(db, badParent), /noncontiguous/);
  await assert.rejects(
    commitBatch(db, await getStream(db, broadStreamIdentity.key), {
      from: first + 3,
      to: first + 5,
      hash: word(first + 5),
      evidence: {},
    }),
    /require the broad group transaction/,
  );
  assert.deepEqual(await cursors(db), saved);
});

test("oversized groups reject entirely including a single dense block; broad reconciliation preserves discovery and deep cursors", async (t) => {
  const { db, saved } = await database(t);
  const group = await collect();
  const oversized = structuredClone(group);
  oversized.evidence.swapLogs = Array.from({ length: 10001 }, () => swap());
  await assert.rejects(
    commit(db, oversized),
    /Invalid broad commit group|exceeds capacity/,
  );
  const bytes = structuredClone(group);
  Object.assign(bytes.evidence, { padding: "x".repeat(16 * 1024 * 1024) });
  await assert.rejects(commit(db, bytes), /exceeds capacity/);
  const dense = structuredClone(oversized);
  dense.toBlock = dense.fromBlock;
  await assert.rejects(
    commit(db, dense),
    /Invalid broad commit group|exceeds capacity/,
  );
  assert.deepEqual(await counts(db), {
    batches: 0,
    swaps: 0,
    members: 0,
    manifests: 0,
  });
  await commit(db, await collect([], first, first + 2));
  await commit(db, await collect([], first + 3, first + 5));
  await rewind(db, await getStream(db, broadStreamIdentity.key), first + 2);
  assert.deepEqual(await counts(db), {
    batches: 1,
    swaps: 0,
    members: 0,
    manifests: 1,
  });
  assert.equal(
    (await getStream(db, broadStreamIdentity.key)).cursor,
    first + 2,
  );
  assert.deepEqual(await cursors(db), saved);
});

test("market projection failure rolls back canonical evidence and cursor; replay and suffix rewind retain exact bucket ownership", async (t) => {
  const { db } = await database(t);
  await db.query(
    "CREATE FUNCTION fail_market_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'market projection failure'; END; $$",
  );
  await db.query(
    "CREATE TRIGGER fail_market_projection BEFORE INSERT ON broad_market_buckets FOR EACH ROW EXECUTE FUNCTION fail_market_projection()",
  );
  await assert.rejects(
    commit(db, await collect()),
    /market projection failure/,
  );
  assert.equal((await getStream(db, broadStreamIdentity.key)).cursor, null);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS count FROM broad_market_batches",
      )
    ).rows[0].count,
    0,
  );
  assert.equal((await counts(db)).batches, 0);
  await db.query("DROP TRIGGER fail_market_projection ON broad_market_buckets");
  const group = await collect();
  await commit(db, group);
  const before = (
    await db.query(
      "SELECT * FROM broad_market_buckets ORDER BY pool_id,timestamp",
    )
  ).rows;
  assert.equal(await commit(db, group), false);
  assert.deepEqual(
    (
      await db.query(
        "SELECT * FROM broad_market_buckets ORDER BY pool_id,timestamp",
      )
    ).rows,
    before,
  );
  assert.equal(
    before.reduce((sum, r) => sum + BigInt(r.volume_wei), 0n),
    20n,
  );
  await commit(db, await collect([], first + 3, first + 5));
  await rewind(db, await getStream(db, broadStreamIdentity.key), null);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS count FROM broad_market_buckets",
      )
    ).rows[0].count,
    0,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::integer AS count FROM broad_market_batches",
      )
    ).rows[0].count,
    0,
  );
});
