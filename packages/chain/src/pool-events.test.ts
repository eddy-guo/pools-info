import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import { collectPoolEvents } from "./pool-events";
import { contracts, swapEvent, transferEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
import { collectCatalog } from "./catalog";
import { collectPoolEventGroup } from "./pool-event-group";
import { tokenMetadataFactory } from "./token-metadata";

const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const token = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const poolId = word(3);
const range = { poolId, token, fromBlock: 1499, toBlock: 1501 };
const header = (height: number) => ({
  number: hex(height),
  hash: word(height),
  parentHash: word(height - 1),
  timestamp: hex(height * 2),
});
const swap = (unsupported = false): RawLog => ({
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), poolId, word(4)],
  data: encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [
      unsupported ? 10n : -10n,
      200000000000000000000n,
      1n << 96n,
      100n,
      -2,
      2500,
    ],
  ),
  blockNumber: hex(1500),
  blockHash: word(1500),
  transactionHash: word(9),
  logIndex: "0x0",
  removed: false,
});
const transfer = (): RawLog => ({
  ...swap(),
  address: token,
  topics: [
    toEventSelector(transferEvent),
    `0x${"0".repeat(24)}${contracts.manager.slice(2)}`,
    `0x${"0".repeat(24)}${sender.slice(2)}`,
  ],
  data: encodeAbiParameters([{ type: "uint256" }], [200000000000000000000n]),
  logIndex: "0x1",
});
function fake(
  options: {
    swaps?: RawLog[];
    transfers?: RawLog[];
    reorg?: boolean;
    receiptMismatch?: boolean;
    chain?: number;
  } = {},
) {
  const rpc = new Rpc();
  const calls: {
    address: unknown;
    topics: unknown[];
    from: number;
    to: number;
  }[] = [];
  const swaps = options.swaps ?? [swap()],
    transfers = options.transfers ?? [transfer()];
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId") return hex(options.chain ?? 4663) as T;
    if (method === "eth_blockNumber") return hex(2000) as T;
    return {
      ...header(Number(params[0])),
      ...(options.reorg ? { hash: word(99) } : {}),
    } as T;
  };
  rpc.logs = async (address, topics, from, to) => {
    calls.push({ address, topics, from, to });
    return address === contracts.manager ? swaps : transfers;
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) =>
    params.map((p) =>
      method === "eth_getBlockByNumber"
        ? header(Number(p[0]))
        : {
            transactionHash: p[0],
            blockHash: word(1500),
            status: "0x1",
            from: sender,
            to: contracts.router,
            logs: options.receiptMismatch ? [] : [...swaps, ...transfers],
          },
    ) as T[];
  return { rpc, calls };
}

