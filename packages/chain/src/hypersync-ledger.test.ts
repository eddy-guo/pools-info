import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionResult,
  erc20Abi,
  multicall3Abi,
  toEventSelector,
  type Hex,
} from "viem";
import {
  HyperSyncClient,
  chunkValues,
  hypersyncPolicy,
  swapLogQuery,
  transferLogQuery,
  type HyperSyncLogSelection,
  type HyperSyncQuery,
} from "./hypersync";
import {
  collectLedgerRange,
  ledgerChunks,
  ledgerLaunchQuery,
  ledgerManagerQueryRecord,
  ledgerPassPolicy,
  ledgerQueryRecord,
  planLedgerRange,
  verifyLedgerLaunchBatch,
  type LedgerQueryRecord,
} from "./hypersync-ledger";
import {
  FakeHyperSync,
  fakeLaunch,
  fakeSwap,
  fakeTransfer,
  word,
} from "./hypersync-fake";
import {
  aggregateRequestData,
  decodeAggregateRequest,
  encodeAggregateReply,
} from "./multicall";
import { Rpc } from "./rpc";
import { getInstantDeployment, instantDeployments } from "./deployments";
import { contracts, launchEvent, swapEvent, transferEvent } from "./events";
import { tokenMetadataFactory } from "./token-metadata";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/hypersync/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const apiToken = "x".repeat(16);
/** A value-list record, where the test knows the query sent a list. */
function listRecord(record: LedgerQueryRecord) {
  if (record.selection === "manager") throw Error("expected a value list");
  return record;
}
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const start = ledgerPassPolicy.startBlock;
/** The swap lane's queries as `collectLedgerRange` itself builds them: sort
 * and dedup the registry's ids the way its `Map` keys already are, then one
 * query per `ledgerChunks` chunk. Test-only composition of the collector's own
 * exported primitives, not a second production implementation. */
const testSwapQueries = (
  range: { fromBlock: number; toBlock: number },
  poolIds: readonly string[],
) =>
  ledgerChunks(
    [...new Set(poolIds.map((id) => id.toLowerCase()))].sort(),
    ledgerPassPolicy.poolIdsPerQuery,
  ).map((chunk) =>
    swapLogQuery(range, chunk, ledgerPassPolicy.poolIdsPerQuery),
  );
const testTransferQueries = (
  range: { fromBlock: number; toBlock: number },
  tokens: readonly string[],
) =>
  ledgerChunks(
    [...new Set(tokens.map((t) => t.toLowerCase()))].sort(),
    ledgerPassPolicy.tokensPerQuery,
  ).map((chunk) =>
    transferLogQuery(range, chunk, ledgerPassPolicy.tokensPerQuery),
  );

/** A JSON-RPC provider answering name(), symbol(), decimals() and
 * totalSupply() through Multicall3 at a fixed head, counting every call. A
 * token's supply is 1e27 raw unless the test gives one. */
function metadataRpc(
  tokens: Record<string, [string, string, number, bigint?]> = {},
  head = 64798181,
) {
  const rpc = new Rpc();
  const calls: Record<string, number> = {};
  const count = (m: string) => (calls[m] = (calls[m] ?? 0) + 1);
  rpc.call = async <T>(method: string) => {
    count(method);
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return `0x${head.toString(16)}` as T;
    throw Error(`Unexpected JSON-RPC ${method}`);
  };
  rpc.logs = async () => {
    throw Error("Unexpected JSON-RPC eth_getLogs");
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    for (const _ of params) count(method);
    if (method !== "eth_call") throw Error(`Unexpected JSON-RPC ${method}`);
    return params.map((p) => {
      const [{ data }, block] = p as [{ to: Hex; data: Hex }, string];
      assert.equal(block, `0x${head.toString(16)}`);
      return encodeAggregateReply(
        decodeAggregateRequest(data).map((member) => {
          const fn = decodeFunctionData({
            abi: erc20Abi,
            data: member.callData,
          }).functionName as "name" | "symbol" | "decimals" | "totalSupply";
          const [name, symbol, decimals, supply = 10n ** 27n] = tokens[
            member.target.toLowerCase()
          ] ?? ["Token", "TKN", 18];
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result:
                fn === "name"
                  ? name
                  : fn === "symbol"
                    ? symbol
                    : fn === "decimals"
                      ? decimals
                      : supply,
            } as Parameters<typeof encodeFunctionResult>[0]),
          };
        }),
      );
    }) as T[];
  };
  return { rpc, calls };
}
const silentRpc = () => {
  const rpc = new Rpc();
  const refuse = async () => {
    throw Error("Unexpected JSON-RPC call");
  };
  rpc.call = refuse;
  rpc.batch = refuse;
  rpc.logs = refuse;
  return rpc;
};
const fakeClient = (fake: FakeHyperSync) =>
  new HyperSyncClient({ token: apiToken, minIntervalMs: 0, fetch: fake.fetch });

