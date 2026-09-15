import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import { collectPoolEventGroup } from "./pool-event-group";
import {
  broadEventPolicy,
  type BroadPoolEventRange,
  type BroadPoolIdentity,
} from "./broad-pool-events";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
} from "./deployments";
import { contracts, swapEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
import type { EventHeader } from "./pool-events";
import type { Receipt } from "./audit";

const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const first = instantRegistryStartBlock;
const poolId = word(3),
  otherId = word(5),
  unknownId = word(7);
const token = "0x1111111111111111111111111111111111111111";
const sender = "0x2222222222222222222222222222222222222222";
const header = (n: number): EventHeader => ({
  number: hex(n),
  hash: word(n),
  parentHash: word(n - 1),
  timestamp: hex(n * 2),
});
const swap = (
  id = poolId,
  index = 0,
  amounts: [bigint, bigint] = [-10n, 200000000000000000001n],
): RawLog => ({
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), id, word(4)],
  data: encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [...amounts, (1n << 96n) + 123n, 100000000000000000001n, -2, 2500],
  ),
  blockNumber: hex(first + 1),
  blockHash: word(first + 1),
  transactionHash: word(9),
  logIndex: hex(index),
  removed: false,
});
const pool = (id = poolId): BroadPoolIdentity => ({
  poolId: id,
  token,
  launchBlock: first,
});
function range(
  resolvePools: BroadPoolEventRange["resolvePools"] = async () => [pool()],
): BroadPoolEventRange {
  return {
    mode: "broad",
    fromBlock: first,
    toBlock: first + 2,
    registry: {
      stream: "discovery:v2",
      revision: instantRegistryRevision,
      sourceRevision: instantRegistrySourceRevision,
      throughBlock: first + 10,
      blockHash: word(first + 10),
    },
    resolvePools,
  };
}
function fake(
  options: {
    logs?: RawLog[];
    chain?: number;
    head?: number;
    receipt?: (r: Receipt) => Receipt;
    header?: (h: EventHeader, final: boolean) => EventHeader;
    incomplete?: "headers" | "receipts";
    blockRows?: (rows: Receipt[]) => Receipt[];
  } = {},
) {
  const logs = options.logs ?? [swap()];
  const rpc = new Rpc();
  const queries: {
    address: unknown;
    topics: unknown[];
    from: number;
    to: number;
  }[] = [];
  const batches: { method: string; params: unknown[][] }[] = [];
  let finalHeaders = false;
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return hex(options.chain ?? 4663) as T;
    if (method === "eth_blockNumber")
      return hex(options.head ?? first + 20000) as T;
    throw Error("Unexpected single RPC call");
  };
  rpc.logs = async (address, topics, from, to) => {
    queries.push({ address, topics, from, to });
    return [...logs];
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    batches.push({ method, params });
    if (method === "eth_getBlockByNumber") {
      const rows = params.map((p) => {
        const h = header(Number(p[0]));
        return options.header?.(h, finalHeaders) ?? h;
      });
      // Fixtures use one initial header chunk; an empty group still rechecks.
      finalHeaders = true;
      return (options.incomplete === "headers" ? rows.slice(1) : rows) as T[];
    }
    if (method === "eth_getBlockReceipts") {
      const rows = await Promise.all(
        params.map(async (p) => {
          const txs = [
            ...new Set(
              logs
                .filter((l) => Number(l.blockNumber) === Number(p[0]))
                .map((l) => l.transactionHash),
            ),
          ];
          const own = await rpc.batch<Receipt>(
            "eth_getTransactionReceipt",
            txs.map((h) => [h]),
          );
          return options.blockRows?.(own) ?? own.reverse();
        }),
      );
      return rows as T[];
    }
    if (method !== "eth_getTransactionReceipt")
      throw Error("Unexpected batch call");
    const rows = params.map((p): Receipt => {
      const own = logs.filter((l) => l.transactionHash.toLowerCase() === p[0]);
      const r: Receipt = {
        transactionHash: p[0] as Hex,
        blockHash: own[0].blockHash,
        status: "0x1",
        from: sender,
        to: contracts.router,
        logs: own,
      };
      Object.assign(r, { blockNumber: own[0].blockNumber });
      return options.receipt?.(r) ?? r;
    });
    return (options.incomplete === "receipts" ? rows.slice(1) : rows) as T[];
  };
  return { rpc, queries, batches };
}

