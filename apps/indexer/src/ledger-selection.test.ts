import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
} from "viem";
import {
  HyperSyncClient,
  Rpc,
  collectLedgerRange,
  contracts,
  decodeAggregateRequest,
  encodeAggregateReply,
  ledgerPassPolicy,
  type HyperSyncQuery,
  type LedgerRangeCollection,
  type LedgerSwapSelection,
  type LedgerTransferSelection,
} from "@pools/chain";
import { ledgerContentHash } from "@pools/db";
import { ledgerBatchOf } from "./ledger-pass";

/** A HyperSync response as recorded: `data` chunks and the envelope. */
interface Page {
  data: Record<string, unknown[]>[];
  archive_height: number;
  next_block: number;
  total_execution_time: number;
  rollback_guard: unknown;
}
/** Both swap selections' answers for one real range, recorded on 17 Sep 2026
 * from https://4663.hypersync.xyz by `pnpm ledger:pass compare` (see
 * fixtures/hypersync/README.md): the launch query, the three pool-id queries
 * the 62,000-pool registry split into, the one manager-wide query, the two
 * transfer queries and the boundary headers, each the unedited answer to the
 * exact body the collector builds for the range. `pools` holds the registered
 * pools those answers name; the full registry is only digested. */
interface Fixture {
  fromBlock: number;
  toBlock: number;
  height: number;
  registry: { before: number; through: number; poolIdsSha256: string };
  pools: [string, string, number][];
  expected: {
    contentHash: string;
    launches: number;
    swaps: number;
    unsupportedSwaps: number;
    transfers: number;
    managerLogs: number;
    unregisteredSwaps: number;
  };
  responses: {
    launch: Page[];
    poolIds: Page[][];
    manager: Page[];
    transfers: Page[][];
    headers: Record<string, Page>;
  };
}
const fixture = (range: string): Fixture =>
  JSON.parse(
    brotliDecompressSync(
      readFileSync(
        new URL(
          `../../../packages/chain/src/fixtures/hypersync/ledger-swap-selection-${range}.json.br`,
          import.meta.url,
        ),
      ),
    ).toString(),
  );

/** Every Transfer log (ERC-20 and ERC-721 share the topic) of the 811-block
 * tip range 65,402,717-65,403,527 as Blockscout's copy of the chain answered
 * `getLogs` for the Transfer topic on 25 Sep 2026, each kept as the two
 * fields the transfer probe selects, its block and emitting contract (see
 * fixtures/hypersync/README.md): what HyperSync's probe answer holds, taken
 * from another indexer of the same chain, not a HyperSync recording. */
interface ProbeRows {
  fromBlock: number;
  toBlock: number;
  transfers: number;
  addresses: string[];
  rows: [number, number][];
}
const probeRows = (range: string): ProbeRows =>
  JSON.parse(
    brotliDecompressSync(
      readFileSync(
        new URL(
          `../../../packages/chain/src/fixtures/hypersync/ledger-transfer-probe-${range}.json.br`,
          import.meta.url,
        ),
      ),
    ).toString(),
  );
/** The probe's answer for the range in one page, as the tip's partitions
 * answered the range's manager-wide query. */
const probeAnswer = (f: Fixture, probe: ProbeRows): Page[] => [
  {
    data: [
      {
        logs: probe.rows.map(([block, address]) => ({
          block_number: block,
          address: probe.addresses[address],
        })),
      },
    ],
    archive_height: Math.min(
      ...f.responses.transfers.flat().map((p) => p.archive_height),
    ),
    next_block: f.toBlock + 1,
    total_execution_time: 1,
    rollback_guard: null,
  },
];
/** The pages of one recorded query keyed by the block each was asked from. */
function byFrom(fromBlock: number, pages: Page[]) {
  const map = new Map<number, Page>();
  let from = fromBlock;
  for (const page of pages) {
    map.set(from, page);
    from = page.next_block;
  }
  return map;
}
/** Serve each query its recorded answer. The replay registry is the named
 * pools only, so the collector sends one pool-id query and one transfer query
 * where the full registry sent three and two: each is answered with the
 * recorded answers of all of its chunks at that block as one page, which is
 * how the server answers one query with several selections. Nothing is
 * filtered here; what a selection keeps is the collector's own work. */
