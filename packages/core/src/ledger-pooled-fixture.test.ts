// The recorded pooled sell (fixtures/README.md) through the attribution rule:
// under rule 1 one unattributed swap that excludes all 147 contributors,
// under rule 2 one pooled swap whose 147 shares are each contributor's own
// movement and its pro-rata share of the 6.000424 ETH, summing exactly. The
// audited wallet 0x0b75…f928 (figures audit, section 3.6) is reconciled to
// the wei against the row the dump holds for it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  applyLedgerEvents,
  createLedgerState,
  ledgerIdentitiesHold,
  ledgerKeys,
  planLedgerBatch,
  positionKey,
  type LedgerSwap,
  type LedgerTransfer,
} from "./ledger";

interface Fixture {
  txHash: string;
  block: number;
  blockHash: string;
  timestamp: number;
  from: string;
  to: string;
  registry: { poolId: string; token: string }[];
  swap: {
    logIndex: number;
    poolId: string;
    token: string;
    side: "buy" | "sell";
    ethWei: string;
    tokenRaw: string;
    sqrtPriceX96: string;
    liquidity: string;
    tick: number;
  };
  transfers: { logIndex: number; from: string; to: string; value: string }[];
}
const fixture: Fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/pooled-swap-70274936.json", import.meta.url),
    "utf8",
  ),
);
const rules = {
  manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
};
const site = {
  txHash: fixture.txHash,
  block: fixture.block,
  blockHash: fixture.blockHash,
  timestamp: fixture.timestamp,
};
const swap: LedgerSwap = {
  ...site,
  logIndex: fixture.swap.logIndex,
  poolId: fixture.swap.poolId,
  token: fixture.swap.token,
  initiator: fixture.from,
  txTo: fixture.to,
  side: fixture.swap.side,
  ethWei: fixture.swap.ethWei,
  tokenRaw: fixture.swap.tokenRaw,
  sqrtPriceX96: fixture.swap.sqrtPriceX96,
  liquidity: fixture.swap.liquidity,
  tick: fixture.swap.tick,
};
const transfers: LedgerTransfer[] = fixture.transfers.map((t) => ({
  ...site,
  logIndex: t.logIndex,
  token: fixture.swap.token,
  from: t.from,
  to: t.to,
  value: t.value,
}));
const rows = { swaps: [swap], transfers, registry: fixture.registry };
const batchSeller = fixture.to.toLowerCase();
const audited = "0x0b7576fec0a6df4e608f2befc4899c1890f0f928";
const ethWei = BigInt(fixture.swap.ethWei),
  tokenRaw = BigInt(fixture.swap.tokenRaw);
/** Each contributor's net movement into the batch contract. */
const contributions = new Map<string, bigint>();
for (const t of transfers) {
  const v = BigInt(t.value);
  contributions.set(t.from, (contributions.get(t.from) ?? 0n) - v);
  contributions.set(t.to, (contributions.get(t.to) ?? 0n) + v);
}

test("the recorded transaction's legs are the pooled shape: 147 contributors, a pass-through contract and the manager", () => {
  assert.equal(fixture.swap.side, "sell");
  assert.equal(ethWei, 6000423542526057991n);
  assert.equal(tokenRaw, 695318196600284811784538416n);
  assert.equal(transfers.length, 149);
  assert.equal(contributions.get(batchSeller), 0n);
  assert.equal(contributions.get(rules.manager), tokenRaw);
  const movers = [...contributions].filter(
    ([a, n]) => n !== 0n && a !== rules.manager,
  );
  assert.equal(movers.length, 147);
  assert.ok(movers.every(([, n]) => n < 0n));
  assert.equal(
    movers.reduce((sum, [, n]) => sum - n, 0n),
    tokenRaw,
  );
  assert.equal(contributions.get(audited), -4423505173832408206622297n);
  // The sender is one of the contributors, and tx.to is the batch contract.
  assert.ok(contributions.get(fixture.from.toLowerCase())! < 0n);
  assert.notEqual(fixture.to.toLowerCase(), rules.router);
});

test("rule 1 leaves the recorded pooled sell unattributed and excludes all 147 contributors", () => {
  const events = planLedgerBatch(rows, rules);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "unattributed_swap");
  const wallets = (events[0] as { wallets: string[] }).wallets;
  assert.equal(wallets.length, 147);
  assert.ok(!wallets.includes(batchSeller));
  const state = createLedgerState();
  const { liveTrades } = applyLedgerEvents(state, events);
  assert.equal(state.positions.size, 147);
  for (const p of state.positions.values()) {
    assert.equal(p.supported, false);
    assert.deepEqual(p.flags, ["unattributed_swap_activity"]);
    assert.equal(p.sells, 0);
  }
  assert.deepEqual(
    liveTrades.map((t) => [t.wallet, t.attribution]),
    [[null, "unattributed"]],
  );
});

