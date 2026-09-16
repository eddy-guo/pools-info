import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeFunctionData,
  encodeFunctionResult,
  erc20Abi,
  type Hex,
} from "viem";
import { HyperSyncClient, type HyperSyncQuery } from "./hypersync";
import {
  FakeHyperSync,
  fakeLaunch,
  fakeSwap,
  word,
  type FakeHyperSyncLog,
} from "./hypersync-fake";
import {
  collectRecentPages,
  hypersyncRecentStream,
  isHyperSyncRecentEvidence,
  observedRecentPoolIds,
  recentLaunchesFromPages,
  recentLogQuery,
  recentSwapsFromPages,
  verifyHyperSyncRecentLaunches,
  verifyHyperSyncRecentSwaps,
  type HyperSyncRecentLaunchBatch,
  type HyperSyncRecentSwapBatch,
} from "./hypersync-recent";
import { contracts } from "./events";
import { instantDeployments } from "./deployments";
import { decodeAggregateRequest, encodeAggregateReply } from "./multicall";
import { Rpc } from "./rpc";
import type { RecentPoolIdentity } from "./recent-events";

const fixture = (name: string) =>
  readFileSync(
    new URL(`./fixtures/hypersync/${name}.json`, import.meta.url),
    "utf8",
  );
const clone = <T>(v: T): T => structuredClone(v);
const apiToken = "x".repeat(16);

/** A JSON-RPC provider that answers only name() and symbol() through
 * Multicall3 and counts every call it receives. */
function metadataRpc(names: Record<string, [string, string]> = {}) {
  const rpc = new Rpc();
  const calls: Record<string, number> = {};
  const count = (m: string) => (calls[m] = (calls[m] ?? 0) + 1);
  rpc.call = async <T>(method: string) => {
    count(method);
    if (method === "eth_chainId") return "0x1237" as T;
    throw Error(`Unexpected JSON-RPC ${method}`);
  };
  rpc.logs = async () => {
    count("eth_getLogs");
    throw Error("Unexpected JSON-RPC eth_getLogs");
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    for (const _ of params) count(method);
    if (method !== "eth_call") throw Error(`Unexpected JSON-RPC ${method}`);
    return params.map((p) => {
      const { data } = p[0] as { to: Hex; data: Hex };
      return encodeAggregateReply(
        decodeAggregateRequest(data).map((member) => {
          const fn = decodeFunctionData({
            abi: erc20Abi,
            data: member.callData,
          }).functionName as "name" | "symbol";
          const [name, symbol] = names[member.target.toLowerCase()] ?? [
            "Token",
            "TKN",
          ];
          return {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: fn,
              result: fn === "name" ? name : symbol,
            }),
          };
        }),
      );
    }) as T[];
  };
  return { rpc, calls };
}
/** No JSON-RPC call may happen at all. */
function silentRpc() {
  const rpc = new Rpc();
  const refuse = async () => {
    throw Error("Unexpected JSON-RPC call");
  };
  rpc.call = refuse;
  rpc.batch = refuse;
  rpc.logs = refuse;
  return rpc;
}

test("the tip query reproduces the recorded request and selects both lanes, the launcher and every block", () => {
  const recorded = JSON.parse(fixture("recent-tip.request")) as HyperSyncQuery;
  const query = recentLogQuery({ fromBlock: 64413742, toBlock: 64413766 });
  assert.deepEqual(query, recorded);
  assert.equal(query.include_all_blocks, true);
  assert.equal(query.logs?.length, 3);
  assert.throws(
    () => recentLogQuery({ fromBlock: 10, toBlock: 2010 }),
    /Invalid HyperSync recent range/,
  );
  assert.doesNotThrow(() => recentLogQuery({ fromBlock: 10, toBlock: 2009 }));
});