test("the lanes split the registry evenly over the fewest queries, every body under the 2 MiB limit", () => {
  // The 17 Sep 2026 catalogue: three swap queries and two transfer queries,
  // where fixed 20,000 and 31,000 chunks took four and three.
  const n = 62858;
  const range = { fromBlock: start, toBlock: start + 99999 };
  const ids = Array.from({ length: n }, (_, i) => word(i + 1));
  const swaps = testSwapQueries(range, ids);
  assert.deepEqual(
    swaps.map((q) => q.logs![0].topics![1].length),
    [20953, 20953, 20952],
  );
  const tokens = Array.from({ length: n }, (_, i) => addr(i + 1));
  const transfers = testTransferQueries(range, tokens);
  assert.deepEqual(
    transfers.map((q) => q.logs![0].address!.length),
    [31429, 31429],
  );
  // The caps: a fourth swap query past 75,000 pools, a third transfer query
  // past 80,000, and the largest bodies about 1.8 MB, a seventh under the limit.
  assert.deepEqual(
    [
      ledgerChunks(ids.concat(ids.slice(0, 75000 - n)), 25000).length,
      ledgerChunks(ids.concat(ids.slice(0, 75001 - n)), 25000).length,
      ledgerChunks(tokens.concat(tokens.slice(0, 80001 - n)), 40000).length,
    ],
    [3, 4, 3],
  );
  const widest = [
    swapLogQuery(range, ids.slice(0, 25000), ledgerPassPolicy.poolIdsPerQuery),
    transferLogQuery(
      range,
      tokens.slice(0, 40000),
      ledgerPassPolicy.tokensPerQuery,
    ),
  ].map((q) => Buffer.byteLength(JSON.stringify(q)));
  for (const bytes of widest) assert.ok(bytes < 1_810_000, `${bytes}`);
  assert.deepEqual(ledgerChunks([], 5), []);
  assert.throws(() => ledgerChunks([1], 0), /Invalid HyperSync chunk size/);
  for (const q of [...swaps, ...transfers]) {
    assert.equal(q.logs!.length, 1);
    assert.equal(q.from_block, start);
    assert.equal(q.to_block, start + 100000);
    assert.ok(
      Buffer.byteLength(JSON.stringify(q)) < hypersyncPolicy.maxRequestBytes,
    );
  }
  // The full selections sit near the measured bodies (1.38 MB and 1.40 MB).
  assert.ok(Buffer.byteLength(JSON.stringify(swaps[0])) > 1_300_000);
  assert.ok(Buffer.byteLength(JSON.stringify(transfers[0])) > 1_300_000);
  // Sorted and deduplicated, so a range's query bodies are reproducible.
  assert.deepEqual(
    testSwapQueries(range, [ids[5], ids[2], ids[5]])[0].logs![0].topics![1],
    [ids[2], ids[5]].sort(),
  );
  // The batch row keeps the count and a digest of the list, never the list.
  const record = listRecord(ledgerQueryRecord(swaps[0]));
  assert.deepEqual(
    { ...record, sha256: record.sha256.length },
    {
      from_block: start,
      to_block: start + 100000,
      selection: "pool_ids",
      count: 20953,
      sha256: 66,
    },
  );
  assert.equal(ledgerQueryRecord(transfers[1]).selection, "tokens");
  assert.equal(listRecord(ledgerQueryRecord(transfers[1])).count, 31429);
  assert.ok(JSON.stringify(record).length < 300);
  assert.throws(
    () => testSwapQueries(range, ["0x12"]),
    /Invalid HyperSync pool id selection/,
  );
  // The max-range-span guard is shared with ledgerLaunchQuery (both call the
  // same local checkedRange); collectLedgerRange enforces it for a real pass.
  assert.throws(
    () => ledgerLaunchQuery({ fromBlock: 5, toBlock: 5 + 1_000_000 }),
    /Invalid HyperSync ledger range/,
  );
  // A four-id selection is the recorded pool-filter body up to id order.
  const recorded = fixture("swaps-pool-filter.request") as HyperSyncQuery;
  const four = testSwapQueries(
    { fromBlock: 62688988, toBlock: 62689007 },
    recorded.logs![0].topics![1],
  );
  assert.deepEqual(
    { ...four[0], logs: [{ ...four[0].logs![0], topics: [] }] },
    { ...recorded, logs: [{ ...recorded.logs![0], topics: [] }] },
  );
  assert.deepEqual(
    [...four[0].logs![0].topics![1]].sort(),
    [...recorded.logs![0].topics![1]].sort(),
  );
});

test("the launch query selects the strategies, the factory and the launchers with the default join", () => {
  const q = ledgerLaunchQuery({ fromBlock: start, toBlock: start + 99999 });
  assert.equal(q.include_all_blocks, undefined);
  assert.equal(q.logs!.length, 2);
  assert.deepEqual(q.logs![0].address, [
    ...contracts.strategies,
    tokenMetadataFactory,
  ]);
  assert.equal(q.logs![0].topics![0].length, 2);
  assert.deepEqual(q.logs![1], { address: [...contracts.launchers] });
  assert.equal(q.max_num_logs, hypersyncPolicy.maxLogsPerPage);
  assert.ok(q.field_selection.transaction!.includes("from"));
  assert.throws(
    () => ledgerLaunchQuery({ fromBlock: 10, toBlock: 9 }),
    /Invalid HyperSync ledger range/,
  );
});