function replay(
  f: Fixture,
  sent: HyperSyncQuery[],
  probePages: Page[] = [],
): typeof globalThis.fetch {
  const union = (lists: Map<number, Page>[], from: number): Page => {
    const pages = lists.map((l) => l.get(from));
    if (pages.some((p) => !p || p.next_block !== pages[0]!.next_block))
      throw Error(`no recorded answer from ${from}`);
    return {
      data: pages.flatMap((p) => p!.data),
      archive_height: Math.min(...pages.map((p) => p!.archive_height)),
      next_block: pages[0]!.next_block,
      total_execution_time: 1,
      rollback_guard: null,
    };
  };
  const launch = byFrom(f.fromBlock, f.responses.launch);
  const manager = byFrom(f.fromBlock, f.responses.manager);
  const poolIds = f.responses.poolIds.map((p) => byFrom(f.fromBlock, p));
  const transfers = f.responses.transfers.map((p) => byFrom(f.fromBlock, p));
  const probe = byFrom(f.fromBlock, probePages);
  return async (input, init) => {
    if (new URL(String(input)).pathname === "/height")
      return Response.json({ height: f.height });
    const q = JSON.parse(String(init!.body)) as HyperSyncQuery;
    sent.push(q);
    assert.ok(q.to_block === f.toBlock + 1 || q.include_all_blocks);
    const selection = q.logs?.[0];
    const page = q.include_all_blocks
      ? f.responses.headers[q.from_block]
      : q.logs!.length === 2
        ? launch.get(q.from_block)
        : selection!.topics![1]
          ? union(poolIds, q.from_block)
          : !selection!.address
            ? probe.get(q.from_block)
            : selection!.address[0] === contracts.manager
              ? manager.get(q.from_block)
              : union(transfers, q.from_block);
    if (!page) throw Error(`no recorded answer from ${q.from_block}`);
    return Response.json(page);
  };
}
/** Name, symbol, decimals and supply for any token through Multicall3. */
function metadataRpc() {
  const rpc = new Rpc();
  rpc.call = async <T>(method: string) => {
    if (method === "eth_chainId") return "0x1237" as T;
    if (method === "eth_blockNumber") return "0x3e8d2a0" as T;
    throw Error(`Unexpected JSON-RPC ${method}`);
  };
  rpc.logs = async () => {
    throw Error("Unexpected JSON-RPC eth_getLogs");
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method !== "eth_call") throw Error(`Unexpected JSON-RPC ${method}`);
    return params.map((p) =>
      encodeAggregateReply(
        decodeAggregateRequest((p[0] as { data: Hex }).data).map((member) => {
          const fn = decodeFunctionData({
            abi: erc20Abi,
            data: member.callData,
          }).functionName as "name" | "symbol" | "decimals" | "totalSupply";
          const result = { name: "Token", symbol: "TKN", decimals: 18 }[
            fn as "name"
          ];
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result: fn === "totalSupply" ? 10n ** 27n : result,
            } as Parameters<typeof encodeFunctionResult>[0]),
          };
        }),
      ),
    ) as T[];
  };
  return rpc;
}
async function collect(
  f: Fixture,
  swapSelection: LedgerSwapSelection,
  transferSelection: LedgerTransferSelection | undefined,
  probePages: Page[] = [],
) {
  const sent: HyperSyncQuery[] = [];
  const client = new HyperSyncClient({
    token: "x".repeat(16),
    minIntervalMs: 0,
    fetch: replay(f, sent, probePages),
  });
  const c = await collectLedgerRange(client, metadataRpc(), {
    fromBlock: f.fromBlock,
    toBlock: f.toBlock,
    parentHash: null,
    height: f.height,
    registry: f.pools.map(([poolId, token, launchBlock]) => ({
      poolId,
      token,
      launchBlock,
    })),
    swapSelection,
    transferSelection,
  });
  return { c, sent };
}
/** What the fold receives from a range. */
const consumed = (c: LedgerRangeCollection) => ({
  fromBlock: c.fromBlock,
  toBlock: c.toBlock,
  parentHash: c.parentHash,
  blockHash: c.blockHash,
  toTimestamp: c.toTimestamp,
  launches: c.launch.pools,
  swaps: c.swaps,
  unsupportedSwaps: c.unsupportedSwaps,
  transfers: c.transfers,
});

