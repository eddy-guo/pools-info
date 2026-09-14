import test from "node:test";
import assert from "node:assert/strict";
import { walletMetrics, poolWindow } from "./live-analytics";
import { reconcileWallets, type ObservedExecution } from "./chain-accounting";
import type { PoolAudit, ChainSnapshot, ChainMarket } from "./chain-types";
import chain from "../../../data/snapshots/chain.json";
const address = "0x1111111111111111111111111111111111111111" as const;
function audit(): PoolAudit {
  const market = {
    ...(chain.markets[0] as ChainMarket),
    launchedAt: 0,
    launchBlock: 0,
    decimals: 0,
    priceWei: "10000000000000000",
  };
  const executions: ObservedExecution[] = [
    {
      timestamp: 10,
      side: "buy",
      tokenRaw: "100",
      ethWei: "1000000000000000000",
    },
    {
      timestamp: 100000,
      side: "sell",
      tokenRaw: "40",
      ethWei: "600000000000000000",
    },
    {
      timestamp: 100100,
      side: "sell",
      tokenRaw: "60",
      ethWei: "900000000000000000",
    },
  ].map((t, i) => ({
    trade: {
      ...t,
      side: t.side as "buy" | "sell",
      id: String(i),
      block: i + 1,
      logIndex: 0,
      trader: address,
      poolId: market.id as `0x${string}`,
      txHash: `0x${String(i + 1).padStart(64, "0")}`,
    },
    flags: [],
    matchedTransfer: String(i),
  }));
  const movements = executions.map((e) => ({
    id: e.matchedTransfer!,
    from: e.trade.side === "buy" ? "pool" : address,
    to: e.trade.side === "buy" ? address : "pool",
    value: e.trade.tokenRaw,
  }));
  return {
    poolId: market.id,
    market,
    toBlock: 10,
    toTimestamp: 100200,
    generatedAt: new Date(100200000).toISOString(),
    wallets: reconcileWallets(executions, movements, new Map([[address, "0"]])),
    executions,
    transfersChecked: 3,
    unattributedSwaps: 0,
  };
}
test("rolling realized PnL carries prior cost while net ETH measures the selected cash flow", () => {
  const m = walletMetrics(audit(), address, "24h")!;
  assert.equal(m.realizedWei, "500000000000000000");
  assert.equal(m.netWei, "1500000000000000000");
  assert.equal(m.roi, 50);
  assert.equal(m.volumeWei, "1500000000000000000");
  assert.equal(m.trades.length, 2);
  assert.equal(m.wins, 1);
  assert.equal(m.losses, 0);
  assert.equal(m.avgHold, 100090);
  assert.equal(m.bestWei, "300000000000000000");
  assert.equal(m.curve.at(-1)?.wei, m.realizedWei);
});
test("unknown transfers invalidate all PnL windows and marks, never fabricate a zero basis", () => {
  const a = audit();
  a.wallets[0].flags = ["unmatched_transfer"];
  a.wallets[0].realizedWei = null;
  const m = walletMetrics(a, address, "24h")!;
  assert.equal(m.complete, false);
  assert.equal(m.realizedWei, null);
  assert.equal(m.netWei, null);
  assert.equal(m.unrealizedWei, null);
  assert.deepEqual(m.curve, []);
  assert.equal(m.trades.length, 2);
  assert.equal(
    walletMetrics(a, "0x2222222222222222222222222222222222222222"),
    null,
  );
});
test("unrealized marks use remaining inventory cost and cannot count an open position as a win", () => {
  const a = audit();
  a.executions = a.executions.slice(0, 2);
  a.wallets[0].realizedWei = "200000000000000000";
  a.market.priceWei = "20000000000000000";
  const m = walletMetrics(a, address)!;
  assert.equal(m.valueWei, "1200000000000000000");
  assert.equal(m.unrealizedWei, "600000000000000000");
  assert.equal(m.winRate, null);
  assert.equal(m.avgHold, null);
});
test("pool windows use cutoff-based swaps and do not invent an unavailable opening price", () => {
  const s = structuredClone(chain) as ChainSnapshot;
  const m = s.markets[0];
  s.toTimestamp = 100000;
  m.launchedAt = 0;
  m.series = [{ time: 99999, wei: "20" }];
  s.trades = [
    {
      poolId: m.id,
      txHash: "0x1",
      logIndex: 0,
      block: 1,
      timestamp: 99999,
      side: "buy",
      ethWei: "10",
      tokenRaw: "1",
    },
  ];
  assert.equal(poolWindow(m, s, "1h").change, null);
  assert.equal(poolWindow(m, s, "1h").volumeWei, "10");
  m.series.unshift({ time: 96000, wei: "10" });
  assert.equal(poolWindow(m, s, "1h").change, 100);
});