test("range planning starts at the first launch, ends at the confirmed cutoff and stops there", () => {
  const height = start + 250_000 + 128;
  assert.deepEqual(
    planLedgerRange({ cursor: null, start, height, rangeBlocks: 100000 }),
    { fromBlock: start, toBlock: start + 99999 },
  );
  assert.deepEqual(
    planLedgerRange({
      cursor: start + 199999,
      start,
      height,
      rangeBlocks: 100000,
    }),
    { fromBlock: start + 200000, toBlock: start + 250000 },
  );
  assert.equal(
    planLedgerRange({
      cursor: start + 250000,
      start,
      height,
      rangeBlocks: 100000,
    }),
    null,
  );
  assert.throws(
    () => planLedgerRange({ cursor: null, start, height, rangeBlocks: 0 }),
    /Invalid HyperSync ledger range/,
  );
});

/** Serve recorded pages by selection, as the server does: a log belongs to a
 * query when one of its selections matches its address and topics. */
function recordedFetch(
  responses: Record<string, unknown>,
  height: number,
  requests: HyperSyncQuery[] = [],
): typeof globalThis.fetch {
  const matches = (
    log: Record<string, unknown>,
    selections: HyperSyncLogSelection[],
  ) =>
    selections.some(
      (s) =>
        (!s.address?.length ||
          s.address.some(
            (a) => a.toLowerCase() === String(log.address).toLowerCase(),
          )) &&
        (s.topics ?? []).every(
          (values, i) =>
            !values.length ||
            values.some(
              (v) => v.toLowerCase() === String(log[`topic${i}`]).toLowerCase(),
            ),
        ),
    );
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/height")
      return new Response(JSON.stringify({ height }), { status: 200 });
    const query = JSON.parse(String(init?.body)) as HyperSyncQuery;
    requests.push(query);
    // One recorded page holds every row of the range; each query sees the
    // rows its selections match and the blocks and transactions they need.
    const pool = Object.values(responses) as {
      data: {
        logs?: Record<string, unknown>[];
        transactions?: Record<string, unknown>[];
        blocks?: Record<string, unknown>[];
      }[];
      archive_height: number;
      next_block: number;
    }[];
    const logs = [
      ...new Map(
        pool
          .flatMap((r) => r.data.flatMap((c) => c.logs ?? []))
          .map((l) => [`${l.transaction_hash}:${l.log_index}`, l]),
      ).values(),
    ];
    const transactions = pool.flatMap((r) =>
      r.data.flatMap((c) => c.transactions ?? []),
    );
    const blocks = pool.flatMap((r) => r.data.flatMap((c) => c.blocks ?? []));
    const to = query.to_block ?? height + 1;
    const selected = query.logs
      ? logs.filter(
          (l) =>
            Number(l.block_number) >= query.from_block &&
            Number(l.block_number) < to &&
            matches(l, query.logs!),
        )
      : [];
    const txHashes = new Set(selected.map((l) => l.transaction_hash));
    const blockNumbers = new Set(selected.map((l) => l.block_number));
    if (query.include_all_blocks)
      for (let n = query.from_block; n < to; n++) blockNumbers.add(n);
    const unique = <T extends Record<string, unknown>>(
      rows: T[],
      key: string,
    ) => [...new Map(rows.map((r) => [String(r[key]), r])).values()];
    const chunk = {
      logs: selected,
      transactions: unique(transactions, "hash").filter((t) =>
        txHashes.has(t.hash as string),
      ),
      blocks: unique(blocks, "number")
        .filter((b) => blockNumbers.has(b.number as number))
        .sort((a, b) => Number(a.number) - Number(b.number)),
    };
    return new Response(
      JSON.stringify({
        data: [chunk],
        archive_height: height,
        next_block: to,
        total_execution_time: 1,
        rollback_guard: null,
      }),
      { status: 200 },
    );
  };
}

