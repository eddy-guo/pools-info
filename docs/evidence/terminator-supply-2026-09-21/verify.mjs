// Offline evidence replay. No network, database, collector, or production writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { readTokenSupplies } from "../../../packages/chain/src/token-supply.ts";
import {
  readContracts,
  canonicalMulticall3Address,
} from "../../../packages/chain/src/multicall.ts";
const directory = new URL("./", import.meta.url);
const read = (file) =>
  JSON.parse(fs.readFileSync(new URL(file, directory), "utf8"));
const recorded = read("chain.json");
const rows = recorded.evidence;
assert.equal(rows.length, 11);
for (const row of rows) {
  assert.equal(row.status, 200);
  assert.equal(row.response.error, undefined);
}
assert.equal(rows[0].response.result, "0x1237");
const first = rows[1].response.result;
const last = rows.at(-1).response.result;
assert.equal(first.number, "0x41b898f");
assert.equal(first.hash, last.hash);
const calls = rows.filter((row) => row.request.method === "eth_call");
for (const row of calls) assert.equal(row.request.params[1], first.number);
const supplyRaw = BigInt(calls[0].response.result);
const decimals = BigInt(calls[1].response.result);
assert.equal(supplyRaw, 10n ** 27n);
assert.equal(decimals, 18n);
const consumed = new Set();
const rpc = {
  batch: async (method, params) =>
    params.map((args) => {
      const row = calls.find(
        (entry) =>
          entry.request.method === method &&
          JSON.stringify(entry.request.params) === JSON.stringify(args),
      );
      assert.ok(row, "Replay must match the exact recorded request");
      consumed.add(row.request.id);
      return row.response.result;
    }),
};
const config = { address: canonicalMulticall3Address, maxCalls: 200 };
const block = Number(BigInt(first.number));
const decoded = await readTokenSupplies(rpc, [recorded.token], block, config);
assert.deepEqual(decoded.supplies, [
  { token: recorded.token, supplyRaw: supplyRaw.toString(), block },
]);
const units = await readContracts(
  rpc,
  [{ to: recorded.token, data: "0x313ce567" }],
  block,
  config,
);
assert.equal(BigInt(units.results[0]), decimals);
assert.equal(consumed.size, 2);
const receipt = rows.find(
  (row) => row.request.method === "eth_getTransactionReceipt",
).response.result;
assert.equal(receipt.status, "0x1");
assert.equal(Number(BigInt(receipt.blockNumber)), 68428500);
const transferTopic =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const zeroTopic = "0x" + "0".repeat(64);
const deadTopic = "0x" + "0".repeat(60) + "dead";
const tokenTransfers = receipt.logs.filter(
  (log) =>
    log.address.toLowerCase() === recorded.token &&
    log.topics[0] === transferTopic,
);
const minted = tokenTransfers.filter((log) => log.topics[1] === zeroTopic);
assert.equal(minted.length, 1);
assert.equal(BigInt(minted[0].data), supplyRaw);
const deadTransfer = tokenTransfers.find((log) => log.topics[2] === deadTopic);
assert.equal(BigInt(deadTransfer.data), 17786n);
assert.equal(
  BigInt(
    calls.find(
      (row) => row.request.params[0].data === "0x70a08231" + "0".repeat(64),
    ).response.result,
  ),
  0n,
);
assert.equal(
  BigInt(
    calls.find(
      (row) =>
        row.request.params[0].data === "0x70a08231" + "0".repeat(60) + "dead",
    ).response.result,
  ),
  17786n,
);
for (const name of ["historical-pair.json", "current-pair.json"]) {
  const pair = read(name);
  const market = pair.ours.data.market;
  const xyz = pair.xyz.data[0].result.data;
  assert.equal(market.token, recorded.token);
  assert.equal(xyz.tokenAddress.toLowerCase(), recorded.token);
  assert.equal(xyz.poolId, market.poolId);
  assert.equal(market.decimals, Number(decimals));
  assert.equal(
    BigInt(market.fdvWei),
    (BigInt(market.priceWei) * supplyRaw) / 10n ** decimals,
  );
  assert.ok(xyz.fdvUsd / xyz.poolStats.priceUsd > 6e9);
}
const current = read("current-pair.json");
assert.equal(Date.parse(current.xyz.at) - Date.parse(current.ours.at), 265);
for (const line of fs
  .readFileSync(new URL("SHA256SUMS", directory), "utf8")
  .trim()
  .split("\n")) {
  const [expected, name] = line.split("  ");
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(new URL(name, directory)))
      .digest("hex"),
    expected,
    name,
  );
}
console.log(
  "PASS: 11 RPC records; named block unchanged; direct and real Multicall decoder agree; launch mint and dead-address dust reconcile; both retained Pools Info FDV products exact; all evidence hashes match.",
);