/** Serve the recorded tip page for the recorded body only. */
function recordedClient(height = 64416556) {
  const body = fixture("recent-tip.request");
  const response = fixture("recent-tip.response");
  const requests: HyperSyncQuery[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/height")
      return new Response(JSON.stringify({ height }), { status: 200 });
    const query = JSON.parse(String(init?.body)) as HyperSyncQuery;
    requests.push(query);
    assert.deepEqual(query, JSON.parse(body));
    return new Response(response, { status: 200 });
  };
  return {
    client: new HyperSyncClient({ token: apiToken, minIntervalMs: 0, fetch }),
    requests,
  };
}

test("a recorded tip page becomes a verified launch batch and swap batch with one aggregate read and no receipt or header call", async () => {
  const { client, requests } = recordedClient();
  const pages = await collectRecentPages(client, {
    fromBlock: 64413742,
    toBlock: 64413766,
    height: 64416556,
    maxPages: 1,
  });
  assert.equal(requests.length, 1);
  assert.equal(pages.toBlock, 64413766);
  assert.equal(pages.logs.length, 60);
  assert.equal(pages.blocks.size, 25);

  const { rpc, calls } = metadataRpc({
    "0xe4855c3f815ab308683fa664369bf5973c618979": ["Warp", "WARP"],
  });
  const launches = await recentLaunchesFromPages(pages, rpc);
  // The launch's sender, block and time come from HyperSync; only its name and
  // symbol are read from the JSON-RPC provider, in one Multicall3 aggregate.
  assert.deepEqual(calls, { eth_chainId: 1, eth_call: 1 });
  assert.deepEqual(launches.pools, [
    {
      description: "Warp Strategy",
      imageUrl:
        "ipfs://bafybeicxlcw6vwdnqls6zrhze7ve6kg7fowjqtdmdfrynwpvm2rm24ekgq",
      id: "0xff1c84d3f6dda0c7f9bca1906899384c3189f5043a1fcf5fa925312f2a8390fc",
      token: "0xe4855c3f815ab308683fa664369bf5973c618979",
      name: "Warp",
      symbol: "WARP",
      launchTx:
        "0x4f5af3632b3e906c3bdbdaaaa12ca659d21c08b11266637e98a91c729d670249",
      launchSender: "0x9ae1cc15826253e91368f0e72b68be46c4001dbe",
      launchBlock: 64413754,
      launchedAt: 1789552163,
    },
  ]);
  assert.equal(launches.evidence.source, "hypersync");
  assert.equal(launches.evidence.stream, hypersyncRecentStream);
  assert.equal(launches.evidence.logs.length, 1);
  assert.equal(launches.evidence.tokenMetadataLogs.length, 1);
  assert.ok(launches.evidence.launcherLogs.length >= 1);
  assert.deepEqual(
    launches.evidence.blocks.map((b) => b.number),
    [64413742, 64413754, 64413766],
  );
  assert.equal(
    launches.fromBlockParentHash,
    pages.blocks.get(64413742)!.parent_hash,
  );
  assert.equal(launches.blockHash, pages.blocks.get(64413766)!.hash);
  verifyHyperSyncRecentLaunches(clone(launches));

  const ids = observedRecentPoolIds(pages);
  assert.equal(ids.length, 37);
  const launched = launches.pools[0];
  // The new launch plus two other observed pools are registered.
  const registry: RecentPoolIdentity[] = [
    {
      id: launched.id,
      token: launched.token,
      launchBlock: launched.launchBlock,
    },
    ...ids
      .filter((id) => id !== launched.id)
      .slice(0, 2)
      .map((id, i) => ({
        id,
        token: `0x${String(i + 1).repeat(40)}`,
        launchBlock: 1,
      })),
  ];
  const swaps = recentSwapsFromPages(pages, registry);
  const managerSwaps = pages.logs.filter(
    (l) => l.address === contracts.manager,
  );
  assert.equal(swaps.observedSwaps, managerSwaps.length);
  assert.equal(swaps.observedSwaps, 55);
  const registered = managerSwaps.filter((l) =>
    registry.some((p) => p.id === l.topic1),
  );
  assert.equal(swaps.evidence.logs.length, registered.length);
  assert.equal(swaps.unregisteredSwaps, 55 - registered.length);
  assert.equal(
    swaps.evidence.unregistered.poolIds.length,
    ids.length - registry.filter((p) => ids.includes(p.id)).length,
  );
  assert.ok(swaps.events.length > 0);
  for (const e of swaps.events) {
    const tx = pages.transactions.get(e.txHash)!;
    // The initiator is the transaction's from, never a receipt; never the beneficiary.
    assert.equal(e.transactionSender, tx.from.toLowerCase());
    assert.equal(e.timestamp, Number(pages.blocks.get(e.block)!.timestamp));
    assert.equal(e.blockHash, pages.blocks.get(e.block)!.hash);
    assert.equal(
      BigInt(e.ethWei),
      e.side === "buy" ? -BigInt(e.amount0) : BigInt(e.amount0),
    );
  }
  verifyHyperSyncRecentSwaps(clone(swaps), registry);
  assert.ok(isHyperSyncRecentEvidence(swaps.evidence));
  assert.ok(
    !isHyperSyncRecentEvidence({ logs: [], receipts: [], headers: [] }),
  );
});

