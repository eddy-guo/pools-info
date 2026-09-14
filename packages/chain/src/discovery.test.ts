import test from "node:test";
import assert from "node:assert/strict";
import { discoverRecentLaunches } from "./discovery";
import type { RawLog } from "./events";
const log = (block: number) =>
  ({ blockNumber: `0x${block.toString(16)}` }) as RawLog;
test("newest-first discovery stops after finding the sample and reports actual coverage", async () => {
  const ranges: number[][] = [];
  const result = await discoverRecentLaunches(
    {
      logs: async (_a, _t, from, to) => {
        ranges.push([from, to]);
        return [log(from + 1), log(to)];
      },
    },
    1,
    100000,
    3,
  );
  assert.deepEqual(ranges, [
    [90001, 100000],
    [80001, 90000],
  ]);
  assert.equal(result.fromBlock, 80001);
  assert.deepEqual(
    result.launches.map((l) => Number(l.blockNumber)),
    [80002, 90000, 90002, 100000],
  );
});
test("sparse discovery reaches the lower bound without overlapping or inventing launches", async () => {
  const ranges: number[][] = [];
  const result = await discoverRecentLaunches(
    {
      logs: async (_a, _t, from, to) => {
        ranges.push([from, to]);
        return [];
      },
    },
    123,
    20125,
    8,
  );
  assert.deepEqual(ranges, [
    [10126, 20125],
    [126, 10125],
    [123, 125],
  ]);
  assert.equal(result.fromBlock, 123);
  assert.deepEqual(result.launches, []);
});
test("a failed discovery chunk cannot return a misleading partial sample", async () => {
  let calls = 0;
  await assert.rejects(
    discoverRecentLaunches(
      {
        logs: async () => {
          if (calls++) throw Error("source failure");
          return [log(99999)];
        },
      },
      1,
      100000,
      8,
    ),
    /source failure/,
  );
});
