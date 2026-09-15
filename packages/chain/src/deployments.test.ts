import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Hex,
} from "viem";
import {
  instantDeployments,
  getInstantDeployment,
  instantRegistryVerifiedAtBlock,
} from "./deployments";
import { contracts, decodeLaunch, launchEvent, type RawLog } from "./events";
import { collectCatalog } from "./catalog";
import { Rpc, hex } from "./rpc";
import { tokenMetadataFactory } from "./token-metadata";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const zero = `0x${"0".repeat(40)}` as const;
const keyTypes = [
  { type: "address" },
  { type: "address" },
  { type: "uint24" },
  { type: "int24" },
  { type: "address" },
] as const;
function launch(i: number): RawLog {
  const d = instantDeployments[i],
    token = `0x${(i + 1).toString(16).padStart(40, "0")}` as Hex;
  const data = encodeAbiParameters(keyTypes, [
    zero,
    token,
    2500,
    d.tickSpacing,
    zero,
  ]);
  return {
    address: d.strategy,
    topics: [
      toEventSelector(launchEvent),
      keccak256(data),
      `0x${token.slice(2).padStart(64, "0")}`,
      `0x${d.feeSplitter.slice(2).padStart(64, "0")}`,
    ],
    data,
    blockNumber: hex(instantRegistryVerifiedAtBlock),
    blockHash: word(1),
    transactionHash: word(i + 100),
    logIndex: hex(i),
    removed: false,
  };
}
test("every pinned Robinhood Instant generation preserves its own shape, launcher and fee variant", () => {
  assert.equal(instantDeployments.length, 12);
  assert.equal(
    Math.min(...instantDeployments.map((d) => d.deployedAtBlock)),
    22754669,
  );
  assert.ok(
    instantDeployments.every(
      (d) =>
        d.deployedAtBlock > 0 &&
        d.deployedAtBlock <= instantRegistryVerifiedAtBlock,
    ),
  );
  assert.equal(new Set(instantDeployments.map((d) => d.strategy)).size, 12);
  assert.equal(
    instantDeployments.filter((d) => d.tickSpacing === 60).length,
    8,
  );
  assert.equal(new Set(instantDeployments.map((d) => d.launcher)).size, 3);
  for (let i = 0; i < instantDeployments.length; i++) {
    const d = instantDeployments[i],
      log = launch(i);
    assert.equal(decodeLaunch(log).key.tickSpacing, d.tickSpacing);
    assert.equal(getInstantDeployment(d.strategy.toUpperCase()), d);
    assert.throws(
      () =>
        decodeLaunch({
          ...log,
          topics: [log.topics[0], word(99), log.topics[2], log.topics[3]],
        }),
      /PoolKey/,
    );
    assert.throws(
      () =>
        decodeLaunch({
          ...log,
          topics: [log.topics[0], log.topics[1], log.topics[2], word(99)],
        }),
      /PoolKey/,
    );
  }
});
test("valid pool IDs with the wrong generation spacing and unregistered Crowd sources remain rejected", () => {
  const old = launch(0),
    args = decodeLaunch(old);
  const data = encodeAbiParameters(keyTypes, [
    zero,
    args.token,
    2500,
    25,
    zero,
  ]);
  assert.throws(
    () =>
      decodeLaunch({
        ...old,
        data,
        topics: [old.topics[0], keccak256(data), old.topics[2], old.topics[3]],
      }),
    /PoolKey/,
  );
  assert.equal(
    getInstantDeployment("0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000"),
    undefined,
  );
  assert.throws(
    () =>
      decodeLaunch({
        ...old,
        address: "0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000",
      }),
    /source/,
  );
});
function mock(wrongHistoricalLauncher = false) {
  const rpc = new Rpc(),
    logs = instantDeployments.map((_, i) => launch(i));
  const height = instantRegistryVerifiedAtBlock;
  const header = {
    number: hex(height),
    hash: word(1),
    timestamp: hex(1789440000),
  };
  rpc.call = async <T>(method: string) =>
    method === "eth_chainId"
      ? (hex(4663) as T)
      : method === "eth_blockNumber"
        ? (hex(height + 128) as T)
        : (header as T);
  rpc.logs = async (address) => {
    assert.deepEqual(address, [...contracts.strategies, tokenMetadataFactory]);
    return logs;
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) =>
    params.map((p, i) => {
      if (method === "eth_getBlockByNumber") return header;
      if (method === "eth_call")
        return encodeAbiParameters(
          [{ type: "string" }],
          [i % 2 ? "T" : "Token"],
        );
      const log = logs.find((l) => l.transactionHash === p[0])!,
        d = getInstantDeployment(log.address)!;
      return {
        transactionHash: log.transactionHash,
        blockHash: log.blockHash,
        status: "0x1",
        from: zero,
        logs: [
          log,
          {
            ...log,
            address: wrongHistoricalLauncher ? contracts.launcher : d.launcher,
          },
        ],
      };
    }) as T[];
  return rpc;
}
test("catalog accepts historical/current launches only with their mapped launcher receipt evidence", async () => {
  const range = {
    fromBlock: instantRegistryVerifiedAtBlock,
    toBlock: instantRegistryVerifiedAtBlock,
  };
  const result = await collectCatalog(undefined, mock(), range);
  assert.equal(result.catalog.pools.length, 12);
  await assert.rejects(
    collectCatalog(undefined, mock(true), range),
    /Unverified catalog launch/,
  );
});

