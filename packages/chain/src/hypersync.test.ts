import test from "node:test";
import assert from "node:assert/strict";
import type { Query, QueryResponse } from "@envio-dev/hypersync-client";
import { HyperSyncHistory } from "./hypersync";

const address = `0x${"aa".repeat(20)}`;
const hash = `0x${"bb".repeat(32)}` as const;
const topic = `0x${"cc".repeat(32)}`;
const tx = `0x${"dd".repeat(32)}`;
function page(block: number, nextBlock: number): QueryResponse {
  return {
    nextBlock,
    totalExecutionTime: 1,
    data: {
      blocks: [{ number: block, hash, timestamp: 1789366165 + block }],
      transactions: [],
      traces: [],
      logs: [
        {
          blockNumber: block,
          blockHash: hash,
          transactionHash: tx,
          logIndex: block,
          address,
          data: "0x",
          topics: [topic, null, null, null],
        },
      ],
    },
  };
}
function history(get: (query: Query) => Promise<QueryResponse>) {
  return new HyperSyncHistory({
    get,
    getHeight: async () => 500,
    getChainId: async () => 4663,
  });
}

test("bulk pages resume at nextBlock and include the requested final block", async () => {
  const queries: Query[] = [];
  const source = history(async (query) => {
    queries.push(query);
    return queries.length === 1 ? page(10, 12) : page(13, 14);
  });
  const logs = await source.logs(address, [topic], 10, 13);
  assert.deepEqual(
    queries.map((q) => [q.fromBlock, q.toBlock]),
    [
      [10, 14],
      [12, 14],
    ],
  );
  assert.deepEqual(
    logs.map((l) => Number(l.blockNumber)),
    [10, 13],
  );
  assert.equal(Number(source.blocks.get(13)?.timestamp), 1789366178);
});

test("a stalled or overshooting page cannot publish partial coverage", async () => {
  for (const next of [10, 15]) {
    const source = history(async () => page(10, next));
    await assert.rejects(
      source.logs(address, [topic], 10, 13),
      /non-progressing/,
    );
  }
});

test("wrong event, removed log, and missing header fail closed", async () => {
  for (const mutate of [
    (p: QueryResponse) => {
      p.data.logs[0].topics = [hash];
    },
    (p: QueryResponse) => {
      p.data.logs[0].removed = true;
    },
    (p: QueryResponse) => {
      p.data.blocks = [];
    },
  ]) {
    const response = page(10, 14);
    mutate(response);
    await assert.rejects(
      history(async () => response).logs(address, [topic], 10, 13),
      /mismatched archive log/,
    );
  }
});

test("archive cutoff must agree with the independent RPC hash", async () => {
  const source = history(async () => page(13, 14));
  await source.verifyCutoff(13, hash);
  await assert.rejects(
    source.verifyCutoff(13, `0x${"ee".repeat(32)}`),
    /cutoff disagree/,
  );
});

test("conflicting headers across scans invalidate the collection", async () => {
  let count = 0;
  const source = history(async () => {
    const response = page(10, 14);
    if (count++) response.data.blocks[0].hash = `0x${"ee".repeat(32)}`;
    return response;
  });
  await source.logs(address, [topic], 10, 13);
  await assert.rejects(source.logs(address, [topic], 10, 13), /block changed/);
});

test("incompatible rollback guards across consecutive pages fail closed", async () => {
  const source = history(async (query) => {
    const response = page(query.fromBlock, query.fromBlock + 1);
    response.rollbackGuard = {
      blockNumber: query.fromBlock,
      timestamp: 1,
      hash,
      firstBlockNumber: query.fromBlock,
      firstParentHash: `0x${"ee".repeat(32)}`,
    };
    return response;
  });
  await assert.rejects(
    source.logs(address, [topic], 10, 11),
    /rollback between pages/,
  );
});

test("archive errors propagate without substituting an empty history", async () => {
  const source = history(async () => {
    throw Error("Rate limited");
  });
  await assert.rejects(source.logs(address, [topic], 10, 13), /Rate limited/);
});
