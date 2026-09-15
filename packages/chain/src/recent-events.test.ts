import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import { collectRecentEvents } from "./recent-events";
import { contracts, swapEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const token: Hex = `0x${"1".repeat(40)}`,
  sender = `0x${"2".repeat(40)}`;
const range = {
  fromBlock: 1499,
  toBlock: 1501,
  pools: [{ id: word(3), token, launchBlock: 1400 }],
};
const header = (n: number) => ({
  number: hex(n),
  hash: word(n),
  parentHash: word(n - 1),
  timestamp: hex(n * 2),
});
function swap(id = 3, unsupported = false): RawLog {
  return {
    address: contracts.manager,
    topics: [toEventSelector(swapEvent), word(id), word(4)],
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
    logIndex: hex(id),
    removed: false,
  };
}
function mock(
  logs = [swap()],
  opts: { reorg?: boolean; badReceipt?: boolean; chain?: number } = {},
) {
  const rpc = new Rpc();
  const queries: unknown[] = [];
  const receiptRequests: unknown[] = [];
  const headerRequests: unknown[] = [];
  rpc.logs = async (a, t, f, z) => {
    queries.push([a, t, f, z]);
    return logs;
  };
  rpc.call = async <T>(m: string, p: unknown[]) => {
    if (m === "eth_chainId") return hex(opts.chain ?? 4663) as T;
    if (m === "eth_blockNumber") return hex(2000) as T;
    return {
      ...header(Number(p[0])),
      ...(opts.reorg ? { hash: word(999) } : {}),
    } as T;
  };
  rpc.batch = async <T>(m: string, ps: unknown[][]) =>
    ps.map((p) => {
      if (m === "eth_getBlockByNumber") {
        headerRequests.push(p[0]);
        return header(Number(p[0]));
      }
      receiptRequests.push(p[0]);
      return {
        transactionHash: p[0],
        blockHash: word(1500),
        status: "0x1",
        from: sender,
        to: contracts.router,
        logs: opts.badReceipt ? [] : logs,
      };
    }) as T[];
  return { rpc, queries, receiptRequests, headerRequests };
}
test("one manager query filters unknown pools before receipt/header fetch and shares transaction evidence", async () => {
  const unknown = {
    ...swap(99),
    transactionHash: word(900),
    blockNumber: hex(1499),
    blockHash: word(1499),
  };
  const second = { ...swap(), logIndex: hex(4) };
  const m = mock([swap(), unknown, second]);
  const r = await collectRecentEvents(range, m.rpc);
  assert.deepEqual(m.queries, [
    [contracts.manager, [toEventSelector(swapEvent)], 1499, 1501],
  ]);
  assert.deepEqual(m.receiptRequests, [word(9)]);
  assert.equal(r.events.length, 2);
  assert.equal(r.unregisteredSwaps, 1);
  assert.equal(r.events[0].tokenRaw, "200000000000000000000");
  assert.equal(r.events[0].transactionSender, sender);
  assert.equal(r.events[0].side, "buy");
  assert.equal(r.evidence.logs.length, 2);
});
test("unsupported registered swaps retain evidence without inventing amounts", async () => {
  const m = mock([swap(3, true)]);
  const r = await collectRecentEvents(range, m.rpc);
  assert.equal(r.events.length, 0);
  assert.equal(r.unsupportedSwaps, 1);
  assert.equal(r.evidence.receipts.length, 1);
});
test("empty registry advances verified cutoff without fetching unknown transaction receipts", async () => {
  const m = mock();
  const r = await collectRecentEvents({ ...range, pools: [] }, m.rpc);
  assert.equal(r.unregisteredSwaps, 1);
  assert.deepEqual(m.receiptRequests, []);
  assert.equal(r.blockHash, word(1501));
});
test("recent collection rejects wrong source, duplicate evidence, incomplete receipts and changing cutoff", async () => {
  for (const logs of [
    [{ ...swap(), address: token }],
    [swap(), swap()],
    [{ ...swap(), blockNumber: hex(1498) }],
  ])
    await assert.rejects(collectRecentEvents(range, mock(logs).rpc));
  await assert.rejects(
    collectRecentEvents(range, mock(undefined, { badReceipt: true }).rpc),
    /receipt/,
  );
  await assert.rejects(
    collectRecentEvents(range, mock(undefined, { reorg: true }).rpc),
    /cutoff changed/,
  );
  await assert.rejects(
    collectRecentEvents(range, mock(undefined, { chain: 1 }).rpc),
    /Wrong chain/,
  );
});
test("recent ranges are bounded and swaps cannot precede verified launch", async () => {
  for (const r of [
    { ...range, fromBlock: -1 },
    { ...range, toBlock: 4000 },
    { ...range, toBlock: 1498 },
    { ...range, toBlock: 1900 },
    { ...range, pools: [{ ...range.pools[0], launchBlock: 1501 }] },
  ])
    await assert.rejects(collectRecentEvents(r, mock().rpc));
});