for (const [range, shape] of [
  ["65402717-65403527", "a tip range of 811 blocks with a launch"],
  [
    "64340780-64342779",
    "a busy 2,000-block range of 16 Sep with two launches and two manager-wide pages",
  ],
] as const)
  test(`recorded answers to both swap selections over ${shape} give the fold the same rows`, async () => {
    const f = fixture(range);
    // The transfer lane sends its lists in both: this compares the swaps.
    const lists = await collect(f, "pool_ids", "tokens");
    const manager = await collect(f, "manager", "tokens");
    assert.deepEqual(consumed(manager.c), consumed(lists.c));
    // The recorded range's content hash, as the live comparison computed it.
    for (const { c } of [lists, manager])
      assert.equal(ledgerContentHash(ledgerBatchOf(c)), f.expected.contentHash);
    assert.deepEqual(
      [
        lists.c.launch.pools.length,
        lists.c.swaps.length,
        lists.c.unsupportedSwaps,
        lists.c.transfers.length,
        lists.c.toBlock,
      ],
      [
        f.expected.launches,
        f.expected.swaps,
        f.expected.unsupportedSwaps,
        f.expected.transfers,
        f.toBlock,
      ],
    );
    // The manager-wide answer held every pool's swaps; the registry kept its own.
    const managerLogs = f.responses.manager.reduce(
      (n, p) => n + p.data.reduce((m, c) => m + (c.logs?.length ?? 0), 0),
      0,
    );
    assert.equal(managerLogs, f.expected.managerLogs);
    assert.equal(manager.c.unregisteredSwaps, f.expected.unregisteredSwaps);
    assert.equal(
      manager.c.swaps.length + manager.c.unregisteredSwaps,
      managerLogs,
    );
    assert.equal(lists.c.unregisteredSwaps, 0);
    assert.deepEqual(
      [lists.c.swapSelection, manager.c.swapSelection],
      ["pool_ids", "manager"],
    );
    // The manager-wide query named no pool; its record digests the registry.
    const swapQueries = (sent: HyperSyncQuery[]) =>
      sent.filter((q) =>
        q.logs?.some((s) => s.address?.[0] === contracts.manager),
      );
    assert.equal(swapQueries(manager.sent).length, f.responses.manager.length);
    for (const q of swapQueries(manager.sent)) {
      assert.deepEqual(q.logs![0].topics!.length, 1);
      assert.ok(Buffer.byteLength(JSON.stringify(q)) < 1024);
    }
    const [record] = manager.c.query.swaps;
    assert.deepEqual(
      record.selection === "manager" && {
        ...record,
        registry: { ...record.registry, sha256: record.registry.sha256.length },
      },
      {
        from_block: f.fromBlock,
        to_block: f.toBlock + 1,
        selection: "manager",
        registry: { count: f.pools.length + f.expected.launches, sha256: 66 },
        unregistered: f.expected.unregisteredSwaps,
      },
    );
    assert.equal(manager.c.query.swaps.length, 1);
    assert.equal(lists.c.query.swaps[0].selection, "pool_ids");
    // The answers are the full registry's three pool-id queries; the named
    // pools fit one query, which the replay answers with all three.
    assert.deepEqual(
      [f.responses.poolIds.length, f.responses.transfers.length],
      [3, 2],
    );
    assert.ok(f.registry.before > 2 * ledgerPassPolicy.poolIdsPerQuery);
    assert.equal(
      swapQueries(lists.sent).length,
      Math.ceil(
        (f.pools.length + f.expected.launches) /
          ledgerPassPolicy.poolIdsPerQuery,
      ),
    );
  });