// A synthetic chain: one verified launch with its launcher and factory logs,
// registered and unregistered swaps, two legs of one transaction and one swap
// whose signs the accounting does not support.
const token = "0x1111111111111111111111111111111111111111";
const initiator = "0x2222222222222222222222222222222222222222";
const creator = "0x3333333333333333333333333333333333333333";
/** Above the deployment, so the launch passes the real registry checks. */
const base = instantDeployments[0].deployedAtBlock + 1000;
const launchBlock = base + 5;
const launchTx = word(777);
const launch = fakeLaunch({
  block: launchBlock,
  token,
  sender: creator,
  transactionHash: launchTx,
  metadata: {
    description: "A synthetic launch",
    website: "https://example.com/token",
    image: "https://example.com/token.png",
  },
});
const poolId = launch.poolId;
const swap = (
  block: number,
  logIndex: number,
  pool: string,
  amounts?: [bigint, bigint],
  transactionHash?: string,
) =>
  fakeSwap({
    block,
    logIndex,
    poolId: pool,
    from: initiator,
    amounts,
    transactionHash,
  });
const swapData = (amount0: bigint, amount1: bigint) =>
  swap(0, 0, poolId, [amount0, amount1]).data as Hex;
const chainLogs = (): FakeHyperSyncLog[] => [
  ...launch.logs,
  swap(base + 6, 0, poolId),
  swap(base + 6, 1, word(7)),
  swap(base + 8, 0, poolId, [-5n, 50n], word(88)),
  swap(base + 8, 1, poolId, [7n, -70n], word(88)),
  swap(base + 9, 0, poolId, [-1n, -1n]),
];
const syntheticRegistry: RecentPoolIdentity[] = [
  { id: poolId, token, launchBlock },
];
const syntheticClient = (fake: FakeHyperSync) =>
  new HyperSyncClient({ token: apiToken, minIntervalMs: 0, fetch: fake.fetch });