test("recorded filtered swap and transfer pages become ledger rows joined to their transactions and blocks", async () => {
  const from = 62688988,
    to = 62689007;
  const swapIds = (fixture("swaps-pool-filter.request") as HyperSyncQuery)
    .logs![0].topics![1];
  const tokens = [
    "0x433025fe9550ed919d8b28b53a3f5419be678d0d",
    "0xb480aa907f5ca5364daa47508f06d248411f28be",
  ];
  // The registry is the caller's claim: four pools, two of them with the
  // recorded transfer tokens; the unfiltered page supplies the boundary headers.
  const registry = swapIds.map((poolId, i) => ({
    poolId,
    token: tokens[i] ?? addr(0x900 + i),
    launchBlock: from - 1000,
  }));
  const requests: HyperSyncQuery[] = [];
  const client = new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    fetch: recordedFetch(
      {
        swaps: fixture("swaps-pool-filter.response"),
        transfers: fixture("transfers-token-filter.response"),
        all: fixture("swaps-unfiltered.response"),
      },
      64149078,
      requests,
    ),
  });
  const c = await collectLedgerRange(client, silentRpc(), {
    fromBlock: from,
    toBlock: to,
    parentHash: null,
    height: 64149078,
    registry,
    swapSelection: "pool_ids",
  });
  assert.equal(c.fromBlock, from);
  assert.equal(c.toBlock, to);
  assert.equal(c.swaps.length, 5);
  assert.equal(c.transfers.length, 9);
  assert.equal(c.unsupportedSwaps, 0);
  assert.equal(c.launch.pools.length, 0);
  assert.equal(c.registryPools, 4);
  // launch, one swap chunk, one transfer chunk, the cutoff and from headers.
  assert.equal(c.requests, 5);
  assert.deepEqual(
    requests.map((q) => [q.from_block, q.to_block, q.logs?.length ?? 0]),
    [
      [from, to + 1, 2],
      [from, to + 1, 1],
      [from, to + 1, 1],
      [to, to + 1, 0],
      [from, from + 1, 0],
    ],
  );
  assert.deepEqual(
    c.swaps.map((s) => [s.block, s.logIndex]),
    [
      [62688988, 20],
      [62688991, 56],
      [62688992, 4],
      [62688992, 42],
      [62688993, 0],
    ],
  );
  const byPool = new Map(registry.map((p) => [p.poolId.toLowerCase(), p]));
  for (const s of c.swaps) {
    assert.ok(byPool.has(s.poolId));
    assert.equal(s.token, byPool.get(s.poolId)!.token);
    assert.match(s.initiator, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(s.ethWei) > 0n && BigInt(s.tokenRaw) > 0n);
    assert.ok(s.side === "buy" || s.side === "sell");
    assert.equal(s.blockHash, s.blockHash.toLowerCase());
    assert.ok(s.timestamp > 1_700_000_000);
  }
  for (const t of c.transfers) {
    assert.ok(tokens.includes(t.token));
    assert.match(t.from, /^0x[0-9a-f]{40}$/);
    assert.match(t.to, /^0x[0-9a-f]{40}$/);
    assert.match(t.value, /^\d+$/);
  }
  // The recorded first swap, pinned: MEEP's launch-block buy.
  const first = c.swaps[0];
  assert.equal(
    first.poolId,
    "0x53a3e65a7b8a1810d2817613c3306b9fd90d24ad1ee228a61e8ef0d180289690",
  );
  assert.equal(first.side, "buy");
  assert.equal(first.txTo, first.txTo?.toLowerCase());
  assert.equal(c.query.swaps.length, 1);
  assert.deepEqual(
    [c.query.swaps[0].selection, c.query.transfers[0].selection],
    ["pool_ids", "tokens"],
  );
  assert.equal(listRecord(c.query.swaps[0]).count, 4);
  assert.equal(listRecord(c.query.transfers[0]).count, 4);
  assert.equal(c.pages.headers.length, 2);
  assert.match(c.parentHash, /^0x[0-9a-f]{64}$/);
  assert.match(c.blockHash, /^0x[0-9a-f]{64}$/);
  // The same range selecting every manager swap, the recorded unfiltered
  // answer, keeps the same five rows and drops the other 68 locally.
  const managerRequests: HyperSyncQuery[] = [];
  const m = await collectLedgerRange(
    new HyperSyncClient({
      token: apiToken,
      minIntervalMs: 0,
      fetch: recordedFetch(
        {
          transfers: fixture("transfers-token-filter.response"),
          all: fixture("swaps-unfiltered.response"),
        },
        64149078,
        managerRequests,
      ),
    }),
    silentRpc(),
    {
      fromBlock: from,
      toBlock: to,
      parentHash: null,
      height: 64149078,
      registry,
    },
  );
  assert.equal(m.swapSelection, "manager");
  assert.deepEqual(m.swaps, c.swaps);
  assert.deepEqual(m.transfers, c.transfers);
  assert.equal(m.unregisteredSwaps, 73 - 5);
  assert.equal(c.unregisteredSwaps, 0);
  assert.deepEqual(managerRequests[1], fixture("swaps-unfiltered.request"));
  assert.equal(m.requests, 5);
  assert.ok(m.sentBytes > 0 && m.sentBytes < c.sentBytes);
});

