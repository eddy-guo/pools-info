import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import proof from "../../../data/registry/prologue-candidate-proof.json";
import { collectCatalog } from "./catalog";
import { contracts, launchEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
import {
  canonicalMulticall3Address,
  decodeAggregateRequest,
  encodeAggregateReply,
} from "./multicall";
import {
  decodeTokenMetadata,
  tokenMetadataEvent,
  tokenMetadataFactory,
  tokenMetadataLimits,
  tokenMetadataTopic,
} from "./token-metadata";

const launch = proof.evidence.logs[0] as unknown as RawLog;
const capturedMetadata = proof.evidence.receipts[0].logs.find(
  (l) => l.address === tokenMetadataFactory,
)! as unknown as RawLog;
const token = proof.candidate.token as Hex;
const image =
  "ipfs://bafkreibxargr7pdwdydhztyg2dbbkm4oueutbsfjcwcp24zrhlyem55iru";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
function created(
  overrides: Partial<{
    token: Hex;
    description: string;
    website: string;
    image: string;
    extraData: Hex;
  }> = {},
): RawLog {
  return {
    ...capturedMetadata,
    data: encodeAbiParameters(tokenMetadataEvent.inputs, [
      overrides.token ?? token,
      {
        description: overrides.description ?? "A real launch",
        website: overrides.website ?? "https://example.com/token",
        image: overrides.image ?? image,
        extraData: overrides.extraData ?? "0x",
      },
    ]),
  };
}

test("verified factory ABI decodes the real non-indexed token and ordered metadata tuple", () => {
  assert.equal(
    tokenMetadataTopic,
    "0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4",
  );
  assert.equal(capturedMetadata.topics.length, 1);
  const result = decodeTokenMetadata(capturedMetadata);
  assert.equal(result.metadata?.token, token.toLowerCase());
  assert.equal(result.metadata?.imageUrl, image);
  assert.ok(
    result.metadata?.description?.startsWith("Fables is a dynamic-fee"),
  );
  assert.equal(result.metadata?.externalUrl, undefined);
  assert.deepEqual(result.issues, []);
  assert.equal("extraData" in result.metadata!, false);
  assert.equal("name" in result.metadata!, false);
});

test("creator fields are bounded and unsafe URL schemes remain unavailable", () => {
  const result = decodeTokenMetadata(
    created({
      description: `A\0\u202eB${"🎉".repeat(4000)}`,
      website: "javascript:alert(1)",
      image: "https://user:password@example.com/image.png",
    }),
  );
  assert.equal(Array.from(result.metadata!.description!).length, 4000);
  assert.ok(result.metadata!.description!.startsWith("AB"));
  assert.equal(result.metadata!.imageUrl, undefined);
  assert.equal(result.metadata!.externalUrl, undefined);
  assert.deepEqual(result.issues, [
    "description_sanitized",
    "description_truncated",
    "invalid_image_url",
    "invalid_external_url",
  ]);
  for (const value of [
    "data:image/svg+xml,<svg/>",
    "file:///etc/passwd",
    "https://example.com/a\n.png",
    `https://example.com/${"a".repeat(2048)}`,
  ])
    assert.deepEqual(decodeTokenMetadata(created({ image: value })).issues, [
      "invalid_image_url",
    ]);
  assert.deepEqual(
    decodeTokenMetadata(created({ description: "", image: "", website: "" })),
    {
      metadata: { token: token.toLowerCase() },
      issues: [],
    },
  );
});

test("malformed, removed, oversized and wrong-emitter metadata cannot provide presentation claims", () => {
  for (const row of [
    { ...created(), address: contracts.launcher },
    { ...created(), removed: true },
    { ...created(), topics: [toEventSelector(launchEvent)] as [Hex] },
  ])
    assert.deepEqual(decodeTokenMetadata(row), {
      metadata: null,
      issues: ["unsupported_metadata_source"],
    });
  for (const row of [
    { ...created(), data: "0x" as Hex },
    { ...created(), data: `${created().data}00` as Hex },
    { ...created(), topics: [tokenMetadataTopic, word(1)] as [Hex, Hex] },
    created({ token: `0x${"0".repeat(40)}` }),
  ])
    assert.deepEqual(decodeTokenMetadata(row), {
      metadata: null,
      issues: ["malformed_metadata"],
    });
  assert.deepEqual(
    decodeTokenMetadata({
      ...created(),
      data: `0x${"00".repeat(tokenMetadataLimits.eventBytes + 1)}`,
    }),
    {
      metadata: null,
      issues: ["metadata_event_too_large"],
    },
  );
});

function collector(
  rows: RawLog[] = [capturedMetadata],
  receiptRows: RawLog[] = rows,
  toBlock = Number(launch.blockNumber) + 1,
) {
  const rpc = new Rpc();
  const queries: {
    address: unknown;
    topics: unknown[];
    from: number;
    to: number;
  }[] = [];
  const receiptQueries: unknown[][] = [];
  const header = (n: number) =>
    proof.evidence.headers.find((h) => Number(h.number) === n) ?? {
      number: hex(n),
      hash: word(n),
      timestamp: hex(proof.catalog.pools[0].launchedAt + 1),
    };
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId") return hex(4663) as T;
    if (method === "eth_blockNumber") return hex(toBlock + 128) as T;
    assert.equal(method, "eth_getBlockByNumber");
    return header(Number(params[0])) as T;
  };
  rpc.logs = async (address, topics, from, to) => {
    queries.push({ address, topics, from, to });
    return [launch, ...rows];
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p) => header(Number(p[0]))) as T[];
    if (method === "eth_getTransactionReceipt") {
      receiptQueries.push(...params);
      return [
        {
          ...proof.evidence.receipts[0],
          logs: [
            ...proof.evidence.receipts[0].logs.filter(
              (l) => l.address !== tokenMetadataFactory,
            ),
            ...receiptRows,
          ],
        },
      ] as T[];
    }
    assert.equal(method, "eth_call");
    const text = [
      proof.catalog.pools[0].name,
      proof.catalog.pools[0].symbol,
    ].map((s) => encodeAbiParameters([{ type: "string" }], [s]));
    return params.map((p, i) => {
      const call = p[0] as { to: string; data: Hex };
      if (call.to !== canonicalMulticall3Address) return text[i];
      return encodeAggregateReply(
        decodeAggregateRequest(call.data).map((_, j) => ({
          success: true,
          returnData: text[j],
        })),
      );
    }) as T[];
  };
  return {
    queries,
    receiptQueries,
    run: () =>
      collectCatalog(undefined, rpc, {
        fromBlock: Number(launch.blockNumber),
        toBlock,
      }),
  };
}