test("broad group scans the manager once, filters registered IDs and shares evidence across pools", async () => {
  const unknown = { ...swap(unknownId, 2), transactionHash: word(10) };
  const logs = [swap(otherId, 1), unknown, swap()];
  let calls = 0;
  const r = range(async (ids) => {
    calls++;
    assert.deepEqual(ids, [poolId, otherId, unknownId]);
    assert.equal(Object.isFrozen(ids), true);
    // The same token in different pool IDs is not an identity conflict.
    return [pool(otherId), pool()];
  });
  const { rpc, queries, batches } = fake({ logs });
  const result = await collectPoolEventGroup(r, rpc);
  assert.equal(calls, 1);
  assert.deepEqual(queries, [
    {
      address: contracts.manager,
      topics: [toEventSelector(swapEvent)],
      from: first,
      to: first + 2,
    },
  ]);
  assert.equal(result.mode, "broad");
  assert.equal(result.chainId, 4663);
  assert.equal(result.manager, contracts.manager);
  assert.deepEqual(result.registry, r.registry);
  assert.deepEqual(result.pools, [pool(), pool(otherId)]);
  assert.equal(result.observedSwaps, 3);
  assert.equal(result.unregisteredSwaps, 1);
  assert.equal(result.unsupportedSwaps, 0);
  assert.equal(result.evidence.swapLogs.length, 3);
  assert.equal(result.evidence.receipts.length, 1);
  assert.deepEqual(
    batches
      .filter((b) => b.method === "eth_getTransactionReceipt")
      .map((b) => b.params),
    [[[word(9)]]],
  );
  assert.equal(
    new Set(result.evidence.headers.map((h) => h.number)).size,
    result.evidence.headers.length,
  );
  assert.equal(result.swaps.length, 2);
  for (const s of result.swaps) {
    assert.equal(s.supported, false);
    assert.deepEqual(s.flags, ["missing_transfer_history"]);
    assert.equal(s.transactionSender, sender);
    assert.equal(s.managerSender, "0x0000000000000000000000000000000000000004");
    assert.equal(s.amount0, "-10");
    assert.equal(s.amount1, "200000000000000000001");
    assert.equal(s.sqrtPriceX96, ((1n << 96n) + 123n).toString());
    assert.equal(s.liquidity, "100000000000000000001");
    assert.equal(s.tick, -2);
    assert.equal(s.fee, 2500);
    assert.equal(s.side, "buy");
    assert.equal(s.ethWei, "10");
    assert.equal(s.tokenRaw, "200000000000000000001");
    assert.equal("wallet" in s, false);
    assert.equal("beneficiary" in s, false);
    assert.equal("realizedWei" in s, false);
  }
  assert.equal(result.fromBlockParentHash, word(first - 1));
  assert.equal(result.blockHash, word(first + 2));
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("broad unsupported signs keep raw decoded state and explicit exclusions", async () => {
  for (const amounts of [
    [10n, 20n],
    [0n, 0n],
    [-10n, -20n],
  ] as [bigint, bigint][]) {
    const log = swap(poolId, 0, amounts);
    const result = await collectPoolEventGroup(
      range(),
      fake({ logs: [log] }).rpc,
    );
    assert.equal(result.unsupportedSwaps, 1);
    assert.equal(result.swaps.length, 1);
    assert.equal(result.swaps[0].amount0, amounts[0].toString());
    assert.equal(result.swaps[0].amount1, amounts[1].toString());
    assert.equal(result.swaps[0].sqrtPriceX96, ((1n << 96n) + 123n).toString());
    assert.deepEqual(result.swaps[0].flags, [
      "missing_transfer_history",
      "unsupported_swap_signs",
    ]);
    assert.equal(result.swaps[0].supported, false);
    assert.equal(result.swaps[0].side, null);
    assert.equal(result.swaps[0].ethWei, null);
    assert.equal(result.swaps[0].tokenRaw, null);
    assert.deepEqual(result.evidence.swapLogs, [log]);
  }
  const sell = await collectPoolEventGroup(
    range(),
    fake({ logs: [swap(poolId, 0, [20n, -30n])] }).rpc,
  );
  assert.equal(sell.swaps[0].side, "sell");
  assert.equal(sell.swaps[0].ethWei, "20");
  assert.equal(sell.swaps[0].tokenRaw, "30");
});

test("broad receipt fetching is chunked and retains each transaction only once", async () => {
  const logs = Array.from({ length: 25 }, (_, i) => ({
    ...swap(poolId, i),
    transactionHash: word(i + 100),
  }));
  const { rpc, batches } = fake({ logs });
  const result = await collectPoolEventGroup(range(), rpc);
  assert.deepEqual(
    batches
      .filter((b) => b.method === "eth_getTransactionReceipt")
      .map((b) => b.params.length),
    [20, 5],
  );
  assert.equal(result.evidence.receipts.length, 25);
  assert.equal(result.swaps.length, 25);
  assert.equal(
    new Set(result.evidence.receipts.map((r) => r.transactionHash)).size,
    25,
  );
});

test("broad empty and entirely unregistered ranges retain canonical checkpoints without receipts", async () => {
  for (const logs of [[], [swap(unknownId)]]) {
    const { rpc, batches } = fake({ logs });
    let resolutions = 0;
    const result = await collectPoolEventGroup(
      range(async () => {
        resolutions++;
        return [];
      }),
      rpc,
    );
    assert.equal(resolutions, logs.length ? 1 : 0);
    assert.deepEqual(result.swaps, []);
    assert.deepEqual(result.pools, []);
    assert.equal(result.unregisteredSwaps, logs.length);
    assert.equal(result.fromBlock, first);
    assert.equal(result.toBlock, first + 2);
    assert.equal(result.blockHash, word(first + 2));
    assert.equal(result.fromBlockParentHash, word(first - 1));
    assert.equal(
      batches.some((b) => b.method === "eth_getTransactionReceipt"),
      false,
    );
  }
});

test("broad source, range, duplicate and canonical checks also cover unregistered logs", async () => {
  for (const log of [
    { ...swap(unknownId), address: token as Hex },
    {
      ...swap(unknownId),
      topics: [word(99), unknownId, word(4)] as [Hex, ...Hex[]],
    },
    { ...swap(unknownId), blockNumber: hex(first - 1) },
    { ...swap(unknownId), blockHash: word(99) },
    { ...swap(unknownId), logIndex: "0x-1" as Hex },
    { ...swap(unknownId), removed: true },
    { ...swap(unknownId), data: "0x1234" as Hex },
  ])
    await assert.rejects(
      collectPoolEventGroup(
        range(async () => []),
        fake({ logs: [log] }).rpc,
      ),
    );
  await assert.rejects(
    collectPoolEventGroup(range(), fake({ logs: [swap(), swap()] }).rpc),
    /Duplicate/,
  );
});

test("broad registry resolver rejects extra, duplicate, malformed and future-launch identities", async () => {
  for (const resolved of [
    [pool(unknownId)],
    [pool(), pool()],
    [{ ...pool(), token: "bad" }],
    [{ ...pool(), launchBlock: first + 2 }],
    [{ ...pool(), launchBlock: first - 1 }],
    [{ ...pool(), launchBlock: first + 20 }],
  ])
    await assert.rejects(
      collectPoolEventGroup(
        range(async () => resolved),
        fake().rpc,
      ),
      /registry|precedes/,
    );
});

test("broad receipts reject identity conflicts, duplicates, missing evidence and failed transactions", async () => {
  const alterations: ((r: Receipt) => Receipt)[] = [
    (r) => ({ ...r, transactionHash: word(99) }),
    (r) => ({ ...r, blockHash: word(99) }),
    (r) => ({ ...r, status: "0x0" }),
    (r) => ({ ...r, from: "0x1234" }),
    (r) => ({ ...r, logs: [] }),
    (r) => ({ ...r, logs: [...r.logs, ...r.logs] }),
    (r) => ({ ...r, logs: r.logs.map((l) => ({ ...l, address: token })) }),
    (r) => ({
      ...r,
      logs: r.logs.map((l) => ({ ...l, transactionHash: word(99) })),
    }),
    (r) => ({ ...r, logs: r.logs.map((l) => ({ ...l, blockHash: word(99) })) }),
    (r) => ({
      ...r,
      logs: r.logs.map((l) => ({ ...l, blockNumber: hex(first) })),
    }),
    (r) => ({
      ...r,
      logs: r.logs.map((l) => ({
        ...l,
        data: swap(poolId, 0, [20n, -30n]).data,
      })),
    }),
    (r) => ({ ...r, logs: r.logs.map((l) => ({ ...l, removed: true })) }),
  ];
  for (const receipt of alterations)
    await assert.rejects(
      collectPoolEventGroup(range(), fake({ receipt }).rpc),
      /receipt/i,
    );
  for (const incomplete of ["headers", "receipts"] as const)
    await assert.rejects(
      collectPoolEventGroup(range(), fake({ incomplete }).rpc),
      /Missing broad/,
    );
});

test("broad canonical rechecks reject changes to either range end or registry checkpoint", async () => {
  for (const target of [first, first + 2, first + 10])
    await assert.rejects(
      collectPoolEventGroup(
        range(),
        fake({
          header: (h, final) =>
            final && Number(h.number) === target ? { ...h, hash: word(99) } : h,
        }).rpc,
      ),
      /Broad boundary changed/,
    );
  await assert.rejects(
    collectPoolEventGroup(
      range(),
      fake({
        header: (h) =>
          Number(h.number) === first + 10 ? { ...h, hash: word(99) } : h,
      }).rpc,
    ),
    /registry boundary changed/,
  );
  for (const patch of [{ timestamp: hex(first) }, { parentHash: word(99) }])
    await assert.rejects(
      collectPoolEventGroup(
        range(),
        fake({
          header: (h) =>
            Number(h.number) === first + 1 ? { ...h, ...patch } : h,
        }).rpc,
      ),
      /Inconsistent broad canonical headers/,
    );
});

test("broad chain, revision, confirmation and whole-batch bounds fail without partial results", async () => {
  await assert.rejects(
    collectPoolEventGroup(range(), fake({ chain: 1 }).rpc),
    /Wrong chain/,
  );
  await assert.rejects(
    collectPoolEventGroup(range(), fake({ head: first + 137 }).rpc),
    /confirmed cutoff/,
  );
  for (const patch of [
    { fromBlock: first - 1 },
    { fromBlock: first + 3 },
    { fromBlock: first + 0.5 },
    { toBlock: first + 10000 },
  ])
    await assert.rejects(
      collectPoolEventGroup({ ...range(), ...patch }, fake().rpc),
      /range/,
    );
  for (const patch of [
    { revision: "future" },
    { sourceRevision: "wrong" },
    { throughBlock: first + 1 },
    { blockHash: "bad" },
    { stream: "discovery:v1" as "discovery:v2" },
  ])
    await assert.rejects(
      collectPoolEventGroup(
        { ...range(), registry: { ...range().registry, ...patch } },
        fake().rpc,
      ),
      /registry checkpoint/,
    );
  await assert.rejects(
    collectPoolEventGroup(
      range(),
      fake({
        logs: Array.from({ length: broadEventPolicy.maxLogs + 1 }, (_, i) =>
          swap(poolId, i),
        ),
      }).rpc,
    ),
    /exceeds capacity/,
  );
  await assert.rejects(
    collectPoolEventGroup(
      range(),
      fake({
        receipt: (r) => ({
          ...r,
          logs: [
            ...r.logs,
            { ...swap(), data: `0x${"f".repeat(broadEventPolicy.maxBytes)}` },
          ],
        }),
      }).rpc,
    ),
    /exceeds capacity/,
  );
  const maxRange = range(async () => []);
  maxRange.toBlock = first + 9999;
  maxRange.registry.throughBlock = maxRange.toBlock;
  maxRange.registry.blockHash = word(maxRange.toBlock);
  assert.equal(
    (await collectPoolEventGroup(maxRange, fake({ logs: [] }).rpc)).toBlock,
    maxRange.toBlock,
  );
});

test("block receipts preserve exact transaction evidence/order across multi-pool transactions and discard unrelated receipts", async () => {
  const logs = [
    swap(),
    swap(otherId, 1),
    { ...swap(poolId, 2), transactionHash: word(10) },
    { ...swap(unknownId, 3), transactionHash: word(11) },
  ];
  const r = range(async () => [pool(), pool(otherId)]);
  const legacy = await collectPoolEventGroup(r, fake({ logs }).rpc);
  const block = await collectPoolEventGroup(
    { ...r, receiptMode: "block" },
    fake({ logs }).rpc,
  );
  assert.deepEqual(block, legacy);
  assert.equal(block.evidence.receipts.length, 2);
});

test("block receipts reject malformed, duplicate, missing, wrong-block and oversized-count responses", async (t) => {
  for (const [name, blockRows] of [
    ["missing", () => []],
    ["duplicate", (r: Receipt[]) => [r[0], r[0]]],
    ["wrong hash", (r: Receipt[]) => [{ ...r[0], blockHash: word(2) }]],
    [
      "wrong number",
      (r: Receipt[]) => [
        Object.assign({ ...r[0] }, { blockNumber: hex(first) }),
      ],
    ],
    ["null", () => [null as unknown as Receipt]],
    ["count", (r: Receipt[]) => Array(2001).fill(r[0])],
    ["failed selected", (r: Receipt[]) => [{ ...r[0], status: "0x0" as Hex }]],
    [
      "altered log",
      (r: Receipt[]) => [
        { ...r[0], logs: [{ ...r[0].logs[0], data: "0x" as Hex }] },
      ],
    ],
  ] as const)
    await t.test(name, async () => {
      await assert.rejects(
        collectPoolEventGroup(
          { ...range(), receiptMode: "block" },
          fake({ blockRows }).rpc,
        ),
      );
    });
});