test("catalog fails before enrichment when launch height precedes its verified contract deployment", async () => {
  const block = instantDeployments[0].deployedAtBlock - 1,
    rpc = new Rpc();
  rpc.call = async <T>(method: string) =>
    hex(method === "eth_chainId" ? 4663 : instantRegistryVerifiedAtBlock) as T;
  rpc.logs = async () => [{ ...launch(0), blockNumber: hex(block) }];
  rpc.batch = async () => {
    throw Error("must not enrich premature launch");
  };
  await assert.rejects(
    collectCatalog(undefined, rpc, { fromBlock: block, toBlock: block }),
    /Launch precedes verified deployment/,
  );
});

import { readFileSync } from "node:fs";
import { collectRecentEvents } from "./recent-events";
import type { Receipt } from "./audit";
import type { EventHeader } from "./pool-events";
test("actual previously omitted 60-tick Pools launch and sixteen receipt-backed swaps survive replay", async () => {
  const proof = JSON.parse(
    readFileSync(
      new URL(
        "../../../data/registry/omitted-launch-proof.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const evidence = proof.catalog.evidence as {
    logs: RawLog[];
    receipts: Receipt[];
    headers: EventHeader[];
  };
  const recent = proof.recent.evidence as {
    logs: RawLog[];
    receipts: Receipt[];
    headers: EventHeader[];
  };
  const log = evidence.logs[0],
    decoded = decodeLaunch(log),
    deployment = getInstantDeployment(log.address)!;
  assert.equal(log.address, "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2");
  assert.equal(decoded.key.tickSpacing, 60);
  assert.equal(
    deployment.launcher,
    "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
  );
  assert.equal(
    contracts.strategies
      .slice(0, 2)
      .includes(log.address as (typeof contracts.strategies)[number]),
    false,
  );
  const rpc = new Rpc(),
    headers = [...evidence.headers, ...recent.headers],
    receipts = [...evidence.receipts, ...recent.receipts];
  rpc.call = async <T>(method: string, params: unknown[]) =>
    method === "eth_chainId"
      ? (hex(4663) as T)
      : method === "eth_blockNumber"
        ? (hex(proof.recent.toBlock + 128) as T)
        : (headers.find((h) => Number(h.number) === Number(params[0])) as T);
  rpc.logs = async (address) =>
    address === contracts.manager ? recent.logs : evidence.logs;
  rpc.batch = async <T>(method: string, params: unknown[][]) =>
    params.map((p, i) =>
      method === "eth_getBlockByNumber"
        ? headers.find((h) => Number(h.number) === Number(p[0]))
        : method === "eth_getTransactionReceipt"
          ? receipts.find((r) => r.transactionHash === p[0])
          : encodeAbiParameters(
              [{ type: "string" }],
              [i % 2 ? "POOLS" : "pools.trade"],
            ),
    ) as T[];
  const block = Number(log.blockNumber),
    catalog = await collectCatalog(undefined, rpc, {
      fromBlock: block,
      toBlock: block,
    });
  assert.equal(catalog.catalog.pools[0].id, decoded.poolId);
  const swaps = await collectRecentEvents(
    { fromBlock: block, toBlock: block + 9, pools: catalog.catalog.pools },
    rpc,
  );
  assert.equal(swaps.events.length, 16);
  assert.deepEqual(swaps.events, proof.recent.events);
});
