import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters } from "viem";
import proof from "../../../data/registry/prologue-candidate-proof.json";
import { Rpc, hex } from "./rpc";
import {
  verifyLaunchCandidate,
  type LaunchCandidate,
} from "./launch-candidate";
import type { RawLog } from "./events";

const candidate: LaunchCandidate = {
  ...proof.candidate,
  chainId: 4663,
  launchpadId: "uniswap-bonding-curve",
};
const timestamp = Date.parse(candidate.createdAt) / 1000;
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
function fixture(
  options: {
    wrongChain?: boolean;
    reorg?: boolean;
    missingReceipt?: boolean;
  } = {},
) {
  const rpc = new Rpc();
  const ranges: number[][] = [];
  const header = (n: number) =>
    proof.evidence.headers.find((h) => Number(h.number) === n) ?? {
      number: hex(n),
      hash: word(n),
      timestamp: hex(timestamp + Math.floor((n - 38994651) / 10)),
    };
  rpc.call = async <T>(method: string, params: unknown[]) => {
    if (method === "eth_chainId")
      return hex(options.wrongChain ? 1 : 4663) as T;
    if (method === "eth_blockNumber")
      return hex(proof.catalog.toBlock + 1000) as T;
    assert.equal(method, "eth_getBlockByNumber");
    const h = header(Number(params[0]));
    return (
      options.reorg && Number(params[0]) === proof.catalog.toBlock
        ? { ...h, hash: word(999) }
        : h
    ) as T;
  };
  rpc.logs = async (_addresses, _topics, from, to) => {
    ranges.push([from, to]);
    return structuredClone(proof.evidence.logs).filter(
      (l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to,
    ) as unknown as RawLog[];
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    if (method === "eth_getBlockByNumber")
      return params.map((p) => header(Number(p[0]))) as T[];
    if (method === "eth_getTransactionReceipt")
      return (
        options.missingReceipt ? [] : structuredClone(proof.evidence.receipts)
      ) as T[];
    assert.equal(method, "eth_call");
    return [proof.catalog.pools[0].name, proof.catalog.pools[0].symbol].map(
      (s) => encodeAbiParameters([{ type: "string" }], [s]),
    ) as T[];
  };
  return { rpc, ranges };
}

test("timestamp lookup handles repeated block timestamps and verifies captured launch evidence", async () => {
  const f = fixture();
  const result = await verifyLaunchCandidate(candidate, f.rpc);
  assert.deepEqual(result.pool, proof.catalog.pools[0]);
  assert.deepEqual(f.ranges, [[38994650, 38994681]]);
  assert.equal(result.kind, "verified_instant_candidate");
  assert.equal(result.candidate.token, candidate.token.toLowerCase());
});

test("unsupported launch paths and invalid hints cannot become Instant launches", async () => {
  for (const override of [
    { launchpadId: "uniswap-cca" },
    { token: "invalid" },
    { createdAt: "invalid" },
    { createdAt: "2026-08-17T16:52:13.123Z" },
  ]) {
    const f = fixture();
    f.rpc.call = async () => {
      throw Error("Unexpected provider work");
    };
    await assert.rejects(
      verifyLaunchCandidate({ ...candidate, ...override }, f.rpc),
      /Invalid or unsupported/,
    );
  }
});

test("candidate identity cannot substitute for missing, conflicting or noncanonical evidence", async () => {
  await assert.rejects(
    verifyLaunchCandidate(candidate, fixture({ wrongChain: true }).rpc),
    /Wrong chain/,
  );
  await assert.rejects(
    verifyLaunchCandidate(candidate, fixture({ missingReceipt: true }).rpc),
    /receipt|launch/i,
  );
  await assert.rejects(
    verifyLaunchCandidate(candidate, fixture({ reorg: true }).rpc),
    /Cutoff changed/,
  );
  for (const override of [
    { creator: `0x${"a9".repeat(20)}` },
    { token: `0x${"a9".repeat(20)}` },
    { poolId: word(999) },
  ]) {
    await assert.rejects(
      verifyLaunchCandidate({ ...candidate, ...override }, fixture().rpc),
      /did not match/,
    );
  }
  await assert.rejects(
    verifyLaunchCandidate(
      { ...candidate, createdAt: "2100-01-01T00:00:00Z" },
      fixture().rpc,
    ),
    /outside confirmed/,
  );
});
