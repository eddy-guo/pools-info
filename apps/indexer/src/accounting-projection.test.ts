import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  foldTrades,
  walletMetrics,
  type ChainSnapshot,
  type ChainWallet,
  type Trade,
  type PoolAudit,
  windows,
  type LiveWindow,
} from "@pools/core";
import {
  projectAccountingRows,
  type StoredPublication,
} from "./accounting-projection";
const hash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, "0")}`;
const pool = hash(1),
  wallet = address(2),
  excluded = address(3);
function trade(
  n: number,
  side: "buy" | "sell",
  eth: string,
  quantity: string,
  trader = wallet,
): Trade {
  return {
    id: `${hash(n + 100)}:0`,
    txHash: hash(n + 100),
    logIndex: 0,
    block: n + 10,
    timestamp: n * 100,
    poolId: pool,
    trader,
    side,
    ethWei: eth,
    tokenRaw: quantity,
  };
}
function publication(): StoredPublication {
  const supported = [
    trade(1, "buy", "1010", "10"),
    trade(2, "sell", "400", "3"),
    trade(3, "buy", "50", "2"),
    trade(4, "sell", "500", "4"),
    trade(5, "sell", "600", "5"),
  ];
  const unsupported = trade(6, "sell", "25", "1", excluded);
  const position = foldTrades(supported);
  const row: ChainWallet = {
    address: wallet,
    swaps: 5,
    buys: 2,
    sells: 3,
    volumeWei: "2560",
    realizedWei: position.realizedWei,
    inventoryRaw: "0",
    balanceRaw: "0",
    balanceMatches: true,
    eligible: false,
    flags: [],
    evidenceTx: supported.at(-1)!.txHash,
  };
  const snapshot: ChainSnapshot = {
    schemaVersion: 1,
    chainId: 4663,
    generatedAt: "2026-09-14T00:00:00.000Z",
    fromBlock: 10,
    toBlock: 30,
    fromTimestamp: 0,
    toTimestamp: 600,
    blockHash: hash(30),
    discoveredLaunches: 1,
    requests: 0,
    durationMs: 0,
    reconciliation: null,
    markets: [
      {
        id: pool,
        token: address(4),
        name: "Test",
        symbol: "TEST",
        decimals: 0,
        supply: "1000",
        launchBlock: 10,
        launchedAt: 0,
        launchTx: hash(10),
        launchSender: wallet,
        positionRecipient: wallet,
        strategy: address(5),
        creatorFees: false,
        fee: 2500,
        priceWei: "5",
        volumeWei: "2585",
        swaps: 6,
        buys: 2,
        sells: 4,
        series: [
          { time: 100, wei: "101" },
          { time: 400, wei: "125" },
          { time: 500, wei: "120" },
        ],
        accounting: {
          wallets: [
            row,
            {
              ...row,
              address: excluded,
              swaps: 1,
              buys: 0,
              sells: 1,
              volumeWei: "25",
              realizedWei: null,
              flags: ["unknown_basis"],
            },
          ],
          executions: [...supported, unsupported].map((t) => ({
            trade: t,
            flags: [],
            matchedTransfer: t.id,
          })),
          unattributedSwaps: 0,
          transfersChecked: 6,
        },
      },
    ],
    trades: [...supported, unsupported].map(({ trader: _, id: __, ...t }) => t),
  };
  return {
    snapshot,
    holders: null,
    liquidityWei: null,
    sourceKind: "indexed",
    generatedAt: snapshot.generatedAt,
  };
}

test("normalized sale gains preserve exact carry basis, partial sales and whole-cycle holds", () => {
  const input = publication(),
    projected = projectAccountingRows(input);
  const supported = projected.positions.find((p) => p.wallet === wallet)!;
  assert.equal(supported.realized_wei, "440");
  assert.equal(supported.quantity_raw, "0");
  assert.equal(supported.cost_wei, "0");
  assert.deepEqual(
    projected.trades
      .filter((t) => t.realized_wei !== null)
      .map((t) => [t.realized_wei, t.disposed_cost_wei]),
    [
      ["97", "303"],
      ["164", "336"],
      ["179", "421"],
    ],
  );
  assert.deepEqual(
    projected.trades
      .filter((t) => t.closed_gain_wei !== null)
      .map((t) => [t.closed_gain_wei, t.closed_hold_seconds]),
    [["440", 400]],
  );
  const audit: PoolAudit = {
    poolId: pool,
    toBlock: 30,
    toTimestamp: 3850,
    generatedAt: input.generatedAt,
    market: input.snapshot.markets[0],
    wallets: input.snapshot.markets[0].accounting!.wallets,
    executions: input.snapshot.markets[0].accounting!.executions!,
    unattributedSwaps: 0,
    transfersChecked: 6,
  };
  // Window starts at250: the purchase at100 still supplies the sold basis.
  const current = walletMetrics(audit, wallet, "1h")!;
  assert.equal(current.realizedWei, "343");
  assert.equal(
    projected.trades
      .filter((t) => t.timestamp >= 250 && t.realized_wei !== null)
      .reduce((n, t) => n + BigInt(t.realized_wei!), 0n)
      .toString(),
    current.realizedWei,
  );
  assert.equal(current.netWei, "1050");
  assert.equal(current.avgHold, 400);
  assert.equal(projected.market.id, pool);
  assert.equal("accounting" in projected.market, false);
  assert.equal("series" in projected.market, false);
});

test("excluded positions retain observed activity and flags without invented financials", () => {
  const projected = projectAccountingRows(publication());
  const position = projected.positions.find((p) => p.wallet === excluded)!;
  assert.equal(position.supported, false);
  assert.ok(position.flags.includes("unknown_basis"));
  for (const field of [
    "quantity_raw",
    "cost_wei",
    "realized_wei",
    "unrealized_wei",
    "invested_wei",
    "proceeds_wei",
  ] as const)
    assert.equal(position[field], null);
  const observed = projected.trades.find((t) => t.wallet === excluded)!;
  assert.equal(observed.eth_wei, "25");
  assert.equal(observed.execution!.trade.trader, excluded);
  assert.equal(observed.realized_wei, null);
  assert.equal(observed.closed_hold_seconds, null);
});

test("canonical dedup is stable, conflicting or unpaired executions fail closed", () => {
  const input = publication();
  input.snapshot.trades.push(structuredClone(input.snapshot.trades[0]));
  input.snapshot.markets[0].accounting!.executions!.push(
    structuredClone(input.snapshot.markets[0].accounting!.executions![0]),
  );
  const projected = projectAccountingRows(input);
  assert.equal(projected.trades.length, 6);
  assert.equal(projected.positions[0].realized_wei, "440");
  input.snapshot.trades.at(-1)!.ethWei = "1";
  assert.throws(
    () => projectAccountingRows(input),
    /Conflicting analytics trade/,
  );
  const missing = publication();
  missing.snapshot.trades.shift();
  assert.throws(() => projectAccountingRows(missing), /execution_mismatch/);
});

test("mark prices and integer-scale amounts remain exact beyond Number precision", () => {
  const input = publication();
  const huge = 10n ** 40n + 3n;
  const t = trade(1, "buy", huge.toString(), "3");
  const accounting = input.snapshot.markets[0].accounting!;
  accounting.executions = [{ trade: t, flags: [], matchedTransfer: t.id }];
  accounting.wallets = [
    {
      ...accounting.wallets[0],
      swaps: 1,
      buys: 1,
      sells: 0,
      volumeWei: huge.toString(),
      realizedWei: "0",
      inventoryRaw: "3",
      balanceRaw: "3",
    },
  ];
  input.snapshot.trades = [t];
  input.snapshot.markets[0].priceWei = huge.toString();
  const projected = projectAccountingRows(input);
  assert.equal(projected.positions[0].unrealized_wei, (huge * 2n).toString());
  assert.equal(projected.positions[0].cost_wei, huge.toString());
  assert.equal(projected.trades[0].eth_wei, huge.toString());
  input.snapshot.markets[0].priceWei = null;
  assert.equal(projectAccountingRows(input).positions[0].unrealized_wei, null);
});

test("real captured corpus preserves every supported wallet realization across all windows", () => {
  const saved = JSON.parse(
    readFileSync(
      new URL("../../../data/pools/index.json", import.meta.url),
      "utf8",
    ),
  ) as { snapshots: Record<string, ChainSnapshot> };
  let compared = 0;
  for (const snapshot of Object.values(saved.snapshots)) {
    const projected = projectAccountingRows({
      snapshot,
      holders: null,
      liquidityWei: null,
      sourceKind: "rpc_capture",
      generatedAt: snapshot.generatedAt,
    });
    const market = snapshot.markets[0];
    if (!market.accounting) continue;
    const audit: PoolAudit = {
      poolId: market.id,
      toBlock: snapshot.toBlock,
      toTimestamp: snapshot.toTimestamp + 300,
      generatedAt: snapshot.generatedAt,
      market,
      wallets: market.accounting.wallets,
      executions: market.accounting.executions ?? [],
      unattributedSwaps: market.accounting.unattributedSwaps,
      transfersChecked: market.accounting.transfersChecked,
    };
    for (const p of projected.positions) {
      const events = projected.trades.filter((t) => t.wallet === p.wallet);
      for (const window of Object.keys(windows) as LiveWindow[]) {
        const metrics = walletMetrics(audit, p.wallet, window)!;
        const from = audit.toTimestamp - windows[window];
        const selected = events.filter((t) => t.timestamp >= from);
        assert.equal(
          selected.reduce((sum, t) => sum + BigInt(t.eth_wei), 0n).toString(),
          metrics.volumeWei,
        );
        if (!p.supported) continue;
        compared++;
        const gains = selected.filter((t) => t.realized_wei !== null);
        assert.equal(
          gains
            .reduce((sum, t) => sum + BigInt(t.realized_wei!), 0n)
            .toString(),
          metrics.realizedWei,
        );
        assert.equal(
          selected
            .filter((t) => t.execution_supported)
            .reduce(
              (sum, t) =>
                sum + (t.side === "sell" ? 1n : -1n) * BigInt(t.eth_wei),
              0n,
            )
            .toString(),
          metrics.netWei,
        );
        const closures = selected.filter((t) => t.closed_hold_seconds !== null);
        assert.equal(
          closures.filter((t) => BigInt(t.closed_gain_wei!) > 0n).length,
          metrics.wins,
        );
        assert.equal(
          closures.filter((t) => BigInt(t.closed_gain_wei!) < 0n).length,
          metrics.losses,
        );
        assert.equal(
          closures.length
            ? closures.reduce((sum, t) => sum + t.closed_hold_seconds!, 0) /
                closures.length
            : null,
          metrics.avgHold,
        );
        assert.equal(p.unrealized_wei, metrics.unrealizedWei);
      }
    }
  }
  assert.ok(
    compared > 100,
    "Compare the populated real corpus, not an empty fixture",
  );
});