test("a synthetic range: launches and swaps derive exactly, a quiet range reads nothing from JSON-RPC, and dense pages end the batch at a block boundary", async () => {
  const fake = new FakeHyperSync({
    height: base + 10 + 128,
    logs: chainLogs(),
  });
  const pages = await collectRecentPages(syntheticClient(fake), {
    fromBlock: base,
    toBlock: base + 10,
    height: base + 138,
  });
  assert.equal(fake.requests.length, 1);
  assert.equal(pages.blocks.size, 11);
  const { rpc, calls } = metadataRpc({ [token]: ["Synthetic", "SYN"] });
  const launches = await recentLaunchesFromPages(pages, rpc);
  assert.deepEqual(calls, { eth_chainId: 1, eth_call: 1 });
  assert.deepEqual(launches.pools, [
    {
      description: "A synthetic launch",
      imageUrl: "https://example.com/token.png",
      externalUrl: "https://example.com/token",
      id: poolId,
      token,
      name: "Synthetic",
      symbol: "SYN",
      launchTx,
      launchSender: creator,
      launchBlock,
      launchedAt: launchBlock * 2,
    },
  ]);
  const swaps = recentSwapsFromPages(pages, syntheticRegistry);
  assert.deepEqual(
    swaps.events.map((e) => [
      e.txHash,
      e.logIndex,
      e.side,
      e.ethWei,
      e.tokenRaw,
    ]),
    [
      [word((base + 6) * 100), 0, "buy", "10", "200"],
      [word(88), 0, "buy", "5", "50"],
      [word(88), 1, "sell", "7", "70"],
    ],
  );
  assert.equal(swaps.observedSwaps, 5);
  assert.equal(swaps.unregisteredSwaps, 1);
  assert.equal(swaps.unsupportedSwaps, 1);
  assert.deepEqual(swaps.evidence.unregistered, {
    swaps: 1,
    poolIds: [word(7)],
  });
  // Two legs of one transaction share one retained transaction row.
  assert.equal(swaps.evidence.transactions.length, 3);
  assert.deepEqual(
    swaps.events.map((e) => e.transactionSender),
    [initiator, initiator, initiator],
  );

  // A range without a launch never reaches the JSON-RPC provider.
  const quiet = await collectRecentPages(syntheticClient(fake), {
    fromBlock: base + 6,
    toBlock: base + 10,
    height: base + 138,
  });
  const none = await recentLaunchesFromPages(quiet, silentRpc());
  assert.deepEqual(none.pools, []);
  assert.deepEqual(none.evidence.calls, []);
  verifyHyperSyncRecentLaunches(none);

  // Pages end on complete blocks; the batch ends with the last whole page.
  const dense = new FakeHyperSync({
    height: base + 138,
    logs: chainLogs(),
    maxLogsPerPage: 2,
  });
  const short = await collectRecentPages(syntheticClient(dense), {
    fromBlock: base,
    toBlock: base + 10,
    height: base + 138,
    maxPages: 1,
  });
  assert.equal(short.toBlock, launchBlock);
  const shortSwaps = recentSwapsFromPages(short, syntheticRegistry);
  assert.equal(shortSwaps.toBlock, launchBlock);
  assert.equal(shortSwaps.observedSwaps, 0);
  verifyHyperSyncRecentSwaps(shortSwaps, syntheticRegistry);
  const two = await collectRecentPages(syntheticClient(dense), {
    fromBlock: base,
    toBlock: base + 10,
    height: base + 138,
    maxPages: 2,
  });
  assert.equal(two.toBlock, base + 6);
  assert.equal(recentSwapsFromPages(two, syntheticRegistry).observedSwaps, 2);
});