test("a chain-wide Transfer probe over the recorded tip range lists only the tokens that moved and gives the fold the rows the full lists gave", async () => {
  const range = "65402717-65403527";
  const f = fixture(range);
  const probe = probeRows(range);
  assert.deepEqual(
    [probe.fromBlock, probe.toBlock, probe.rows.length],
    [f.fromBlock, f.toBlock, probe.transfers],
  );
  // Blockscout's rows name the same registered Transfers the recorded token
  // lists returned, block for block.
  const recorded = f.responses.transfers
    .flat()
    .flatMap((p) => p.data.flatMap((c) => c.logs ?? [])) as {
    block_number: number;
    address: string;
  }[];
  const registered = new Set(recorded.map((l) => l.address));
  const named = probe.rows.filter(([, a]) =>
    registered.has(probe.addresses[a]),
  );
  assert.deepEqual(
    named.map(([block]) => block),
    recorded.map((l) => l.block_number).sort((a, b) => a - b),
  );
  const pages = probeAnswer(f, probe);
  const lists = await collect(f, "pool_ids", "tokens");
  const local = await collect(f, "manager", "chain", pages);
  // The tip loop's own choice for the range, unset, is the probe.
  const unset = await collect(f, "manager", undefined, pages);
  for (const run of [local, unset]) {
    assert.deepEqual(consumed(run.c), consumed(lists.c));
    assert.equal(
      ledgerContentHash(ledgerBatchOf(run.c)),
      f.expected.contentHash,
    );
    assert.deepEqual(
      [
        run.c.transferSelection,
        run.c.unregisteredTransfers,
        run.c.transferFallbackRequests,
        run.c.transfers.length,
      ],
      [
        "chain",
        probe.transfers - f.expected.transfers,
        0,
        f.expected.transfers,
      ],
    );
  }
  assert.equal(
    ledgerContentHash(ledgerBatchOf(lists.c)),
    f.expected.contentHash,
  );
  // The lists sent the whole registry in two queries; the probe sends no
  // address and the list after it names only the tokens that moved.
  const bytes = (q: HyperSyncQuery) => Buffer.byteLength(JSON.stringify(q));
  const transferQueries = (sent: HyperSyncQuery[]) =>
    sent.filter((q) =>
      q.logs?.every(
        (s) =>
          s.topics?.[0]?.[0] ===
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      ),
    );
  const [probeQuery, listQuery, ...rest] = transferQueries(local.sent);
  assert.deepEqual(rest, []);
  assert.deepEqual(probeQuery.field_selection, {
    log: ["block_number", "address"],
  });
  assert.ok(bytes(probeQuery) < 1024);
  assert.deepEqual(listQuery.logs![0].address, [...registered].sort());
  assert.ok(bytes(listQuery) < 2048);
  assert.equal(transferQueries(lists.sent).length, 1);
  assert.deepEqual(
    local.c.pages.transfers.map((p) => p.length),
    [1, 1],
  );
  const [record, list] = local.c.query.transfers;
  assert.deepEqual(
    record.selection === "chain" && {
      ...record,
      registry: { ...record.registry, sha256: record.registry.sha256.length },
    },
    {
      from_block: f.fromBlock,
      to_block: f.toBlock + 1,
      selection: "chain",
      registry: { count: f.pools.length + f.expected.launches, sha256: 66 },
      unregistered: probe.transfers - f.expected.transfers,
    },
  );
  assert.deepEqual(
    list.selection === "tokens" && [list.count, local.c.query.transfers.length],
    [registered.size, 2],
  );
});