test("persistent batch scopes both event sources, preserves exact amounts and verifies boundary evidence", async () => {
  const { rpc, calls } = fake();
  const result = await collectPoolEvents(range, rpc);
  assert.deepEqual(calls, [
    {
      address: contracts.manager,
      topics: [toEventSelector(swapEvent), poolId],
      from: 1499,
      to: 1501,
    },
    {
      address: token,
      topics: [toEventSelector(transferEvent)],
      from: 1499,
      to: 1501,
    },
  ]);
  assert.equal(result.swaps[0].decoded?.amount1, "200000000000000000000");
  assert.equal(result.transfers[0].value, "200000000000000000000");
  assert.equal(result.swaps[0].transactionSender, sender);
  assert.notEqual(result.swaps[0].decoded?.sender, sender);
  assert.equal(result.fromBlockParentHash, word(1498));
  assert.equal(result.blockHash, word(1501));
  assert.equal(result.evidence.receipts.length, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("persistent batch rejects out-of-scope events even if RPC ignores filters", async () => {
  for (const log of [
    { ...swap(), address: token as Hex },
    {
      ...swap(),
      topics: [toEventSelector(swapEvent), word(99), word(4)] as [
        Hex,
        ...Hex[],
      ],
    },
    { ...swap(), blockNumber: hex(1498) },
    { ...swap(), removed: true },
  ])
    await assert.rejects(
      collectPoolEvents(range, fake({ swaps: [log] }).rpc),
      /source or range/,
    );
  await assert.rejects(
    collectPoolEvents(
      range,
      fake({ transfers: [{ ...transfer(), address: sender as Hex }] }).rpc,
    ),
    /source or range/,
  );
});

test("persistent batch refuses inconsistent receipts and a cutoff reorganization", async () => {
  await assert.rejects(
    collectPoolEvents(range, fake({ receiptMismatch: true }).rpc),
    /receipt or canonical/,
  );
  await assert.rejects(
    collectPoolEvents(range, fake({ reorg: true }).rpc),
    /Cutoff changed/,
  );
  await assert.rejects(
    collectPoolEvents(range, fake({ swaps: [swap(), swap()] }).rpc),
    /Duplicate/,
  );
});

test("unsupported swap signs retain raw evidence without fabricated trade attribution", async () => {
  const result = await collectPoolEvents(
    range,
    fake({ swaps: [swap(true)] }).rpc,
  );
  assert.equal(result.swaps[0].decoded, null);
  assert.equal(result.swaps[0].unsupportedReason, "unsupported_swap_signs");
  assert.deepEqual(result.evidence.swapLogs[0], swap(true));
});

test("persistent batches enforce chain, confirmation lag and bounded integer ranges", async () => {
  await assert.rejects(
    collectPoolEvents(range, fake({ chain: 1 }).rpc),
    /Wrong chain/,
  );
  for (const r of [
    { ...range, toBlock: 1873 },
    { ...range, fromBlock: -1 },
    { ...range, fromBlock: 10, toBlock: 2010 },
    { ...range, fromBlock: 1.5 },
    { ...range, fromBlock: 1502 },
  ])
    await assert.rejects(collectPoolEvents(r, fake().rpc), /range/);
  const result = await collectPoolEvents(
    range,
    fake({ swaps: [], transfers: [] }).rpc,
  );
  assert.equal(result.swaps.length, 0);
  assert.equal(result.fromBlockParentHash, word(1498));
});

test("catalog explicit ranges do not silently scan or merge a larger historical window", async () => {
  const { rpc, calls } = fake({ swaps: [], transfers: [] });
  const { catalog } = await collectCatalog(undefined, rpc, {
    fromBlock: 1500,
    toBlock: 1501,
  });
  assert.equal(catalog.ranges[0].fromBlock, 1500);
  assert.equal(catalog.toBlock, 1501);
  assert.equal(calls[0].from, 1500);
  assert.equal(calls[0].to, 1501);
  assert.deepEqual(calls[0].address, [
    ...contracts.strategies,
    tokenMetadataFactory,
  ]);
  await assert.rejects(
    collectCatalog(catalog, rpc, { fromBlock: 1500, toBlock: 1501 }),
    /no previous catalog/,
  );
  await assert.rejects(
    collectCatalog(undefined, rpc, { fromBlock: 0, toBlock: 10000 }),
    /10000 blocks/,
  );
  await assert.rejects(
    collectCatalog(undefined, rpc, { fromBlock: 1873, toBlock: 1873 }),
    /confirmed cutoff/,
  );
  await assert.rejects(
    collectCatalog(
      undefined,
      fake({ reorg: true, swaps: [], transfers: [] }).rpc,
      { fromBlock: 1500, toBlock: 1501 },
    ),
    /Cutoff changed/,
  );
});

test("grouped range preserves per-pool evidence and shares routed transaction receipts", async () => {
  const second = { poolId: word(5), token: sender };
  const secondSwap = {
    ...swap(),
    topics: [toEventSelector(swapEvent), second.poolId, word(4)] as [
      Hex,
      ...Hex[],
    ],
    logIndex: "0x2" as Hex,
  };
  const secondTransfer: RawLog = {
    ...transfer(),
    address: sender,
    logIndex: "0x3" as Hex,
  };
  const swaps = [swap(), secondSwap],
    transfers = [transfer(), secondTransfer];
  const { rpc, calls } = fake({ swaps, transfers });
  const batch = rpc.batch.bind(rpc);
  const batches: { method: string; count: number }[] = [];
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    batches.push({ method, count: params.length });
    return batch<T>(method, params);
  };
  const actual = await collectPoolEventGroup(
    { ...range, pools: [{ poolId, token }, second] },
    rpc,
  );
  const expected = [];
  for (const pool of [{ poolId, token }, second]) {
    const single = fake({ swaps, transfers }).rpc;
    single.logs = async (address) =>
      address === contracts.manager
        ? swaps.filter((l) => l.topics[1] === pool.poolId)
        : transfers.filter((l) => l.address === pool.token);
    expected.push(await collectPoolEvents({ ...range, ...pool }, single));
  }
  assert.deepEqual(actual, expected);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].topics, [
    toEventSelector(swapEvent),
    [poolId, second.poolId],
  ]);
  assert.deepEqual(calls[1].address, [token, sender]);
  assert.deepEqual(batches, [
    { method: "eth_getBlockByNumber", count: 3 },
    { method: "eth_getTransactionReceipt", count: 1 },
  ]);
});

test("200 quiet pools use two log queries and retain complete empty-range boundaries", async () => {
  const pools = Array.from({ length: 200 }, (_, i) => ({
    poolId: word(i + 1),
    token: `0x${(i + 1).toString(16).padStart(40, "0")}`,
  }));
  const { rpc, calls } = fake({ swaps: [], transfers: [] });
  const actual = await collectPoolEventGroup({ ...range, pools }, rpc);
  assert.equal(actual.length, 200);
  assert.equal(calls.length, 2);
  for (const result of actual) {
    assert.equal(result.fromBlockParentHash, word(1498));
    assert.equal(result.blockHash, word(1501));
    assert.equal(result.swaps.length + result.transfers.length, 0);
  }
});

test("grouped range rejects foreign or duplicate logs, bad receipts and a changed shared cutoff", async () => {
  const group = { ...range, pools: [{ poolId, token }] };
  for (const options of [
    { swaps: [{ ...swap(), address: token as Hex }] },
    { transfers: [{ ...transfer(), address: sender as Hex }] },
    { swaps: [swap(), swap()] },
    { swaps: [{ ...swap(), removed: true }] },
    { swaps: [{ ...swap(), blockNumber: hex(1498) }] },
    { receiptMismatch: true },
    { reorg: true },
  ])
    await assert.rejects(collectPoolEventGroup(group, fake(options).rpc));
  for (const pools of [
    [],
    [group.pools[0], group.pools[0]],
    [{ poolId: "invalid", token }],
  ])
    await assert.rejects(
      collectPoolEventGroup({ ...group, pools }, fake().rpc),
      /Invalid/,
    );
  await assert.rejects(
    collectPoolEventGroup(group, fake({ chain: 1 }).rpc),
    /Wrong chain/,
  );
  const rpc = fake().rpc;
  rpc.batch = async <T>() => [] as T[];
  await assert.rejects(collectPoolEventGroup(group, rpc), /Incomplete/);
});