test("confirmation and canonical-chain checks fail closed, including a null or low archive height", async () => {
  const height = base + 10 + 128;
  const range = { fromBlock: base, toBlock: base + 10, height };
  // The requested end must sit the full buffer below the height just read.
  const fake = new FakeHyperSync({ height, logs: chainLogs() });
  await assert.rejects(
    collectRecentPages(syntheticClient(fake), { ...range, height: height - 1 }),
    /exceeds the confirmed cutoff/,
  );
  assert.equal(fake.requests.length, 0);
  const respond = (
    change: (json: Record<string, unknown>) => void,
  ): FakeHyperSync => {
    const f = new FakeHyperSync({
      height,
      logs: chainLogs(),
      intercept: (request) => {
        if (!request.body) return undefined;
        const json = f.respond(request.body) as Record<string, unknown>;
        change(json);
        return new Response(JSON.stringify(json), { status: 200 });
      },
    });
    return f;
  };
  const blocks = (json: Record<string, unknown>) =>
    (json.data as { blocks: Record<string, unknown>[] }[])[0].blocks;
  for (const [name, change, error] of [
    [
      "a null archive height is never read as confirmed",
      (json: Record<string, unknown>) => (json.archive_height = null),
      /archive height below the confirmed cutoff/,
    ],
    [
      "a literal false archive height is rejected, never defaulted",
      (json: Record<string, unknown>) => (json.archive_height = false),
      /invalid response envelope/,
    ],
    [
      "an absent archive height",
      (json: Record<string, unknown>) => delete json.archive_height,
      /archive height below the confirmed cutoff/,
    ],
    [
      "an archive height inside the buffer",
      (json: Record<string, unknown>) => (json.archive_height = height - 1),
      /archive height below the confirmed cutoff/,
    ],
    [
      "a block whose parent is not its predecessor",
      (json: Record<string, unknown>) =>
        (blocks(json)[4].parent_hash = word(123456)),
      /Inconsistent HyperSync canonical headers/,
    ],
    [
      "a block timestamp that goes backwards",
      (json: Record<string, unknown>) => (blocks(json)[4].timestamp = "0x1"),
      /Inconsistent HyperSync canonical headers/,
    ],
    [
      "a missing block",
      (json: Record<string, unknown>) => blocks(json).splice(3, 1),
      /missing headers/,
    ],
    [
      "a log outside the three selections",
      (json: Record<string, unknown>) => {
        const logs = (json.data as { logs: Record<string, unknown>[] }[])[0]
          .logs;
        logs[3].address = "0x4444444444444444444444444444444444444444";
      },
      /Unexpected HyperSync recent source or range/,
    ],
  ] as const) {
    await assert.rejects(
      collectRecentPages(syntheticClient(respond(change)), range),
      error,
      name,
    );
  }
});

