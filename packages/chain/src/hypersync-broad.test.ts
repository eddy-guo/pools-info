import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toEventSelector, encodeAbiParameters } from "viem";
import {
  collectHyperSyncBroadGroup,
  observedBroadPoolIds,
  verifyHyperSyncBroadGroup,
  type HyperSyncBroadGroup,
} from "./hypersync-broad";
import {
  HyperSyncClient,
  swapLogQuery,
  type HyperSyncQuery,
} from "./hypersync";
import { FakeHyperSync, word } from "./hypersync-fake";
import { contracts, swapEvent } from "./events";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
} from "./deployments";
import type { BroadPoolIdentity } from "./broad-pool-events";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/hypersync/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const from = 62688988,
  to = 62689007;
const registered: BroadPoolIdentity[] = [
  [
    "0x53a3e65a7b8a1810d2817613c3306b9fd90d24ad1ee228a61e8ef0d180289690",
    "0x433025fe9550ed919d8b28b53a3f5419be678d0d",
    62688988,
  ],
  [
    "0x04e6573d923e3b56bece9b517d729240a6683e2249683f6820c925c3ae149026",
    "0xb480aa907f5ca5364daa47508f06d248411f28be",
    62687614,
  ],
  [
    "0x7c937497e9c34c9e79a37a59bfcf9df70303c208c533d5a190dd4759ea7af9ec",
    "0xdf964f908343efc37b532a8737c4fa14e9936982",
    62687318,
  ],
  [
    "0xfb666aa663e2368def11a9fe82862190c40bf903d83ae9f343bcd38e7719e602",
    "0x4636e0604cd1d0f638a6512c1c32e1cd25e2af02",
    62625935,
  ],
].map(
  ([poolId, token, launchBlock]) =>
    ({ poolId, token, launchBlock }) as BroadPoolIdentity,
);
const token = "x".repeat(16);
const registry = (throughBlock: number, blockHash: string) => ({
  stream: "discovery:v2" as const,
  revision: instantRegistryRevision,
  sourceRevision: instantRegistrySourceRevision,
  throughBlock,
  blockHash,
});
const resolve =
  (pools: BroadPoolIdentity[]) => async (ids: readonly string[]) =>
    pools.filter((p) => ids.includes(p.poolId));

/** Serve the recorded page for the recorded body; everything else is refused. */
function recordedClient(height = 64149200) {
  const request = fixture("swaps-unfiltered.request");
  const response = JSON.stringify(fixture("swaps-unfiltered.response"));
  const requests: HyperSyncQuery[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/height")
      return new Response(JSON.stringify({ height }), { status: 200 });
    const body = JSON.parse(String(init?.body)) as HyperSyncQuery;
    requests.push(body);
    assert.deepEqual(body, request);
    return new Response(response, { status: 200 });
  };
  return {
    requests,
    client: new HyperSyncClient({
      url: "https://4663.hypersync.xyz",
      token,
      fetch,
      minIntervalMs: 0,
    }),
  };
}
const cutoffHash = (
  fixture("swaps-unfiltered.response").data[0].blocks as {
    number: number;
    hash: string;
  }[]
).find((b) => b.number === to)!.hash;