test("rule 2 attributes the recorded pooled sell to its 147 contributors pro rata, the audited wallet's share reconciling to the wei", () => {
  const events = planLedgerBatch(rows, { ...rules, pooledSwaps: true });
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, "pooled_swap");
  if (e.kind !== "pooled_swap") throw Error("unreachable");
  assert.equal(e.shares.length, 147);
  assert.equal(e.wrapper, true);
  assert.equal(
    e.shares.reduce((sum, s) => sum + s.ethWei, 0n),
    ethWei,
  );
  assert.equal(
    e.shares.reduce((sum, s) => sum + s.tokenRaw, 0n),
    tokenRaw,
  );
  let extra = 0n;
  for (const s of e.shares) {
    assert.equal(s.tokenRaw, -contributions.get(s.wallet)!);
    const floor = (ethWei * s.tokenRaw) / tokenRaw;
    assert.ok(s.ethWei === floor || s.ethWei === floor + 1n);
    extra += s.ethWei - floor;
  }
  assert.ok(extra < 147n);
  // The audited wallet moved 4,423,505.17 CS of the 695,318,196.60 sold:
  // 0.636181% of the swap, 38,173,752,269,579,151 wei of its 6.000424 ETH
  // (its exact share lost 0.23 wei to truncation, so the remainder rule
  // leaves it at the integer part).
  const mine = e.shares.find((s) => s.wallet === audited)!;
  assert.deepEqual(mine, {
    wallet: audited,
    tokenRaw: 4423505173832408206622297n,
    ethWei: 38173752269579151n,
  });
  // The sender's share is its own movement's, no more: 25,743,524.88 CS,
  // whose exact share lost 0.51 wei to truncation and so took one of the
  // wei the remainder rule hands back (the integer part is …173).
  const sender = e.shares.find((s) => s.wallet === fixture.from.toLowerCase())!;
  assert.equal(sender.tokenRaw, 25743524877928631845564850n);
  assert.equal(sender.ethWei, 222160233257823174n);
  // Folded after the wallet's recorded buy (the dump's row: 4,423,505.17 CS
  // for 0.0495 ETH at block 70,274,240, unchanged by the pooled sell under
  // rule 1), the position closes at its share: proceeds 0.038174 ETH
  // against 0.0495 ETH of cost, a realized loss of 0.011326 ETH, supported,
  // one pooled sale through the batch contract.
  const state = createLedgerState();
  const buy = {
    kind: "swap" as const,
    txHash: "0x" + "b".repeat(64),
    logIndex: 0,
    block: 70274240,
    blockHash: "0x" + "c".repeat(64),
    timestamp: 1790142392,
    poolId: fixture.swap.poolId,
    wallet: audited,
    attribution: "initiator" as const,
    wrapper: true,
    side: "buy" as const,
    ethWei: 49500000000000000n,
    tokenRaw: 4423505173832408206622297n,
    sqrtPriceX96: 1n,
    liquidity: 1n,
    tick: 0,
    initiator: audited,
  };
  applyLedgerEvents(state, [buy]);
  const { sales, liveTrades } = applyLedgerEvents(state, events);
  const p = state.positions.get(positionKey(fixture.swap.poolId, audited))!;
  assert.ok(ledgerIdentitiesHold(p));
  assert.deepEqual(
    {
      supported: p.supported,
      flags: p.flags,
      buys: p.buys,
      sells: p.sells,
      pooledSwaps: p.pooledSwaps,
      quantity: p.quantity,
      cost: p.cost,
      invested: p.invested,
      proceeds: p.proceeds,
      disposedCost: p.disposedCost,
      realized: p.realized,
      boughtRaw: p.boughtRaw,
      soldRaw: p.soldRaw,
      closedCycles: p.closedCycles,
    },
    {
      supported: true,
      flags: ["pooled_route", "wrapper_route"],
      buys: 1,
      sells: 1,
      pooledSwaps: 1,
      quantity: 0n,
      cost: 0n,
      invested: 49500000000000000n,
      proceeds: 38173752269579151n,
      disposedCost: 49500000000000000n,
      realized: -11326247730420849n,
      boughtRaw: 4423505173832408206622297n,
      soldRaw: 4423505173832408206622297n,
      closedCycles: 1,
    },
  );
  assert.equal(sales.length, 147);
  assert.ok(sales.every((s) => s.wallet !== batchSeller));
  assert.equal(state.positions.size, 147);
  for (const q of state.positions.values()) assert.ok(ledgerIdentitiesHold(q));
  assert.deepEqual(
    liveTrades.map((t) => [t.wallet, t.attribution, t.ethWei]),
    [[null, "pooled", ethWei]],
  );
  // The hour holds the wallet's buy and the one pooled sell, with 147
  // sellers: one trade for the pool, one sale per contributor.
  const hour = [...state.poolHours.values()][0];
  assert.deepEqual(
    [hour.trades, hour.buys, hour.sells, hour.sellers, hour.unattributed, hour.volume],
    [2, 1, 1, 147, 0, ethWei + 49500000000000000n],
  );
  assert.equal(ledgerKeys(events).positions.length, 147);
});