test("the recorded tip page yields one verified launch with name, symbol and decimals through one Multicall3 aggregate", async () => {
  const from = 64413742,
    to = 64413766,
    height = 64416556;
  const requests: HyperSyncQuery[] = [];
  const client = new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    fetch: recordedFetch(
      { tip: fixture("recent-tip.response") },
      height,
      requests,
    ),
  });
  const launchLog = (
    fixture("recent-tip.response") as {
      data: { logs: Record<string, string>[] }[];
    }
  ).data[0].logs.find((l) => l.topic0 === toEventSelector(launchEvent))!;
  const token = `0x${launchLog.topic2.slice(26)}`;
  const { rpc, calls } = metadataRpc({ [token]: ["Tip Token", "TIP", 18] });
  const c = await collectLedgerRange(client, rpc, {
    fromBlock: from,
    toBlock: to,
    parentHash: null,
    height,
    registry: [],
  });
  assert.equal(c.launch.pools.length, 1);
  const pool = c.launch.pools[0];
  assert.equal(pool.launchBlock, 64413754);
  assert.equal(pool.token, token);
  assert.deepEqual(
    [
      pool.name,
      pool.symbol,
      pool.decimals,
      pool.totalSupplyRaw,
      pool.supplyBlock,
    ],
    ["Tip Token", "TIP", 18, (10n ** 27n).toString(), 64798181],
  );
  assert.equal(c.launch.evidence.schemaVersion, 2);
  // The flag is the pinned registry's for the strategy that emitted the
  // launch log, resolved from the log the lane already verified.
  assert.equal(
    pool.creatorFees,
    getInstantDeployment(launchLog.address)!.creatorFees,
  );
  assert.equal(typeof pool.creatorFees, "boolean");
  assert.ok(pool.description !== undefined || pool.imageUrl !== undefined);
  assert.equal(pool.launchTx, launchLog.transaction_hash);
  assert.equal(pool.launchLogIndex, Number(launchLog.log_index));
  assert.deepEqual(calls, { eth_chainId: 1, eth_blockNumber: 1, eth_call: 1 });
  // The launched pool led the swap filter: its own swaps in the page are kept.
  assert.ok(c.swaps.every((s) => s.poolId === pool.id));
  assert.ok(c.swaps.length >= 1);
  assert.equal(c.registryPools, 1);
  assert.equal(c.launch.evidence.calls.length, 1);
  assert.equal(c.launch.evidence.launcherLogs.length, 3);
  assert.equal(c.launch.evidence.tokenMetadataLogs.length, 1);
  assert.doesNotThrow(() => verifyLedgerLaunchBatch(c.launch));
  const tampered = structuredClone(c.launch);
  tampered.pools[0].symbol = "NOPE";
  assert.throws(
    () => verifyLedgerLaunchBatch(tampered),
    /HyperSync ledger rows disagree with retained evidence/,
  );
  const inflated = structuredClone(c.launch);
  inflated.pools[0].totalSupplyRaw = (10n ** 28n).toString();
  assert.throws(
    () => verifyLedgerLaunchBatch(inflated),
    /HyperSync ledger rows disagree with retained evidence/,
  );
  const flipped = structuredClone(c.launch);
  flipped.pools[0].creatorFees = !pool.creatorFees;
  assert.throws(
    () => verifyLedgerLaunchBatch(flipped),
    /HyperSync ledger rows disagree with retained evidence/,
  );
  // A batch collected before supply joined the reads still verifies as the
  // schema it was written with: three reads per launch and no supply.
  const v1 = structuredClone(c.launch);
  v1.evidence.schemaVersion = 1;
  assert.throws(
    () => verifyLedgerLaunchBatch(v1),
    /HyperSync ledger evidence retains unrelated rows/,
  );
  const [aggregate] = c.launch.evidence.calls;
  assert.equal(aggregate.kind, "multicall3");
  if (aggregate.kind === "multicall3") {
    const decoded = decodeAggregateRequest(aggregateRequestData(aggregate));
    const reply = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      data: aggregate.result,
    });
    const legacy = structuredClone(v1);
    legacy.evidence.calls = [
      {
        ...aggregate,
        calls: decoded.slice(0, 3).map((m) => ({
          target: m.target,
          callData: m.callData,
        })),
        result: encodeAggregateReply(reply.slice(0, 3)),
      },
    ];
    const { totalSupplyRaw: _s, supplyBlock: _b, ...rest } = legacy.pools[0];
    legacy.pools = [rest];
    assert.doesNotThrow(() => verifyLedgerLaunchBatch(legacy));
  }
  const withoutProof = structuredClone(c.launch);
  withoutProof.evidence.launcherLogs = [];
  assert.throws(
    () => verifyLedgerLaunchBatch(withoutProof),
    /Unverified catalog launch/,
  );
  const shallow = structuredClone(c.launch);
  shallow.evidence.archiveHeight = to + 100;
  assert.throws(
    () => verifyLedgerLaunchBatch(shallow),
    /Invalid HyperSync ledger evidence/,
  );
});

const W = addr(0x3333),
  V = addr(0x4444),
  S = addr(0x5555),
  TA = addr(0x1111),
  TB = addr(0x2222);
