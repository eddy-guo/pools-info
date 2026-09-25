import assert from "node:assert/strict";
import test from "node:test";
import { createTokenRegistry, type RegistryToken } from "./token-registry";

test("the registry loads once, then only newer refs, and reloads in full to drop removed pools", async () => {
  let now = 1_000_000;
  let table: RegistryToken[] = [
    { ref: 1, token: "0xa" },
    { ref: 2, token: "0xb" },
  ];
  const loads: number[] = [];
  const registry = createTokenRegistry(
    async (afterRef) => {
      loads.push(afterRef);
      return table.filter((row) => row.ref > afterRef);
    },
    { now: () => now, refreshMs: 30000, fullReloadMs: 3600000 },
  );
  assert.deepEqual([...(await registry.current())], ["0xa", "0xb"]);
  // Within the refresh interval the set is served from memory.
  table.push({ ref: 3, token: "0xc" });
  now += 29000;
  assert.equal((await registry.current()).has("0xc"), false);
  assert.deepEqual(loads, [0]);
  // Past it, only rows beyond the highest ref held are read.
  now += 1000;
  assert.equal((await registry.current()).has("0xc"), true);
  assert.deepEqual(loads, [0, 2]);
  // A reorg removes a pool: the next full reload drops its token.
  table = table.filter((row) => row.ref !== 1);
  now += 3600000;
  const reloaded = await registry.current();
  assert.deepEqual([...reloaded].sort(), ["0xb", "0xc"]);
  assert.deepEqual(loads, [0, 2, 0]);
});

test("concurrent callers share one load, a failed refresh keeps the last set, and a first load failure is the caller's", async () => {
  let now = 0;
  let fail = false;
  let calls = 0;
  let release: () => void = () => {};
  const registry = createTokenRegistry(
    async () => {
      calls++;
      if (fail) throw Error("database_unavailable");
      await new Promise<void>((resolve) => (release = resolve));
      return [{ ref: 1, token: "0xa" }];
    },
    { now: () => now },
  );
  const first = [registry.current(), registry.current()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all(first);
  assert.equal(a, b);
  assert.equal(calls, 1);
  fail = true;
  now += 60000;
  const writes: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.deepEqual([...(await registry.current())], ["0xa"]);
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(writes, ['{"event":"token_registry_refresh_failed"}\n']);
  const cold = createTokenRegistry(async () => {
    throw Error("database_unavailable");
  });
  await assert.rejects(cold.current(), /database_unavailable/);
});
