import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, toEventSelector, type Hex } from "viem";
import {
  contracts,
  decodeLaunch,
  decodeSwap,
  launchEvent,
  spotPriceWei,
  swapEvent,
  type RawLog,
} from "./events";
const word = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}`;
const base: RawLog = {
  address: contracts.manager,
  topics: [word(0)],
  data: "0x",
  blockNumber: "0x1",
  blockHash: word(1),
  transactionHash: word(2),
  logIndex: "0x0",
  removed: false,
};
function swap(amount0: bigint, amount1: bigint): RawLog {
  return {
    ...base,
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
      [amount0, amount1, 10n * (1n << 96n), 100n, 0, 2500],
    ),
  };
}
test("v4 caller deltas decode ETH input as a buy and ETH output as a sell", () => {
  const buy = decodeSwap(swap(-(10n ** 18n), 100n));
  assert.equal(buy.side, "buy");
  assert.equal(buy.ethWei, "1000000000000000000");
  assert.equal(buy.tokenRaw, "100");
  assert.equal(decodeSwap(swap(5n, -20n)).side, "sell");
  assert.throws(() => decodeSwap(swap(5n, 20n)), /signs/);
  assert.throws(
    () => decodeSwap({ ...swap(-5n, 20n), removed: true }),
    /source/,
  );
});
test("native currency0 spot conversion accounts for token decimals and inverted price", () => {
  assert.equal(spotPriceWei(10n * (1n << 96n), 18), "10000000000000000");
  assert.equal(spotPriceWei(1n << 96n, 6), "1000000");
  assert.throws(() => spotPriceWei(0n, 18));
});
test("a real launch identifies its final position recipient and rejects a forged pool ID", () => {
  const log: RawLog = {
    ...base,
    address: contracts.strategies[0],
    topics: [
      toEventSelector(launchEvent),
      "0x8fc4d69202d5cdd0d2485916891db5138b53a6733e8a36b585986e445b63554a",
      "0x0000000000000000000000002325f79f744ea1fd5047c4658b16f77252470ae3",
      "0x000000000000000000000000eff166aaf189323c58dc27ed1206eb2c37faacdf",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000000000000000000000000000000000000002325f79f744ea1fd5047c4658b16f77252470ae300000000000000000000000000000000000000000000000000000000000009c400000000000000000000000000000000000000000000000000000000000000190000000000000000000000000000000000000000000000000000000000000000",
  };
  assert.equal(
    decodeLaunch(log).finalPositionRecipient.toLowerCase(),
    "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
  );
  assert.throws(
    () =>
      decodeLaunch({
        ...log,
        topics: [log.topics[0], word(9), log.topics[2], log.topics[3]],
      }),
    /PoolKey/,
  );
});