function fakeChain(height: number, options: { maxLogsPerPage?: number } = {}) {
  const a = fakeLaunch({
    block: start,
    token: TA,
    sender: S,
    transactionHash: word(0xa1),
    metadata: {
      description: "Token A",
      website: "https://a.example",
      image: "https://a.example/a.png",
    },
  });
  // B launches from the fees-off strategy of the same generation (same fee
  // and tick spacing, so the same pool key shape): the flag is the emitting
  // deployment's, not the pool's.
  const b = fakeLaunch({
    block: start + 150,
    token: TB,
    sender: S,
    transactionHash: word(0xb1),
    deployment: instantDeployments[1],
  });
  const logs = [
    ...a.logs,
    ...b.logs,
    // t1: W buys 200 A for 10 wei.
    fakeSwap({
      block: start + 5,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [-10n, 200n],
      transactionHash: word(0xc1),
    }),
    fakeTransfer({
      block: start + 5,
      logIndex: 1,
      token: TA,
      from: contracts.manager,
      to: W,
      value: 200n,
      transactionHash: word(0xc1),
      sender: W,
    }),
    // t2: W sells 100 A for 8 wei.
    fakeSwap({
      block: start + 120,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [8n, -100n],
      transactionHash: word(0xc2),
    }),
    fakeTransfer({
      block: start + 120,
      logIndex: 1,
      token: TA,
      from: W,
      to: contracts.manager,
      value: 100n,
      transactionHash: word(0xc2),
    }),
    // t3: W sends V 50 A outside a swap.
    fakeTransfer({
      block: start + 130,
      logIndex: 0,
      token: TA,
      from: W,
      to: V,
      value: 50n,
      transactionHash: word(0xc3),
    }),
    // t4: V buys 40 B for 4 wei.
    fakeSwap({
      block: start + 160,
      logIndex: 0,
      poolId: b.poolId,
      from: V,
      amounts: [-4n, 40n],
      transactionHash: word(0xc4),
    }),
    fakeTransfer({
      block: start + 160,
      logIndex: 1,
      token: TB,
      from: contracts.manager,
      to: V,
      value: 40n,
      transactionHash: word(0xc4),
      sender: V,
    }),
    // t5: amounts of one sign: not a trade, skipped.
    fakeSwap({
      block: start + 170,
      logIndex: 0,
      poolId: a.poolId,
      from: W,
      amounts: [5n, 5n],
      transactionHash: word(0xc5),
    }),
  ];
  return {
    fake: new FakeHyperSync({ height, logs, ...options }),
    poolA: a.poolId,
    poolB: b.poolId,
  };
}

test("a fake range is collected lane by lane: the range's own launches lead the swap filter and unsupported swaps are counted", async () => {
  const height = start + 299 + 128;
  const { fake, poolA, poolB } = fakeChain(height);
  const client = fakeClient(fake);
  const { rpc, calls } = metadataRpc({
    [TA]: ["Alpha", "A", 18],
    [TB]: ["Beta", "B", 6, 123456789n],
  });
  const c = await collectLedgerRange(client, rpc, {
    fromBlock: start,
    toBlock: start + 199,
    parentHash: null,
    height,
    registry: [],
  });
  assert.equal(c.toBlock, start + 199);
  assert.deepEqual(
    c.launch.pools.map((p) => [
      p.id,
      p.name,
      p.symbol,
      p.decimals,
      p.totalSupplyRaw,
      p.supplyBlock,
      p.creatorFees,
    ]),
    [
      [poolA, "Alpha", "A", 18, (10n ** 27n).toString(), 64798181, true],
      [poolB, "Beta", "B", 6, "123456789", 64798181, false],
    ],
  );
  assert.deepEqual(
    [instantDeployments[0].creatorFees, instantDeployments[1].creatorFees],
    [true, false],
  );
  assert.equal(c.launch.pools[0].description, "Token A");
  assert.deepEqual(calls, { eth_chainId: 1, eth_blockNumber: 1, eth_call: 1 });
  assert.deepEqual(
    c.swaps.map((s) => [
      s.block,
      s.poolId === poolA ? "A" : "B",
      s.side,
      s.ethWei,
      s.tokenRaw,
      s.initiator,
    ]),
    [
      [start + 5, "A", "buy", "10", "200", W],
      [start + 120, "A", "sell", "8", "100", W],
      [start + 160, "B", "buy", "4", "40", V],
    ],
  );
  assert.equal(c.unsupportedSwaps, 1);
  assert.deepEqual(
    c.transfers.map((t) => [t.block, t.from, t.to, t.value]),
    [
      [start + 5, contracts.manager, W, "200"],
      [start + 120, W, contracts.manager, "100"],
      [start + 130, W, V, "50"],
      [start + 160, contracts.manager, V, "40"],
    ],
  );
  assert.equal(c.registryPools, 2);
  assert.equal(c.parentHash, fake.hashOf(start - 1));
  assert.equal(c.blockHash, fake.hashOf(start + 199));
  assert.equal(c.toTimestamp, (start + 199) * 2);
  // launch, one swap chunk, one transfer chunk, the cutoff and from headers.
  assert.equal(c.requests, 5);
  // A later range sees the registry from the caller and finds nothing new.
  const later = await collectLedgerRange(client, silentRpc(), {
    fromBlock: start + 200,
    toBlock: start + 299,
    parentHash: fake.hashOf(start + 199),
    height,
    registry: [
      { poolId: poolA, token: TA, launchBlock: start },
      { poolId: poolB, token: TB, launchBlock: start + 150 },
    ],
  });
  assert.deepEqual(
    [later.swaps.length, later.transfers.length, later.launch.pools.length],
    [0, 0, 0],
  );
  assert.equal(later.requests, 4);
  await assert.rejects(
    collectLedgerRange(client, silentRpc(), {
      fromBlock: start + 200,
      toBlock: start + 299,
      parentHash: null,
      height,
      registry: [{ poolId: poolA, token: TA, launchBlock: start + 250 }],
    }),
    /Invalid HyperSync ledger registry/,
  );
  await assert.rejects(
    collectLedgerRange(client, silentRpc(), {
      fromBlock: start + 200,
      toBlock: height - 127,
      parentHash: null,
      height,
      registry: [],
    }),
    /HyperSync range exceeds the confirmed cutoff/,
  );
});

