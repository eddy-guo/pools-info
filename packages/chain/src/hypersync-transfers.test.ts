import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { toEventSelector } from "viem";
import {
  collectHyperSyncTransfers,
  verifyHyperSyncTransferBatch,
} from "./hypersync-transfers";
import {
  HyperSyncClient,
  transferLogQuery,
  type HyperSyncQuery,
} from "./hypersync";
import { FakeHyperSync, word } from "./hypersync-fake";
import { transferEvent } from "./events";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/hypersync/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const from = 62688988,
  to = 62689007;
const tokens = [
  "0x433025fe9550ed919d8b28b53a3f5419be678d0d",
  "0xb480aa907f5ca5364daa47508f06d248411f28be",
];
const token = "x".repeat(16);

test("a recorded transfer page becomes typed tier-3 rows joined to initiator and block time", async () => {
  const request = fixture("transfers-token-filter.request");
  const response = fixture("transfers-token-filter.response");
  const cutoff = (
    response.data[0].blocks as {
      number: number;
      hash: string;
      timestamp: string;
    }[]
  ).find((b) => b.number === to);
  const header = (n: number) => ({
    number: n,
    hash: word(n),
    parent_hash: word(n - 1),
    timestamp: "0x6aa7b92c",
  });
  let headerRequests = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/height")
      return new Response(JSON.stringify({ height: 64149300 }), {
        status: 200,
      });
    const body = JSON.parse(String(init?.body)) as HyperSyncQuery;
    if (body.include_all_blocks) {
      headerRequests++;
      return new Response(
        JSON.stringify({
          data: [{ blocks: [header(body.from_block)] }],
          archive_height: 64149300,
          next_block: body.from_block + 1,
          total_execution_time: 1,
          rollback_guard: null,
        }),
        { status: 200 },
      );
    }
    assert.deepEqual(body, request);
    return new Response(JSON.stringify(response), { status: 200 });
  };
  const client = new HyperSyncClient({
    url: "https://4663.hypersync.xyz",
    token,
    fetch,
    minIntervalMs: 0,
  });
  const batch = await collectHyperSyncTransfers(
    { tokens: [tokens[1], tokens[0]], fromBlock: from, toBlock: to },
    client,
  );
  assert.deepEqual(batch.tokens, tokens);
  assert.equal(batch.transfers.length, 9);
  assert.equal(batch.evidence.logs.length, 9);
  assert.equal(batch.evidence.transactions.length, 3);
  assert.deepEqual(
    batch.evidence.query,
    transferLogQuery({ fromBlock: from, toBlock: to }, tokens),
  );
  // The cutoff block carried no transfer, so exactly one header query was made.
  assert.equal(cutoff, undefined);
  assert.equal(headerRequests, 1);
  assert.equal(batch.blockHash, word(to));
  assert.equal(
    batch.fromBlockParentHash,
    "0x2ac95821fc0b24dbb7e16904b22144de24056ad1af573c39b71a1873ef55ffb6",
  );
  const mint = batch.transfers[0];
  assert.equal(mint.token, tokens[0]);
  assert.equal(mint.from, "0x0000000000000000000000000000000000000000");
  assert.equal(mint.to, "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0");
  assert.equal(
    mint.value,
    BigInt(
      "0x0000000000000000000000000000000000000000033b2e3c9fd0803ce8000000",
    ).toString(),
  );
  assert.equal(
    mint.transactionSender,
    "0x22995fc5edc0187991ed96aeb105197298d1bbb6",
  );
  assert.equal(mint.timestamp, 0x6aa7b92b);
  assert.doesNotThrow(() =>
    verifyHyperSyncTransferBatch(JSON.parse(JSON.stringify(batch))),
  );
  for (const [name, change, expected] of [
    [
      "value",
      (b: any) => (b.transfers[0].value = "1"),
      /disagree with retained evidence/,
    ],
    [
      "dropped log",
      (b: any) => b.evidence.logs.pop(),
      /disagree with retained evidence|unrelated rows/,
    ],
    [
      "status",
      (b: any) => (b.evidence.transactions[0].status = 0),
      /lacks a consistent successful transaction/,
    ],
    [
      "foreign token",
      (b: any) => (b.tokens = [tokens[0]]),
      /Invalid HyperSync transfer evidence|Unexpected HyperSync transfer/,
    ],
    [
      "cutoff",
      (b: any) => (b.blockHash = word(1)),
      /disagree with retained evidence/,
    ],
  ] as const) {
    const copy = structuredClone(batch);
    change(copy);
    assert.throws(() => verifyHyperSyncTransferBatch(copy), expected, name);
  }
});

test("synthetic transfers page, cut short at a block boundary, and rejected when the token list disagrees", async () => {
  const tokenA = "0x1111111111111111111111111111111111111111";
  const transfer = (block: number, index: number, address = tokenA) => ({
    block,
    logIndex: index,
    transactionHash: word(block * 100 + index),
    address,
    topics: [toEventSelector(transferEvent), word(1), word(2)],
    data: word(5),
    from: "0x2222222222222222222222222222222222222222",
  });
  const fake = new FakeHyperSync({
    height: 10000,
    logs: [
      transfer(10, 0),
      transfer(11, 0),
      transfer(12, 0),
      transfer(12, 1, "0x3333333333333333333333333333333333333333"),
    ],
    maxLogsPerPage: 2,
  });
  const client = () =>
    new HyperSyncClient({
      url: "https://4663.hypersync.xyz",
      token,
      fetch: fake.fetch,
      minIntervalMs: 0,
    });
  const batch = await collectHyperSyncTransfers(
    { tokens: [tokenA], fromBlock: 0, toBlock: 50, maxPages: 1 },
    client(),
  );
  assert.equal(batch.toBlock, 11);
  assert.equal(batch.transfers.length, 2);
  assert.equal(batch.transfers[0].value, "5");
  const whole = await collectHyperSyncTransfers(
    { tokens: [tokenA], fromBlock: 0, toBlock: 50 },
    client(),
  );
  assert.equal(whole.toBlock, 50);
  assert.equal(whole.transfers.length, 3);
  await assert.rejects(
    collectHyperSyncTransfers(
      { tokens: [tokenA, tokenA], fromBlock: 0, toBlock: 50 },
      client(),
    ),
    /Invalid HyperSync transfer range/,
  );
  await assert.rejects(
    collectHyperSyncTransfers(
      { tokens: [tokenA], fromBlock: 0, toBlock: 1000000 },
      client(),
    ),
    /Invalid HyperSync transfer range/,
  );
  fake.height = 100;
  await assert.rejects(
    collectHyperSyncTransfers(
      { tokens: [tokenA], fromBlock: 0, toBlock: 50 },
      client(),
    ),
    /exceeds the confirmed cutoff/,
  );
});