test("verification rejects every tampered row, count, label, registry claim and retained row", async () => {
  const fake = new FakeHyperSync({ height: base + 138, logs: chainLogs() });
  const pages = await collectRecentPages(syntheticClient(fake), {
    fromBlock: base,
    toBlock: base + 10,
    height: base + 138,
  });
  const swaps = recentSwapsFromPages(pages, syntheticRegistry);
  const swapCases: [string, (b: HyperSyncRecentSwapBatch) => void, RegExp][] = [
    [
      "sender",
      (b) => (b.events[0].transactionSender = creator),
      /disagree with retained evidence/,
    ],
    [
      "sender in the retained transaction",
      (b) => (b.evidence.transactions[0].from = creator),
      /disagree with retained evidence/,
    ],
    [
      "failed transaction",
      (b) => (b.evidence.transactions[0].status = 0),
      /consistent successful transaction/,
    ],
    ["timestamp", (b) => (b.events[0].timestamp += 1), /disagree/],
    [
      "block timestamp",
      (b) =>
        (b.evidence.blocks[1].timestamp = `0x${(launchBlock * 2 + 1).toString(16)}`),
      /disagree|Inconsistent/,
    ],
    ["amount", (b) => (b.events[0].ethWei = "11"), /disagree/],
    [
      "log data",
      (b) => (b.evidence.logs[0].data = swapData(-11n, 200n)),
      /disagree/,
    ],
    ["observed count", (b) => (b.observedSwaps += 1), /disagree/],
    [
      "unregistered count",
      (b) => (b.unregisteredSwaps = 0),
      /Invalid|disagree/,
    ],
    ["unsupported count", (b) => (b.unsupportedSwaps = 0), /disagree/],
    [
      "a registered pool claimed unregistered",
      (b) => (b.evidence.unregistered.poolIds = [poolId]),
      /unregistered pool ids/,
    ],
    ["a dropped row", (b) => b.events.pop(), /disagree/],
    [
      "an unrelated retained block",
      (b) => b.evidence.blocks.splice(1, 0, pages.blocks.get(base + 1)!),
      /unrelated rows/,
    ],
    [
      "the source label",
      (b) => ((b.evidence as { stream: string }).stream = "recent:rpc:v1"),
      /Invalid HyperSync recent evidence/,
    ],
    [
      "the query",
      (b) => (b.evidence.query.from_block = 999),
      /query disagrees/,
    ],
    [
      "a missing query",
      (b) => delete (b.evidence as { query?: unknown }).query,
      /query disagrees/,
    ],
    [
      "a null page record",
      (b) => ((b.evidence.pages as unknown[])[0] = null),
      /pages disagree/,
    ],
    [
      "a page archive height inside the buffer",
      (b) => (b.evidence.pages[0].archiveHeight = base + 11),
      /pages disagree/,
    ],
    ["the cutoff hash", (b) => (b.blockHash = word(5)), /disagree/],
    ["the parent link", (b) => (b.fromBlockParentHash = word(5)), /disagree/],
  ];
  verifyHyperSyncRecentSwaps(clone(swaps), syntheticRegistry);
  for (const [name, change, error] of swapCases) {
    const b = clone(swaps);
    change(b);
    assert.throws(
      () => verifyHyperSyncRecentSwaps(b, syntheticRegistry),
      error,
      name,
    );
  }
  // Registry claims are the writer's to re-resolve: an empty registry cannot
  // support a retained row, and a later launch cannot own an earlier swap.
  assert.throws(
    () => verifyHyperSyncRecentSwaps(clone(swaps), []),
    /outside the resolved registry/,
  );
  assert.throws(
    () =>
      verifyHyperSyncRecentSwaps(clone(swaps), [
        { id: poolId, token, launchBlock: base + 7 },
      ]),
    /precedes verified launch/,
  );

  const { rpc } = metadataRpc({ [token]: ["Synthetic", "SYN"] });
  const launches = await recentLaunchesFromPages(pages, rpc);
  const launchCases: [
    string,
    (b: HyperSyncRecentLaunchBatch) => void,
    RegExp,
  ][] = [
    ["sender", (b) => (b.pools[0].launchSender = initiator), /disagree/],
    ["launch time", (b) => (b.pools[0].launchedAt += 1), /disagree/],
    ["name", (b) => (b.pools[0].name = "Other"), /disagree/],
    [
      "image",
      (b) => (b.pools[0].imageUrl = "https://x.test/a.png"),
      /disagree/,
    ],
    [
      "the launcher's log",
      (b) => b.evidence.launcherLogs.pop(),
      /Unverified catalog launch/,
    ],
    [
      "the launch transaction sender",
      (b) => (b.evidence.transactions[0].from = initiator),
      /disagree/,
    ],
    [
      "the name reply",
      (b) => {
        const call = b.evidence.calls[0];
        if (call.kind !== "multicall3") throw Error("expected an aggregate");
        call.result = encodeAggregateReply([
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "name",
              result: "Forged",
            }),
          },
          {
            success: true,
            returnData: encodeFunctionResult({
              abi: erc20Abi,
              functionName: "symbol",
              result: "SYN",
            }),
          },
        ]);
      },
      /disagree/,
    ],
    ["a dropped launch", (b) => b.pools.pop(), /disagree/],
    [
      "metadata issues",
      (b) =>
        b.evidence.tokenMetadataIssues.push({
          transactionHash: launchTx,
          logIndex: 1,
          reason: "ambiguous_metadata",
        }),
      /disagree/,
    ],
  ];
  verifyHyperSyncRecentLaunches(clone(launches));
  for (const [name, change, error] of launchCases) {
    const b = clone(launches);
    change(b);
    assert.throws(() => verifyHyperSyncRecentLaunches(b), error, name);
  }
});