test("both swap selections give the same rows: the manager-wide one sends no pool id and drops unregistered pools' swaps locally", async () => {
  const height = start + 3000 + 128;
  const { fake, poolA, poolB } = fakeChain(height);
  const other = word(0xdead);
  // Swaps of a pool outside the registry: one in the same transaction as a
  // registered swap (a route through both), one alone, one on the range's
  // last block and one past it.
  fake.logs.push(
    fakeSwap({
      block: start + 5,
      logIndex: 7,
      poolId: other,
      from: W,
      transactionHash: word(0xc1),
    }),
    fakeSwap({ block: start + 50, logIndex: 0, poolId: other, from: V }),
    fakeSwap({ block: start + 199, logIndex: 0, poolId: other, from: V }),
    fakeSwap({ block: start + 250, logIndex: 0, poolId: other, from: V }),
  );
  const tokens = {
    [TA]: ["Alpha", "A", 18],
    [TB]: ["Beta", "B", 6],
  } as Record<string, [string, string, number]>;
  const collect = async (
    swapSelection?: "manager" | "pool_ids",
    range: { fromBlock: number; toBlock: number } = {
      fromBlock: start,
      toBlock: start + 199,
    },
  ) => {
    const before = fake.requests.length;
    const c = await collectLedgerRange(
      fakeClient(fake),
      metadataRpc(tokens).rpc,
      {
        ...range,
        parentHash: null,
        height,
        registry:
          range.fromBlock > start
            ? [
                { poolId: poolA, token: TA, launchBlock: start },
                { poolId: poolB, token: TB, launchBlock: start + 150 },
              ]
            : [],
        swapSelection,
      },
    );
    return { c, requests: fake.requests.slice(before) };
  };
  const manager = await collect();
  const lists = await collect("pool_ids");
  assert.equal(manager.c.swapSelection, "manager");
  const rows = ({ c }: typeof manager) => ({
    toBlock: c.toBlock,
    blockHash: c.blockHash,
    launches: c.launch.pools,
    swaps: c.swaps,
    unsupportedSwaps: c.unsupportedSwaps,
    transfers: c.transfers,
    registryPools: c.registryPools,
  });
  assert.deepEqual(rows(manager), rows(lists));
  assert.equal(manager.c.swaps.length, 3);
  assert.deepEqual(
    [manager.c.unregisteredSwaps, lists.c.unregisteredSwaps],
    [3, 0],
  );
  // The range's own launches still lead: pool B's swap follows its launch.
  assert.ok(manager.c.swaps.some((s) => s.poolId === poolB));
  const swapBodies = ({ requests }: typeof manager) =>
    requests
      .map((r) => r.body)
      .filter((b) => b?.logs?.[0].address?.[0] === contracts.manager);
  const [managerBody] = swapBodies(manager);
  assert.equal(swapBodies(manager).length, 1);
  assert.deepEqual(managerBody!.logs, [
    { address: [contracts.manager], topics: [[toEventSelector(swapEvent)]] },
  ]);
  assert.ok(!JSON.stringify(managerBody).includes(poolA.slice(2)));
  assert.deepEqual(
    swapBodies(lists)[0]!.logs![0].topics![1],
    [poolA, poolB].sort(),
  );
  assert.equal(manager.c.requests, lists.c.requests);
  const [record] = manager.c.query.swaps;
  assert.deepEqual(record, {
    from_block: start,
    to_block: start + 200,
    selection: "manager",
    registry: {
      count: 2,
      sha256: listRecord(ledgerQueryRecord(swapBodies(lists)[0]!)).sha256,
    },
    unregistered: 3,
  });
  assert.equal(lists.c.query.swaps[0].selection, "pool_ids");
  assert.throws(
    () => ledgerQueryRecord(managerBody!),
    /Invalid HyperSync ledger query/,
  );
  assert.throws(
    () => ledgerManagerQueryRecord(swapBodies(lists)[0]!, [poolA], 0),
    /Invalid HyperSync ledger query/,
  );
  // The length picks the selection: managerSwapBlocks blocks select every
  // manager swap, one block more sends the lists.
  const edge = ledgerPassPolicy.managerSwapBlocks;
  const short = await collect(undefined, {
    fromBlock: start + 200,
    toBlock: start + 199 + edge,
  });
  const long = await collect(undefined, {
    fromBlock: start + 200,
    toBlock: start + 200 + edge,
  });
  assert.deepEqual(
    [short.c.swapSelection, long.c.swapSelection],
    ["manager", "pool_ids"],
  );
  // The swap past the first range is a later range's to drop.
  assert.equal(short.c.unregisteredSwaps, 1);
  await assert.rejects(
    collect("manager-wide" as "manager"),
    /Invalid HyperSync ledger range/,
  );
  // A pool-id answer naming a pool outside the lists is still refused.
  const loose: FakeHyperSync = new FakeHyperSync({
    height,
    logs: fake.logs,
    intercept: (request) => {
      const selection = request.body?.logs?.[0];
      if (!selection?.topics?.[1]) return undefined;
      return Response.json(
        loose.respond({
          ...request.body!,
          logs: [{ ...selection, topics: [selection.topics[0]] }],
        }),
      );
    },
  });
  await assert.rejects(
    collectLedgerRange(fakeClient(loose), metadataRpc(tokens).rpc, {
      fromBlock: start,
      toBlock: start + 199,
      parentHash: null,
      height,
      registry: [],
      swapSelection: "pool_ids",
    }),
    /HyperSync swap outside the registry/,
  );
});