test("same sweep joins exact factory transaction/token and retains separate verified metadata evidence", async () => {
  const f = collector();
  const result = await f.run();
  assert.deepEqual(f.queries, [
    {
      address: [...contracts.strategies, tokenMetadataFactory],
      topics: [[toEventSelector(launchEvent), tokenMetadataTopic]],
      from: Number(launch.blockNumber),
      to: Number(launch.blockNumber) + 1,
    },
  ]);
  assert.deepEqual(f.receiptQueries, [[launch.transactionHash]]);
  assert.deepEqual(result.evidence.logs, [launch]);
  assert.deepEqual(result.evidence.tokenMetadataLogs, [capturedMetadata]);
  assert.deepEqual(result.evidence.tokenMetadataIssues, []);
  assert.equal(result.catalog.pools[0].imageUrl, image);
  assert.equal(result.catalog.pools[0].name, proof.catalog.pools[0].name);
  assert.equal(result.catalog.pools[0].launchSender, proof.candidate.creator);
});

test("metadata cannot leak across token, transaction or emitter, and legacy launches still work", async () => {
  const otherToken = created({ token: `0x${"ab".repeat(20)}` });
  const otherTx = { ...created(), transactionHash: word(88) };
  const wrongEmitter = { ...created(), address: launch.address };
  const wrongFactoryTopic: RawLog = {
    ...launch,
    address: tokenMetadataFactory,
  };
  const f = collector([otherToken, otherTx, wrongEmitter, wrongFactoryTopic]);
  const result = await f.run();
  assert.deepEqual(result.catalog.pools, proof.catalog.pools);
  assert.deepEqual(f.receiptQueries, [[launch.transactionHash]]);
  assert.deepEqual(result.evidence.tokenMetadataLogs, [otherToken]);
  assert.deepEqual(
    result.evidence.tokenMetadataIssues.map((i) => i.reason),
    ["unmatched_token"],
  );
  assert.deepEqual(
    (await collector([]).run()).catalog.pools,
    proof.catalog.pools,
  );
});

test("malformed or ambiguous verified metadata is disclosed without dropping a valid pool", async () => {
  const malformed = { ...created(), data: "0x" as Hex };
  const malformedResult = await collector([malformed]).run();
  assert.deepEqual(malformedResult.catalog.pools, proof.catalog.pools);
  assert.equal(
    malformedResult.evidence.tokenMetadataIssues[0].reason,
    "malformed_metadata",
  );
  const ambiguous = await collector([
    created(),
    { ...created({ image: "https://example.com/other.png" }), logIndex: "0x5" },
  ]).run();
  assert.deepEqual(ambiguous.catalog.pools, proof.catalog.pools);
  assert.equal(
    ambiguous.evidence.tokenMetadataIssues[0].reason,
    "ambiguous_metadata",
  );
});

test("receipt disagreement and noncanonical metadata fail the batch before catalog publication", async () => {
  for (const receiptRows of [
    [],
    [
      {
        ...capturedMetadata,
        data: created({ image: "https://example.com/conflict.png" }).data,
      },
    ],
    [{ ...capturedMetadata, transactionHash: word(999) }],
    [{ ...capturedMetadata, blockHash: word(999) }],
    [{ ...capturedMetadata, blockNumber: hex(Number(launch.blockNumber) + 1) }],
    [{ ...capturedMetadata, removed: true }],
  ])
    await assert.rejects(
      collector([capturedMetadata], receiptRows).run(),
      /Unverified catalog token metadata/,
    );
  const noncanonical = { ...capturedMetadata, blockHash: word(999) };
  await assert.rejects(
    collector([noncanonical]).run(),
    /Unverified catalog token metadata/,
  );
  await assert.rejects(
    collector([{ ...capturedMetadata, removed: true }]).run(),
    /Out-of-range catalog log/,
  );
});

test("discovery accepts an explicit 10000-block range but never widens it", async () => {
  const toBlock = Number(launch.blockNumber) + 9999;
  const f = collector([], [], toBlock);
  const result = await f.run();
  assert.equal(result.catalog.toBlock, toBlock);
  assert.equal(f.queries.length, 1);
  assert.equal(f.queries[0].to - f.queries[0].from + 1, 10000);
  await assert.rejects(
    collector([], [], toBlock + 1).run(),
    /at most 10000 blocks/,
  );
});
