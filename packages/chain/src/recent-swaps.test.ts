import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import { collectRecentSwaps } from "./recent-swaps";
import { contracts, swapEvent, type RawLog } from "./events";
import { Rpc, hex } from "./rpc";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const log: RawLog = {
  address: contracts.manager,
  topics: [toEventSelector(swapEvent), word(3), word(4)],
  data: encodeAbiParameters(
    [
      { type: "int128" },
      { type: "int128" },
      { type: "uint160" },
      { type: "uint128" },
      { type: "int24" },
      { type: "uint24" },
    ],
    [-10n, 20n, 1n << 96n, 100n, 0, 2500],
  ),
  blockNumber: hex(1500),
  blockHash: word(1500),
  transactionHash: word(9),
  logIndex: "0x0",
  removed: false,
};
function fake(changed = false) {
  const rpc = new Rpc();
  rpc.call = async <T>(method: string) =>
    (method === "eth_chainId" ? hex(4663) : hex(2000)) as T;
  rpc.logs = async () => [log];
  rpc.batch = async <T>(method: string, params: unknown[][]) =>
    params.map((p) =>
      method === "eth_getBlockByNumber"
        ? { number: p[0], timestamp: hex(1000), hash: word(Number(p[0])) }
        : {
            transactionHash: p[0],
            blockHash: changed ? word(1) : log.blockHash,
            status: "0x1",
            from: "0x1111111111111111111111111111111111111111",
            logs: [log],
          },
    ) as T[];
  return rpc;
}
test("recent swaps use the bounded lagged window and receipt-backed transaction sender", async () => {
  const r = await collectRecentSwaps([word(3)], fake());
  assert.equal(r.toBlock, 1872);
  assert.equal(r.fromBlock, 873);
  assert.equal(r.events[0].amount0, "-10");
  assert.equal(
    r.events[0].transactionSender,
    "0x1111111111111111111111111111111111111111",
  );
});
test("recent feed rejects inconsistent receipt evidence and unexpected pool IDs", async () => {
  await assert.rejects(
    collectRecentSwaps([word(3)], fake(true)),
    /Inconsistent/,
  );
  await assert.rejects(
    collectRecentSwaps([word(5)], fake()),
    /Unexpected pool/,
  );
  await assert.rejects(collectRecentSwaps([], fake()), /Invalid pools/);
});
