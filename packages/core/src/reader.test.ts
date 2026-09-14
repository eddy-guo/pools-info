import { test } from "node:test";
import assert from "node:assert/strict";
import raw from "../../../data/snapshots/demo.json";
import { SnapshotReader } from "./reader";
import type { Snapshot } from "./types";
const snapshot = raw as Snapshot;
const reader = new SnapshotReader(snapshot);
test("snapshot joins all pages and retains explicit demo provenance", async () => {
  assert.equal((await reader.manifest()).source, "demo");
  const rows = await reader.pools({ pageSize: 100 });
  assert.equal(rows.total, 12);
  for (const row of rows.items) {
    const detail = await reader.pool(row.id);
    assert.ok(detail);
    assert.ok(detail.trades.length);
    assert.ok(await reader.wallet(row.creator));
  }
});
test("search types addresses and transaction hashes and preserves deep links", async () => {
  assert.equal(
    (await reader.search(snapshot.pools[0].symbol))[0].type,
    "Token",
  );
  const tx = await reader.search(snapshot.trades[0].txHash);
  assert.equal(tx[0].type, "Transaction");
  assert.ok(tx[0].href.includes("?tx="));
  assert.equal(
    (await reader.search(snapshot.identities[0].address)).some(
      (r) => r.type === "Wallet",
    ),
    true,
  );
});
test("leaderboard is precisely sorted and uses only eligible instant-pool activity", async () => {
  for (const window of ["24h", "7d"] as const) {
    const board = await reader.leaderboard(window);
    assert.equal(board.total, 8);
    for (let i = 0; i < board.items.length; i++) {
      const row = board.items[i];
      assert.ok(row.eligible);
      assert.ok(row.trades >= 10);
      if (i)
        assert.ok(
          BigInt(board.items[i - 1].realizedWei) >= BigInt(row.realizedWei),
        );
      const wallet = await reader.wallet(row.address);
      assert.equal(wallet?.summary[window].realizedWei, row.realizedWei);
    }
  }
});
test("pagination, empty searches, unknown wallets, and creator aggregation are bounded", async () => {
  assert.equal((await reader.pools({ page: 2, pageSize: 10 })).items.length, 2);
  assert.equal((await reader.pools({ search: "not-a-token" })).total, 0);
  assert.equal(
    await reader.wallet("0x0000000000000000000000000000000000000000"),
    null,
  );
  const creators = await reader.creators();
  assert.equal(creators.length, 4);
  assert.equal(creators.flatMap((c) => c.pools).length, 12);
});
test("published snapshots reject duplicates and orphan records", () => {
  assert.throws(
    () =>
      new SnapshotReader({
        ...snapshot,
        trades: [...snapshot.trades, snapshot.trades[0]],
      }),
    /Duplicate/,
  );
  assert.throws(
    () => new SnapshotReader({ ...snapshot, pools: [] }),
    /Unknown pool/,
  );
});