test("lanes end the range on the shortest whole page and later queries are asked only up to it", async () => {
  const height = start + 299 + 128;
  const a = fakeLaunch({
    block: start,
    token: TA,
    sender: S,
    transactionHash: word(0xa1),
    metadata: { description: "A", website: "", image: "" },
  });
  const logs = [
    ...a.logs,
    ...[1, 2, 3, 4, 5].map((i) =>
      fakeSwap({ block: start + i, logIndex: 0, poolId: a.poolId, from: W }),
    ),
    fakeTransfer({
      block: start + 2,
      logIndex: 1,
      token: TA,
      from: contracts.manager,
      to: W,
      value: 1n,
    }),
    fakeTransfer({
      block: start + 5,
      logIndex: 1,
      token: TA,
      from: contracts.manager,
      to: W,
      value: 1n,
    }),
  ];
  const fake = new FakeHyperSync({ height, logs, maxLogsPerPage: 4 });
  const client = fakeClient(fake);
  const { rpc } = metadataRpc();
  const c = await collectLedgerRange(client, rpc, {
    fromBlock: start,
    toBlock: start + 99,
    parentHash: null,
    height,
    registry: [],
    maxPages: 1,
  });
  // The swap lane's one page held blocks start+1..start+4; the transfer lane
  // was asked only up to there and the range ends there.
  assert.equal(c.toBlock, start + 4);
  assert.equal(c.swaps.length, 4);
  assert.equal(c.transfers.length, 1);
  const bodies = fake.requests
    .filter((r) => r.body?.logs?.length)
    .map((r) => r.body!.to_block);
  assert.deepEqual(bodies, [start + 100, start + 100, start + 5]);
  assert.equal(c.blockHash, fake.hashOf(start + 4));
  // Every retained block must chain: a fork inside the range fails closed.
  const forked = new FakeHyperSync({ height, logs, maxLogsPerPage: 4 });
  let served = 0;
  const forkedClient = new HyperSyncClient({
    token: apiToken,
    minIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body
        ? (JSON.parse(String(init.body)) as HyperSyncQuery)
        : undefined;
      // The swap page has been served with the old hashes; the transfer
      // page and the cutoff header then answer from the forked chain.
      if (url.pathname === "/query" && body?.logs?.length && ++served === 3)
        forked.reorgFrom = start + 3;
      return forked.fetch(input, init);
    },
  });
  await assert.rejects(
    collectLedgerRange(forkedClient, metadataRpc().rpc, {
      fromBlock: start,
      toBlock: start + 99,
      parentHash: null,
      height,
      registry: [],
      maxPages: 1,
    }),
    /conflicting|Inconsistent HyperSync canonical headers/,
  );
});

test("a launch burst ends the range before the launch that would exceed the cap", async () => {
  const height = start + 299 + 128;
  const { fake, poolA } = fakeChain(height);
  const client = fakeClient(fake);
  const { rpc } = metadataRpc({ [TA]: ["Alpha", "A", 18] });
  const c = await collectLedgerRange(client, rpc, {
    fromBlock: start,
    toBlock: start + 199,
    parentHash: null,
    height,
    registry: [],
    maxLaunches: 1,
  });
  assert.equal(c.toBlock, start + 149);
  assert.deepEqual(
    c.launch.pools.map((p) => p.id),
    [poolA],
  );
  assert.equal(c.swaps.length, 2);
  assert.equal(c.transfers.length, 3);
  assert.equal(c.blockHash, fake.hashOf(start + 149));
  await assert.rejects(
    collectLedgerRange(client, rpc, {
      fromBlock: start + 150,
      toBlock: start + 199,
      parentHash: null,
      height,
      registry: [{ poolId: poolA, token: TA, launchBlock: start }],
      maxLaunches: 1,
    }).then(() => {
      throw Error("expected a single launch to fit");
    }),
    /expected a single launch to fit/,
  );
});

test("swap and transfer selections reproduce the recorded single-selection bodies", () => {
  const range = { fromBlock: 62688988, toBlock: 62689007 };
  const ids = (fixture("swaps-pool-filter.request") as HyperSyncQuery).logs![0]
    .topics![1];
  assert.deepEqual(
    swapLogQuery(range, ids, ledgerPassPolicy.poolIdsPerQuery),
    fixture("swaps-pool-filter.request"),
  );
  const transfers = testTransferQueries(range, [
    "0xb480aa907f5ca5364daa47508f06d248411f28be",
    "0x433025fe9550ed919d8b28b53a3f5419be678d0d",
  ]);
  assert.deepEqual(transfers[0], fixture("transfers-token-filter.request"));
  assert.equal(
    transfers[0].logs![0].topics![0][0],
    toEventSelector(transferEvent),
  );
});