test("a recorded page becomes a broad group with registered rows, unregistered ids and exact counts", async () => {
  const { client, requests } = recordedClient();
  const group = await collectHyperSyncBroadGroup(
    {
      fromBlock: from,
      toBlock: to,
      registry: registry(to, cutoffHash),
      resolvePools: resolve(registered),
    },
    client,
  );
  assert.equal(requests.length, 1);
  assert.equal(client.requests, 2);
  const filtered = fixture("swaps-pool-filter.response").data[0];
  assert.equal(group.swaps.length, 5);
  assert.deepEqual(group.evidence.logs, filtered.logs);
  assert.equal(group.observedSwaps, 73);
  assert.equal(group.unregisteredSwaps, 68);
  assert.equal(group.unsupportedSwaps, 0);
  assert.equal(group.evidence.unregistered.swaps, 68);
  assert.equal(
    group.evidence.unregistered.poolIds.length,
    41 - new Set(group.swaps.map((s) => s.poolId)).size,
  );
  assert.equal(observedBroadPoolIds(group).length, 41);
  assert.equal(group.toBlock, to);
  assert.equal(group.blockHash, cutoffHash);
  assert.equal(
    group.fromBlockParentHash,
    "0x2ac95821fc0b24dbb7e16904b22144de24056ad1af573c39b71a1873ef55ffb6",
  );
  assert.equal(
    group.toTimestamp,
    Number(
      fixture("swaps-unfiltered.response").data[0].blocks.find(
        (b: any) => b.number === to,
      ).timestamp,
    ),
  );
  const first = group.swaps[0];
  assert.equal(first.poolId, registered[0].poolId);
  assert.equal(first.token, registered[0].token);
  assert.equal(
    first.txHash,
    "0x4d27f358df793feb252b7a4e540bf30a3043db68828d6845318a0b767eb71543",
  );
  assert.equal(
    first.transactionSender,
    "0x22995fc5edc0187991ed96aeb105197298d1bbb6",
  );
  assert.equal(
    first.managerSender,
    "0x8876789976decbfcbbbe364623c63652db8c0904",
  );
  assert.equal(first.side, "buy");
  assert.equal(BigInt(first.amount0) < 0n && BigInt(first.amount1) > 0n, true);
  assert.equal(first.ethWei, (-BigInt(first.amount0)).toString());
  assert.equal(first.tokenRaw, first.amount1);
  assert.equal(first.fee, 2500);
  assert.equal(first.timestamp, 0x6aa7b92b);
  assert.deepEqual(first.flags, ["missing_transfer_history"]);
  assert.equal(first.supported, false);
  assert.equal(group.evidence.transactions.length, 5);
  // Blocks of the five registered logs plus the range and registry boundaries.
  assert.equal(
    group.evidence.blocks.length,
    new Set([...filtered.blocks.map((b: any) => b.number), from, to]).size,
  );
  assert.equal(group.evidence.pages.length, 1);
  assert.deepEqual(
    group.evidence.query,
    swapLogQuery({ fromBlock: from, toBlock: to }),
  );
  assert.equal(group.tokenUnits, undefined);
  assert.doesNotThrow(() => verifyHyperSyncBroadGroup(group));
  // Serialized replay is what the writer verifies.
  assert.doesNotThrow(() =>
    verifyHyperSyncBroadGroup(
      JSON.parse(JSON.stringify({ ...group, requests: 0 })),
    ),
  );
});

test("verification rejects every tampered row, count, boundary or registry claim", async () => {
  const { client } = recordedClient();
  const group = await collectHyperSyncBroadGroup(
    {
      fromBlock: from,
      toBlock: to,
      registry: registry(to, cutoffHash),
      resolvePools: resolve(registered),
    },
    client,
  );
  const tampered = (change: (g: HyperSyncBroadGroup) => void) => {
    const copy = structuredClone(group);
    change(copy);
    return copy;
  };
  const cases: [string, (g: any) => void, RegExp][] = [
    [
      "row amount",
      (g) => (g.swaps[0].ethWei = "1"),
      /disagree with retained evidence/,
    ],
    [
      "row sender",
      (g) => (g.swaps[0].transactionSender = "0x" + "1".repeat(40)),
      /disagree with retained evidence/,
    ],
    [
      "dropped log",
      (g) => g.evidence.logs.pop(),
      /disagree with retained evidence|unrelated rows/,
    ],
    ["dropped swap", (g) => g.swaps.pop(), /disagree with retained evidence/],
    [
      "observed count",
      (g) => g.observedSwaps++,
      /disagree with retained evidence/,
    ],
    [
      "unregistered count",
      (g) => g.evidence.unregistered.swaps++,
      /disagree with retained evidence/,
    ],
    [
      "registered id claimed unregistered",
      (g) => g.evidence.unregistered.poolIds.unshift(g.swaps[0].poolId),
      /Invalid HyperSync unregistered pool ids/,
    ],
    [
      "unsorted unregistered ids",
      (g) => g.evidence.unregistered.poolIds.reverse(),
      /Invalid HyperSync unregistered pool ids/,
    ],
    [
      "extra transaction",
      (g) =>
        g.evidence.transactions.push({
          ...g.evidence.transactions[0],
          hash: word(1),
        }),
      /not unique and sorted|unrelated rows/,
    ],
    [
      "failed transaction",
      (g) => (g.evidence.transactions[0].status = 0),
      /lacks a consistent successful transaction/,
    ],
    [
      "block hash",
      (g) => (g.evidence.blocks[0].hash = word(9)),
      /Inconsistent HyperSync canonical headers|lacks a consistent/,
    ],
    [
      "cutoff hash",
      (g) => (g.blockHash = word(9)),
      /disagree with retained evidence/,
    ],
    [
      "registry hash",
      (g) => (g.registry.blockHash = word(9)),
      /Broad registry boundary changed/,
    ],
    [
      "archive height too low",
      (g) => (g.evidence.pages[0].archiveHeight = to + 1),
      /pages disagree with the range/,
    ],
    [
      "page range",
      (g) => (g.evidence.pages[0].nextBlock = to),
      /pages disagree with the range/,
    ],
    [
      "query range",
      (g) => (g.evidence.query.to_block = to),
      /disagrees with the range/,
    ],
    [
      "query selection",
      (g) => (g.evidence.query.logs[0].topics = [[]]),
      /disagrees with the range/,
    ],
    [
      "token units",
      (g) => (g.tokenUnits = []),
      /Invalid HyperSync broad group/,
    ],
    [
      "pool without rows",
      (g) =>
        g.pools.push({
          poolId: word(77),
          token: registered[0].token,
          launchBlock: from,
        }),
      /Invalid HyperSync broad group|disagree with the retained logs/,
    ],
    [
      "duplicate identity",
      (g) => g.evidence.logs.push(g.evidence.logs[0]),
      /not sorted|Duplicate/,
    ],
    [
      "source",
      (g) => (g.evidence.source = "rpc"),
      /Invalid HyperSync broad group/,
    ],
  ];
  for (const [name, change, expected] of cases)
    assert.throws(
      () => verifyHyperSyncBroadGroup(tampered(change)),
      expected,
      name,
    );
});

const swapData = (amounts: [bigint, bigint]) =>
  encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [...amounts, (1n << 96n) + 123n, 100000000000000000001n, -2, 2500],
  );
const first = instantRegistryStartBlock;
const pool = (id: string, launchBlock = first): BroadPoolIdentity => ({
  poolId: id,
  token: "0x1111111111111111111111111111111111111111",
  launchBlock,
});
const swap = (
  block: number,
  index: number,
  id = word(3),
  amounts: [bigint, bigint] = [-10n, 200000000000000000001n],
) => ({
  block,
  logIndex: index,
  transactionHash: word(block * 100 + index),
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), id, word(4)],
  data: swapData(amounts),
  from: "0x2222222222222222222222222222222222222222",
});
function fakeClient(fake: FakeHyperSync) {
  return new HyperSyncClient({
    url: "https://4663.hypersync.xyz",
    token,
    fetch: fake.fetch,
    minIntervalMs: 0,
    retryBaseMs: 1,
  });
}

test("a synthetic chain: paging shortens the batch, boundary headers are fetched only when absent, and every inconsistency is rejected", async () => {
  const logs = [
    swap(first, 0),
    swap(first + 1, 0, word(5)),
    swap(first + 1, 1, word(3), [0n, 1n]),
    swap(first + 2, 0, word(7)),
    swap(first + 5, 0),
    swap(first + 6, 0),
  ];
  const fake = new FakeHyperSync({
    height: first + 10000,
    logs,
    maxLogsPerPage: 2,
  });
  const pools = [pool(word(3)), pool(word(5), first + 1)];
  const range = {
    fromBlock: first,
    toBlock: first + 9,
    registry: registry(first + 20, word(first + 20)),
    resolvePools: resolve(pools),
  };
  const client = fakeClient(fake);
  const group = await collectHyperSyncBroadGroup(
    { ...range, maxPages: 2 },
    client,
  );
  // Two whole pages of at least two logs each: [first, first+2) and
  // [first+2, first+6); the batch ends where the second page ends.
  assert.equal(group.toBlock, first + 5);
  assert.deepEqual(
    group.evidence.pages.map((p) => [p.fromBlock, p.nextBlock, p.logs]),
    [
      [first, first + 2, 3],
      [first + 2, first + 6, 2],
    ],
  );
  assert.equal(group.observedSwaps, 5);
  assert.equal(group.unregisteredSwaps, 1);
  assert.equal(group.unsupportedSwaps, 1);
  assert.deepEqual(group.evidence.unregistered, {
    swaps: 1,
    poolIds: [word(7)],
  });
  assert.equal(group.swaps.length, 4);
  assert.deepEqual(
    group.swaps.map((s) => [s.block - first, s.logIndex, s.poolId, s.side]),
    [
      [0, 0, word(3), "buy"],
      [1, 0, word(5), "buy"],
      [1, 1, word(3), null],
      [5, 0, word(3), "buy"],
    ],
  );
  assert.deepEqual(group.swaps[2].flags, [
    "missing_transfer_history",
    "unsupported_swap_signs",
  ]);
  assert.equal(group.fromBlockParentHash, word(first - 1));
  assert.equal(group.blockHash, word(first + 5));
  // from and to carried registered logs; only the registry boundary needed a
  // header query, and the unregistered-only block is not retained.
  const headers = fake.requests.filter((r) => r.body?.include_all_blocks);
  assert.deepEqual(
    headers.map((r) => r.body!.from_block),
    [first + 20],
  );
  assert.deepEqual(
    group.evidence.blocks.map((b) => b.number),
    [first, first + 1, first + 5, first + 20],
  );
  assert.doesNotThrow(() => verifyHyperSyncBroadGroup(group));

  const whole = await collectHyperSyncBroadGroup(
    { ...range, maxPages: 8 },
    fakeClient(fake),
  );
  assert.equal(whole.toBlock, first + 9);
  assert.equal(whole.observedSwaps, 6);
  assert.equal(whole.evidence.blocks.at(-2)?.number, first + 9);

  fake.reorgFrom = first + 20;
  await assert.rejects(
    collectHyperSyncBroadGroup(range, fakeClient(fake)),
    /Broad registry boundary changed/,
  );
  fake.reorgFrom = null;
  fake.height = first + 20 + 127;
  await assert.rejects(
    collectHyperSyncBroadGroup(range, fakeClient(fake)),
    /exceeds the confirmed cutoff/,
  );
  fake.height = first + 10000;
  const earlyLaunch = {
    ...range,
    resolvePools: resolve([pool(word(3), first + 1)]),
  };
  await assert.rejects(
    collectHyperSyncBroadGroup(earlyLaunch, fakeClient(fake)),
    /precedes verified launch/,
  );
  const failed = new FakeHyperSync({
    height: first + 10000,
    logs: [{ ...swap(first, 0), status: 0 }],
  });
  await assert.rejects(
    collectHyperSyncBroadGroup(range, fakeClient(failed)),
    /lacks a consistent successful transaction/,
  );
  const foreign = new FakeHyperSync({
    height: first + 10000,
    logs: [{ ...swap(first, 0), address: contracts.router }],
  });
  const foreignGroup = await collectHyperSyncBroadGroup(
    range,
    fakeClient(foreign),
  );
  assert.equal(foreignGroup.observedSwaps, 0);
  const duplicate = new FakeHyperSync({
    height: first + 10000,
    logs: [swap(first, 0), swap(first, 0)],
  });
  await assert.rejects(
    collectHyperSyncBroadGroup(range, fakeClient(duplicate)),
    /Duplicate HyperSync swap evidence/,
  );
  const outside = new FakeHyperSync({
    height: first + 10000,
    logs: [swap(first, 0)],
    intercept: (r) => {
      if (!r.body || r.body.include_all_blocks) return undefined;
      const json: any = outside.respond(r.body);
      json.next_block = first + 10;
      json.data[0].logs[0].block_number = first + 11;
      return new Response(JSON.stringify(json), { status: 200 });
    },
  });
  await assert.rejects(
    collectHyperSyncBroadGroup(range, fakeClient(outside)),
    /outside the page/,
  );
  await assert.rejects(
    collectHyperSyncBroadGroup(
      { ...range, toBlock: first + 10000 },
      fakeClient(fake),
    ),
    /Invalid HyperSync broad range/,
  );
  await assert.rejects(
    collectHyperSyncBroadGroup(
      { ...range, registry: registry(first + 5, word(first + 5)) },
      fakeClient(fake),
    ),
    /Invalid broad registry checkpoint/,
  );
  await assert.rejects(
    collectHyperSyncBroadGroup(
      { ...range, resolvePools: async () => [pool(word(9))] },
      fakeClient(fake),
    ),
    /Invalid broad registry resolution/,
  );
});
