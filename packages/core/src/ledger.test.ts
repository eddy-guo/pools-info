import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { foldTrades } from "./accounting";
import { walletMetrics } from "./live-analytics";
import type { ObservedExecution } from "./chain-accounting";
import type { ChainSnapshot, PoolAudit } from "./chain-types";
import type { Trade } from "./types";
import {
  applyLedgerEvents,
  createLedgerState,
  ledgerHour,
  ledgerIdentitiesHold,
  ledgerKeys,
  ledgerZeroAddress,
  planLedgerBatch,
  positionKey,
  type LedgerEvent,
  type LedgerPosition,
  type LedgerState,
  type LedgerSwap,
  type LedgerTransfer,
} from "./ledger";
import chain from "../../../data/snapshots/chain.json";

const E = 10n ** 18n;
const rules = {
  manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  router: "0x8876789976decbfcbbbe364623c63652db8c0904",
};
const hash = (n: number | bigint) =>
  `0x${n.toString(16).padStart(64, "0")}` as const;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as const;
const pool = hash(0x100);
const token = addr(0x200);
const wallet = addr(0x300);
function trade(
  index: number,
  side: "buy" | "sell",
  ethWei: bigint,
  tokens: bigint,
  trader: string = wallet,
): Trade {
  return {
    id: `tx${index}:0`,
    txHash: hash(index),
    logIndex: 0,
    block: index,
    timestamp: index * 100,
    poolId: pool,
    trader: trader as `0x${string}`,
    side,
    ethWei: ethWei.toString(),
    tokenRaw: tokens.toString(),
  };
}
/** Direct swap events for trades already attributed to their trader, the way
 * every stored execution is: the position machine alone is under test. */
function swapEvents(trades: readonly Trade[]): LedgerEvent[] {
  return [...trades]
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)
    .map((t) => ({
      kind: "swap" as const,
      txHash: t.txHash.toLowerCase(),
      logIndex: t.logIndex,
      block: t.block,
      blockHash: hash(t.block),
      timestamp: t.timestamp,
      poolId: t.poolId.toLowerCase(),
      wallet: t.trader.toLowerCase(),
      attribution: "initiator" as const,
      wrapper: false,
      side: t.side,
      ethWei: BigInt(t.ethWei),
      tokenRaw: BigInt(t.tokenRaw),
      sqrtPriceX96: 1n,
      liquidity: 1n,
      tick: 0,
      initiator: t.trader.toLowerCase(),
    }));
}
function stateHolds(state: LedgerState) {
  for (const p of state.positions.values())
    assert.ok(ledgerIdentitiesHold(p), `identities broken for ${p.wallet}`);
  for (const h of state.walletHours.values())
    assert.equal(h.realized, h.proceeds - h.disposedCost);
}
/** Fold one position through the ledger one event at a time and compare it
 * with foldTrades over the same trades. */
function assertSameAsFold(trades: readonly Trade[], label = "fixture") {
  const events = swapEvents(trades);
  const state = createLedgerState();
  const sales = [];
  for (const e of events) {
    sales.push(...applyLedgerEvents(state, [e]).sales);
    stateHolds(state);
  }
  const whole = createLedgerState();
  const once = applyLedgerEvents(whole, events);
  assert.deepEqual(whole, state, `${label}: one-shot and stepwise differ`);
  assert.deepEqual(once.sales, sales);
  const old = foldTrades([...trades]);
  const p = state.positions.get(
    positionKey(old.poolId.toLowerCase(), old.trader.toLowerCase()),
  )!;
  assert.equal(p.quantity.toString(), old.quantity, `${label}: quantity`);
  assert.equal(p.cost.toString(), old.costWei, `${label}: cost`);
  assert.equal(p.invested.toString(), old.investedWei, `${label}: invested`);
  assert.equal(p.proceeds.toString(), old.proceedsWei, `${label}: proceeds`);
  assert.equal(p.buys, old.buys);
  assert.equal(p.sells, old.sells);
  assert.equal(
    p.supported ? p.realized.toString() : null,
    old.realizedWei,
    `${label}: realized`,
  );
  assert.equal(
    p.flags.includes("unknown_basis"),
    old.flags.includes("unknown_basis"),
  );
  assert.deepEqual(
    p.supported ? old.realizations : [],
    p.supported
      ? sales.map((s) => ({
          timestamp: s.timestamp,
          wei: s.realized.toString(),
        }))
      : [],
    `${label}: per-sale realized`,
  );
  return { state, position: p, sales, old };
}

test("the incremental position reproduces foldTrades on the accounting fixtures", () => {
  const partial = assertSameAsFold(
    [trade(1, "buy", E, 100n), trade(2, "sell", (E * 6n) / 10n, 40n)],
    "partial sale",
  );
  assert.equal(partial.position.quantity, 60n);
  assert.equal(partial.position.realized, E / 5n);
  assertSameAsFold(
    [
      trade(1, "buy", E, 100n),
      trade(2, "sell", (E * 6n) / 10n, 40n),
      trade(3, "sell", (E * 9n) / 10n, 60n),
    ],
    "windowed",
  );
  const oversold = assertSameAsFold(
    [trade(1, "buy", E, 100n), trade(2, "sell", E * 3n, 150n)],
    "oversold",
  );
  assert.equal(oversold.position.supported, false);
  assert.deepEqual(oversold.position.flags, ["unknown_basis"]);
  assert.equal(oversold.position.quantity, 0n);
  assertSameAsFold(
    [
      trade(1, "sell", E, 100n),
      trade(2, "buy", E, 100n),
      trade(3, "sell", E * 2n, 100n),
    ],
    "sell first",
  );
  const qty = 2n ** 200n,
    cost = 2n ** 180n + 7n;
  const huge = assertSameAsFold(
    [
      trade(1, "buy", cost, qty),
      trade(2, "sell", cost / 3n, qty / 3n),
      trade(3, "sell", cost, qty - qty / 3n),
    ],
    "rounding residue",
  );
  assert.equal(huge.position.quantity, 0n);
  assert.equal(huge.position.cost, 0n);
  assert.equal(huge.position.realized, cost / 3n);
  // chain-accounting.test.ts and live-analytics.test.ts executions.
  assertSameAsFold(
    [trade(1, "buy", E, 10n), trade(2, "sell", (E * 8n) / 10n, 5n)],
    "reconciled movements",
  );
  assertSameAsFold(
    [
      trade(1, "buy", E, 100n),
      trade(2, "sell", (E * 6n) / 10n, 40n),
      trade(3, "sell", (E * 9n) / 10n, 60n),
    ],
    "rolling window",
  );
  // apps/api accounting.integration.test.ts definitions.
  for (let i = 1; i <= 5; i++) {
    const rows = [
      trade(1, "buy", i === 1 ? 900719925474099300001n : 100n, 100n),
      trade(
        2,
        "sell",
        i === 1 ? 900719925474099300003n : i === 2 ? 100n : 150n,
        i === 1 ? 50n : 100n,
      ),
    ];
    if (i === 4) rows.push(trade(3, "buy", 1000n, 100n));
    assertSameAsFold(rows, `api wallet ${i}`);
  }
});

test("random histories, including oversells and giant amounts, fold identically", () => {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 400; round++) {
    const trades: Trade[] = [];
    const length = 1 + Math.floor(random() * 12);
    for (let i = 1; i <= length; i++) {
      const scale = random() < 0.2 ? 2n ** 150n : 1n;
      trades.push(
        trade(
          i,
          random() < 0.55 ? "buy" : "sell",
          (1n + BigInt(Math.floor(random() * 1e9))) * scale,
          (1n + BigInt(Math.floor(random() * 1000))) * scale,
        ),
      );
    }
    assertSameAsFold(trades, `random ${round}`);
  }
});

function snapshotAudits(snapshot: ChainSnapshot): PoolAudit[] {
  return snapshot.markets
    .filter((m) => m.accounting?.executions?.length)
    .map((m) => ({
      poolId: m.id,
      toBlock: snapshot.toBlock,
      toTimestamp: snapshot.toTimestamp,
      generatedAt: snapshot.generatedAt,
      market: m,
      wallets: m.accounting!.wallets,
      executions: m.accounting!.executions!,
      unattributedSwaps: m.accounting!.unattributedSwaps,
      transfersChecked: m.accounting!.transfersChecked,
    }));
}
function loadPepe() {
  const raw = gunzipSync(
    readFileSync(
      new URL("../../../data/analytics/pepe-capture.json.gz", import.meta.url),
    ),
  );
  return JSON.parse(raw.toString()) as {
    snapshot: ChainSnapshot;
    evidence: {
      swaps: RawLog[];
      transfers: RawLog[];
      receipts: {
        transactionHash: string;
        from: string;
        to: string | null;
        status: string;
      }[];
      blocks: { number: string; timestamp: string }[];
    };
  };
}
interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  logIndex: string;
}
/** Every stored execution of every snapshot fixture, folded per position both
 * ways; the closure metrics of every complete wallet compared with
 * walletMetrics over the whole history. */
function assertSnapshotFolds(snapshot: ChainSnapshot, label: string) {
  let positions = 0,
    complete = 0;
  for (const audit of snapshotAudits(snapshot)) {
    const byTrader = new Map<string, ObservedExecution[]>();
    for (const e of audit.executions) {
      const key = e.trade.trader.toLowerCase();
      if (!byTrader.has(key)) byTrader.set(key, []);
      byTrader.get(key)!.push(e);
    }
    for (const [trader, executions] of byTrader) {
      const supported = executions
        .filter((e) => !e.flags.length)
        .map((e) => e.trade);
      if (!supported.length) continue;
      positions++;
      const { state } = assertSameAsFold(supported, `${label} ${trader}`);
      const metrics = walletMetrics(audit, trader, "All");
      if (!metrics?.complete) continue;
      complete++;
      const hours = [...state.walletHours.values()].filter(
        (h) => h.wallet === trader,
      );
      const sum = (pick: (h: (typeof hours)[number]) => bigint) =>
        hours.reduce((n, h) => n + pick(h), 0n);
      const count = (pick: (h: (typeof hours)[number]) => number) =>
        hours.reduce((n, h) => n + pick(h), 0);
      assert.equal(sum((h) => h.realized).toString(), metrics.realizedWei);
      assert.equal(
        (sum((h) => h.proceeds) - sum((h) => h.spent)).toString(),
        metrics.netWei,
      );
      assert.equal(sum((h) => h.volume).toString(), metrics.volumeWei);
      assert.equal(
        count((h) => h.supportedTrades),
        metrics.trades.length,
      );
      assert.equal(
        count((h) => h.wins),
        metrics.wins,
      );
      assert.equal(
        count((h) => h.losses),
        metrics.losses,
      );
      const closures = count((h) => h.closures);
      assert.equal(
        closures ? count((h) => h.holdSeconds) / closures : null,
        metrics.avgHold,
      );
      const best = hours.reduce<bigint | null>(
        (n, h) => (h.best !== null && (n === null || h.best > n) ? h.best : n),
        null,
      );
      assert.equal(best?.toString() ?? null, metrics.bestWei);
    }
  }
  return { positions, complete };
}
test("every position of the chain snapshot and the pepe capture folds identically, with walletMetrics' closures", () => {
  assert.deepEqual(
    assertSnapshotFolds(chain as unknown as ChainSnapshot, "chain.json"),
    { positions: 24, complete: 18 },
  );
  assert.deepEqual(assertSnapshotFolds(loadPepe().snapshot, "pepe"), {
    positions: 342,
    complete: 341,
  });
});

test("hour rows carry the closure metrics walletMetrics computes for a window", () => {
  // The live-analytics fixture: buy at 10, sell 40 at 100000, sell 60 at 100100.
  const trades = [
    { ...trade(1, "buy", E, 100n), timestamp: 10 },
    { ...trade(2, "sell", (E * 6n) / 10n, 40n), timestamp: 100000 },
    { ...trade(3, "sell", (E * 9n) / 10n, 60n), timestamp: 100100 },
  ];
  const state = createLedgerState();
  const { sales } = applyLedgerEvents(state, swapEvents(trades));
  const rows = [...state.walletHours.values()];
  assert.deepEqual<unknown>(
    rows.map((h) => [
      h.hour,
      h.buys,
      h.sells,
      h.spent,
      h.proceeds,
      h.realized,
      h.wins,
      h.closures,
      h.holdSeconds,
      h.best,
    ]),
    [
      [0, 1, 0, E, 0n, 0n, 0, 0, 0, null],
      [27, 0, 2, 0n, (E * 15n) / 10n, E / 2n, 1, 1, 100090, (E * 3n) / 10n],
    ],
  );
  assert.deepEqual<unknown>(
    sales.map((s) => [s.realized, s.closedGain, s.closedHoldSeconds]),
    [
      [E / 5n, null, null],
      [(E * 3n) / 10n, E / 2n, 100090],
    ],
  );
  const p = state.positions.get(positionKey(pool, wallet))!;
  assert.equal(p.cycleOpenedAt, null);
  assert.equal(p.quantity, 0n);
});

function swap(
  n: number,
  fields: Omit<Partial<LedgerSwap>, "side" | "ethWei" | "tokenRaw"> & {
    side: "buy" | "sell";
    ethWei: bigint;
    tokenRaw: bigint;
  },
): LedgerSwap {
  return {
    txHash: hash(n),
    logIndex: 10,
    block: n,
    blockHash: hash(n + 5000000),
    timestamp: n * 1000,
    poolId: pool,
    token,
    initiator: wallet,
    txTo: rules.router,
    sqrtPriceX96: "1000",
    liquidity: "5",
    tick: 1,
    ...fields,
    ethWei: fields.ethWei.toString(),
    tokenRaw: fields.tokenRaw.toString(),
  };
}
function transfer(
  n: number,
  logIndex: number,
  from: string,
  to: string,
  value: bigint,
  fields: Partial<LedgerTransfer> = {},
): LedgerTransfer {
  return {
    txHash: hash(n),
    logIndex,
    block: n,
    blockHash: hash(n + 5000000),
    timestamp: n * 1000,
    token,
    from,
    to,
    value: value.toString(),
    ...fields,
  };
}
const registry = [{ poolId: pool, token }];
function plan(swaps: LedgerSwap[], transfers: LedgerTransfer[]) {
  return planLedgerBatch({ swaps, transfers, registry }, rules);
}
function run(
  swaps: LedgerSwap[],
  transfers: LedgerTransfer[],
  state = createLedgerState(),
) {
  const events = plan(swaps, transfers);
  const keys = ledgerKeys(events);
  const application = applyLedgerEvents(state, events);
  stateHolds(state);
  // Everything the application changed was announced by the keys.
  for (const key of application.changed.positions)
    assert.ok(
      keys.positions.some((k) => positionKey(k.poolId, k.wallet) === key),
      key,
    );
  for (const key of application.changed.walletHours)
    assert.ok(
      keys.walletHours.some(
        (k) => `${k.wallet}:${k.poolId}:${k.hour}` === key,
      ) ||
        application.excluded.some((p) =>
          key.startsWith(`${p.wallet}:${p.poolId}:`),
        ),
      key,
    );
  for (const key of application.changed.poolHours)
    assert.ok(
      keys.poolHours.some((k) => `${k.poolId}:${k.hour}` === key),
      key,
    );
  for (const key of application.changed.pools)
    assert.ok(keys.pools.includes(key));
  return { events, keys, application, state };
}
const position = (state: LedgerState, w: string, p = pool) =>
  state.positions.get(positionKey(p, w))!;

test("the beneficiary is the address whose token flow matches, and the route is labelled", () => {
  const other = addr(0x301),
    wrapper = addr(0x400);
  // A direct buy: the initiator receives exactly the swapped amount.
  const direct = run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
  );
  assert.deepEqual(
    direct.events.map((e) => e.kind),
    ["swap"],
  );
  assert.equal(position(direct.state, wallet).supported, true);
  assert.deepEqual(position(direct.state, wallet).flags, []);
  assert.equal(direct.application.liveTrades[0].attribution, "initiator");
  // Through a wrapper contract: still the initiator, labelled wrapper_route.
  const routed = run(
    [swap(2, { side: "buy", ethWei: E, tokenRaw: 100n, txTo: wrapper })],
    [
      transfer(2, 11, rules.manager, wrapper, 100n),
      transfer(2, 12, wrapper, wallet, 100n),
    ],
  );
  assert.deepEqual(position(routed.state, wallet).flags, ["wrapper_route"]);
  assert.equal(position(routed.state, wallet).wrapperSwaps, 1);
  assert.equal(position(routed.state, wallet).supported, true);
  assert.equal(routed.state.positions.has(positionKey(pool, wrapper)), false);
  // A buy for a recipient: the initiator's balance did not change, the
  // recipient's did, so the recipient is the counterparty beneficiary.
  const gift = run(
    [swap(3, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(3, 11, rules.manager, other, 100n)],
  );
  assert.equal(gift.state.positions.has(positionKey(pool, wallet)), false);
  assert.deepEqual(position(gift.state, other).flags, ["counterparty_route"]);
  assert.equal(position(gift.state, other).counterpartySwaps, 1);
  assert.equal(position(gift.state, other).cost, E);
  assert.equal(gift.application.liveTrades[0].wallet, other);
  assert.equal(gift.application.liveTrades[0].attribution, "counterparty");
  // A contract creation has no tx.to: not the router, so a wrapper route.
  const created = run(
    [swap(4, { side: "buy", ethWei: E, tokenRaw: 100n, txTo: null })],
    [transfer(4, 11, rules.manager, wallet, 100n)],
  );
  assert.deepEqual(position(created.state, wallet).flags, ["wrapper_route"]);
});

test("remainders and third-party movements are inflows at zero cost or outflows with basis", () => {
  const other = addr(0x301),
    wrapper = addr(0x400);
  // The initiator receives the swapped 100 plus 20 from another holder in the
  // same transaction: 20 is an inflow at zero cost, the holder's 20 an outflow.
  const state = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n, initiator: other })],
    [transfer(1, 11, rules.manager, other, 100n)],
    state,
  );
  run(
    [swap(2, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [
      transfer(2, 11, rules.manager, wallet, 100n),
      transfer(2, 12, other, wallet, 20n),
    ],
    state,
  );
  const mine = position(state, wallet),
    theirs = position(state, other);
  assert.equal(mine.quantity, 120n);
  assert.equal(mine.cost, E);
  assert.equal(mine.inflow, 20n);
  assert.deepEqual(mine.flags, ["zero_cost_inflow"]);
  assert.equal(mine.supported, true);
  assert.equal(theirs.quantity, 80n);
  assert.equal(theirs.outflow, 20n);
  assert.equal(theirs.outflowCost, E / 5n);
  assert.equal(theirs.cost, (E * 4n) / 5n);
  assert.ok(ledgerIdentitiesHold(theirs));
  // A wrapper takes a fee cut on a sell: 100 leave the wallet, 90 reach the
  // manager for the swap, 10 stay with the wrapper. The wallet's remainder of
  // 10 is an outflow with proportional basis; the fee is not a sale.
  run(
    [
      swap(3, {
        side: "sell",
        ethWei: E * 2n,
        tokenRaw: 90n,
        txTo: wrapper,
      }),
    ],
    [
      transfer(3, 11, wallet, wrapper, 100n),
      transfer(3, 12, wrapper, rules.manager, 90n),
    ],
    state,
  );
  assert.equal(mine.quantity, 20n);
  assert.equal(mine.sells, 1);
  assert.equal(mine.outflow, 10n);
  assert.equal(mine.proceeds, E * 2n);
  assert.equal(mine.wrapperSwaps, 1);
  assert.deepEqual(mine.flags, ["wrapper_route", "zero_cost_inflow"]);
  assert.equal(mine.cost + mine.disposedCost + mine.outflowCost, mine.invested);
  assert.equal(state.positions.has(positionKey(pool, wrapper)), true);
  assert.equal(position(state, wrapper).inflow, 10n);
  // Selling the whole inventory takes the whole remaining cost, never a floor.
  run(
    [swap(4, { side: "sell", ethWei: E, tokenRaw: 20n })],
    [transfer(4, 11, wallet, rules.manager, 20n)],
    state,
  );
  assert.equal(mine.quantity, 0n);
  assert.equal(mine.cost, 0n);
  assert.equal(mine.cycleOpenedAt, null);
  stateHolds(state);
});

test("transfers outside a swap are zero-cost inflows and basis-removing outflows; mints and infrastructure never become wallets", () => {
  const other = addr(0x301),
    strategy = addr(0x500);
  const state = createLedgerState();
  // Launch mint: the zero address funds the strategy at zero cost.
  const mint = run(
    [],
    [transfer(1, 3, ledgerZeroAddress, strategy, 1000n)],
    state,
  );
  assert.deepEqual(
    mint.events.map((e) => e.kind),
    ["inflow"],
  );
  assert.equal(position(state, strategy).inflow, 1000n);
  assert.equal(
    state.positions.has(positionKey(pool, ledgerZeroAddress)),
    false,
  );
  assert.equal(state.positions.has(positionKey(pool, rules.manager)), false);
  assert.equal(state.pools.size, 0);
  run(
    [swap(2, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(2, 11, rules.manager, wallet, 100n)],
    state,
  );
  // A wallet-to-wallet move: proportional basis leaves, zero cost arrives.
  const move = run([], [transfer(3, 5, wallet, other, 25n)], state);
  assert.deepEqual(
    move.events.map((e) => [e.kind, (e as { wallet: string }).wallet]),
    [
      ["outflow", wallet],
      ["inflow", other],
    ],
  );
  assert.equal(position(state, wallet).quantity, 75n);
  assert.equal(position(state, wallet).cost, (E * 3n) / 4n);
  assert.equal(position(state, wallet).outflowCost, E / 4n);
  assert.equal(position(state, other).quantity, 25n);
  assert.equal(position(state, other).cost, 0n);
  assert.deepEqual(position(state, other).flags, ["zero_cost_inflow"]);
  // The recipient sells what arrived free: proceeds are real, basis is zero.
  run(
    [swap(4, { side: "sell", ethWei: E, tokenRaw: 25n, initiator: other })],
    [transfer(4, 11, other, rules.manager, 25n)],
    state,
  );
  assert.equal(position(state, other).realized, E);
  assert.equal(position(state, other).supported, true);
  // Transferring more than the ledger holds is an unknown basis: excluded.
  run([], [transfer(5, 5, wallet, other, 76n)], state);
  assert.equal(position(state, wallet).supported, false);
  assert.deepEqual(position(state, wallet).flags, ["unknown_basis"]);
  assert.equal(position(state, wallet).quantity, 0n);
  assert.ok(ledgerIdentitiesHold(position(state, wallet)));
  // Same-transaction round trips net to nothing: no event, no position.
  const passThrough = addr(0x600);
  const loop = run(
    [],
    [
      transfer(6, 1, other, passThrough, 5n),
      transfer(6, 2, passThrough, other, 5n),
    ],
    state,
  );
  assert.deepEqual(loop.events, []);
  assert.equal(state.positions.has(positionKey(pool, passThrough)), false);
});

test("unattributed swaps still count for the pool and exclude every position their token touched", () => {
  const bot = addr(0x700),
    other = addr(0x301);
  const state = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n, initiator: other })],
    [transfer(1, 11, rules.manager, other, 100n)],
    state,
  );
  // Two swaps of one pool in one transaction: an arbitrage loop. The bot
  // keeps 20 of the 50 it bought, so its balance moved and it is marked.
  const loop = run(
    [
      swap(2, {
        side: "buy",
        ethWei: E,
        tokenRaw: 50n,
        initiator: bot,
        logIndex: 10,
      }),
      swap(2, {
        side: "sell",
        ethWei: E * 2n,
        tokenRaw: 30n,
        initiator: bot,
        logIndex: 20,
      }),
    ],
    [
      transfer(2, 11, rules.manager, bot, 50n),
      transfer(2, 21, bot, rules.manager, 30n),
    ],
    state,
  );
  assert.deepEqual(
    loop.events.map((e) => e.kind),
    ["unattributed_swap", "unattributed_swap"],
  );
  assert.deepEqual(
    loop.application.liveTrades.map((t) => [t.wallet, t.attribution]),
    [
      [null, "unattributed"],
      [null, "unattributed"],
    ],
  );
  assert.deepEqual(position(state, bot).flags, ["unattributed_swap_activity"]);
  assert.equal(position(state, bot).supported, false);
  assert.equal(position(state, bot).buys + position(state, bot).sells, 0);
  assert.equal(position(state, bot).quantity, 0n, "nothing was applied");
  // A loop that nets to zero leaves the pool's counts and no position at all.
  const flat = addr(0x701);
  run(
    [
      swap(3, {
        side: "buy",
        ethWei: E,
        tokenRaw: 5n,
        initiator: flat,
        logIndex: 10,
      }),
      swap(3, {
        side: "sell",
        ethWei: E,
        tokenRaw: 5n,
        initiator: flat,
        logIndex: 20,
      }),
    ],
    [
      transfer(3, 11, rules.manager, flat, 5n),
      transfer(3, 21, flat, rules.manager, 5n),
    ],
    state,
  );
  assert.equal(state.positions.has(positionKey(pool, flat)), false);
  // Hour 0 holds the other wallet's attributed buy from block 1 and the
  // four unattributed swaps of both loops.
  const hour = state.poolHours.get(`${pool}:${ledgerHour(2000)}`)!;
  assert.equal(hour.trades, 5);
  assert.equal(hour.unattributed, 4);
  assert.equal(hour.volume, E * 6n);
  assert.equal(hour.buyers, 1);
  assert.equal(state.pools.get(pool)!.trades, 5);
  // No candidate at all (an ERC-6909 claim balance moved no ERC-20 token).
  const claim = run(
    [swap(4, { side: "buy", ethWei: E, tokenRaw: 10n, initiator: bot })],
    [],
    state,
  );
  assert.equal(claim.events[0].kind, "unattributed_swap");
  assert.deepEqual((claim.events[0] as { wallets: string[] }).wallets, []);
  // Two candidates and the initiator is neither: unattributed, both excluded.
  const a = addr(0x801),
    b = addr(0x802);
  run(
    [swap(5, { side: "buy", ethWei: E, tokenRaw: 10n, initiator: bot })],
    [
      transfer(5, 11, rules.manager, a, 10n),
      transfer(5, 12, rules.manager, b, 10n),
    ],
    state,
  );
  assert.equal(position(state, a).supported, false);
  assert.equal(position(state, b).supported, false);
  // The earlier supported wallet is untouched by transactions it was not in.
  assert.equal(position(state, other).supported, true);
  // A single candidate that is not the initiator is a counterparty, and the
  // other movements in that transaction apply normally.
  run(
    [swap(6, { side: "buy", ethWei: E, tokenRaw: 10n, initiator: bot })],
    [transfer(6, 11, rules.manager, a, 10n), transfer(6, 12, other, b, 1n)],
    state,
  );
  assert.equal(position(state, a).counterpartySwaps, 1);
  assert.equal(position(state, other).supported, true);
  assert.equal(position(state, other).quantity, 99n);
  // ...until its token moves inside an unattributed transaction: nothing of
  // that transaction is applied, every touched position is excluded.
  run(
    [swap(7, { side: "buy", ethWei: E, tokenRaw: 10n, initiator: bot })],
    [
      transfer(7, 11, rules.manager, a, 10n),
      transfer(7, 12, rules.manager, b, 10n),
      transfer(7, 13, other, b, 1n),
    ],
    state,
  );
  assert.equal(position(state, other).supported, false);
  assert.equal(position(state, other).quantity, 99n, "nothing was applied");
  assert.equal(position(state, b).quantity, 1n, "nothing was applied");
});

test("an exclusion zeroes the position's earlier hour finances but keeps its counts", () => {
  const state = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    state,
  );
  run(
    [swap(2, { side: "sell", ethWei: E * 2n, tokenRaw: 50n })],
    [transfer(2, 11, wallet, rules.manager, 50n)],
    state,
  );
  const first = state.walletHours.get(`${wallet}:${pool}:0`)!;
  assert.equal(first.realized, (E * 3n) / 2n);
  assert.equal(first.supportedTrades, 2);
  assert.equal(first.wins, 0);
  // Hours later, the wallet sells more than the ledger holds.
  const late = run(
    [swap(4000, { side: "sell", ethWei: E, tokenRaw: 60n })],
    [transfer(4000, 11, wallet, rules.manager, 60n)],
    state,
  );
  assert.deepEqual(
    late.application.excluded.map((p) => p.wallet),
    [wallet],
  );
  assert.deepEqual(
    late.application.sales.map((s) => s.supported),
    [false],
  );
  assert.equal(first.realized, 0n);
  assert.equal(first.proceeds, 0n);
  assert.equal(first.spent, 0n);
  assert.equal(first.supportedTrades, 0);
  assert.equal(first.best, null);
  assert.deepEqual<unknown>(
    [first.buys, first.sells, first.volume],
    [1, 1, E * 3n],
  );
  const second = state.walletHours.get(
    `${wallet}:${pool}:${ledgerHour(4000000)}`,
  )!;
  assert.deepEqual<unknown>(
    [second.sells, second.supportedTrades, second.realized, second.volume],
    [1, 0, 0n, E],
  );
  const p = position(state, wallet);
  assert.equal(p.supported, false);
  assert.equal(p.proceeds, E * 3n);
  assert.ok(ledgerIdentitiesHold(p));
  // Further trades keep counting without finances, and never re-support it.
  run(
    [swap(4001, { side: "buy", ethWei: E, tokenRaw: 10n })],
    [transfer(4001, 11, rules.manager, wallet, 10n)],
    state,
  );
  assert.equal(p.supported, false);
  assert.equal(second.buys, 1);
  assert.equal(second.spent, 0n);
});

test("pool hours keep OHLC of sqrtPriceX96 and distinct buyers and sellers; pool state keeps the latest quote", () => {
  const a = addr(0x901),
    b = addr(0x902);
  const state = createLedgerState();
  const rows = [
    swap(10, {
      side: "buy",
      ethWei: E,
      tokenRaw: 10n,
      initiator: a,
      sqrtPriceX96: "10",
      logIndex: 1,
    }),
    swap(10, {
      side: "buy",
      ethWei: E,
      tokenRaw: 10n,
      initiator: b,
      sqrtPriceX96: "5",
      logIndex: 5,
      txHash: hash(11),
    }),
    swap(10, {
      side: "sell",
      ethWei: E,
      tokenRaw: 5n,
      initiator: a,
      sqrtPriceX96: "20",
      logIndex: 9,
      txHash: hash(12),
      liquidity: "77",
      tick: -3,
    }),
    swap(10, {
      side: "buy",
      ethWei: E,
      tokenRaw: 10n,
      initiator: a,
      sqrtPriceX96: "15",
      logIndex: 13,
      txHash: hash(13),
    }),
  ];
  const transfers = [
    transfer(10, 2, rules.manager, a, 10n),
    transfer(10, 6, rules.manager, b, 10n, { txHash: hash(11) }),
    transfer(10, 10, a, rules.manager, 5n, { txHash: hash(12) }),
    transfer(10, 14, rules.manager, a, 10n, { txHash: hash(13) }),
  ];
  run(rows, transfers, state);
  const hour = state.poolHours.get(`${pool}:${ledgerHour(10000)}`)!;
  assert.deepEqual<unknown>(
    [
      hour.trades,
      hour.buys,
      hour.sells,
      hour.buyers,
      hour.sellers,
      hour.open,
      hour.high,
      hour.low,
      hour.close,
      hour.closeLogIndex,
    ],
    [4, 3, 1, 2, 1, 10n, 20n, 5n, 15n, 13],
  );
  const pstate = state.pools.get(pool)!;
  assert.deepEqual<unknown>(
    [
      pstate.trades,
      pstate.volume,
      pstate.sqrtPriceX96,
      pstate.liquidity,
      pstate.tick,
      pstate.priceLogIndex,
      pstate.priceTx,
    ],
    [4, E * 4n, 15n, 5n, 1, 13, hash(13)],
  );
  // The next batch continues the same hour and the same pool state.
  run(
    [
      swap(10, {
        side: "sell",
        ethWei: E,
        tokenRaw: 1n,
        initiator: b,
        sqrtPriceX96: "2",
        logIndex: 20,
        txHash: hash(14),
      }),
    ],
    [transfer(10, 21, b, rules.manager, 1n, { txHash: hash(14) })],
    state,
  );
  assert.deepEqual<unknown>(
    [hour.trades, hour.sellers, hour.low, hour.close],
    [5, 2, 2n, 2n],
  );
  assert.equal(pstate.sqrtPriceX96, 2n);
});

test("invalid, duplicate, split or unregistered rows are refused", () => {
  const good = swap(1, { side: "buy", ethWei: E, tokenRaw: 100n });
  const flow = transfer(1, 11, rules.manager, wallet, 100n);
  assert.throws(
    () => plan([good, { ...good }], [flow]),
    /ledger_duplicate_log/,
  );
  assert.throws(
    () => plan([good], [{ ...flow, logIndex: 10 }]),
    /ledger_duplicate_log/,
  );
  assert.throws(
    () => plan([{ ...good, poolId: hash(0x999) }], []),
    /ledger_unregistered_swap/,
  );
  assert.throws(
    () => plan([good], [{ ...flow, token: addr(0x999) }]),
    /ledger_unregistered_transfer/,
  );
  assert.throws(
    () => plan([good], [{ ...flow, block: 2 }]),
    /ledger_split_transaction/,
  );
  assert.throws(
    () => plan([good], [{ ...flow, blockHash: hash(77) }]),
    /ledger_split_transaction/,
  );
  assert.throws(
    () => plan([{ ...good, ethWei: "0" }], [flow]),
    /ledger_invalid_swap/,
  );
  assert.throws(
    () => plan([{ ...good, tokenRaw: "1.5" }], [flow]),
    /ledger_invalid_token_amount/,
  );
  assert.throws(
    () => plan([{ ...good, initiator: "0x12" }], [flow]),
    /ledger_invalid_initiator/,
  );
  assert.throws(
    () => plan([{ ...good, logIndex: -1 }], [flow]),
    /ledger_invalid_log/,
  );
  assert.throws(
    () =>
      planLedgerBatch(
        {
          swaps: [],
          transfers: [],
          registry: [...registry, { poolId: hash(0x101), token }],
        },
        rules,
      ),
    /ledger_ambiguous_token/,
  );
  // Events must be applied in order: a batch cannot precede what a position saw.
  const state = createLedgerState();
  run(
    [swap(5, { side: "buy", ethWei: E, tokenRaw: 1n })],
    [transfer(5, 11, rules.manager, wallet, 1n)],
    state,
  );
  assert.throws(
    () =>
      run(
        [swap(4, { side: "buy", ethWei: E, tokenRaw: 1n })],
        [transfer(4, 11, rules.manager, wallet, 1n)],
        state,
      ),
    /ledger_out_of_order/,
  );
});

/** The pepe capture's raw evidence through the attribution rule. Wallets the
 * old rule fully supported (every execution supported, every transfer matched)
 * must fold to the same position under the new rule when nothing new is
 * attributed to them; the rest of the summary is pinned so a rule change shows. */
test("the attribution rule over the pepe capture's raw evidence agrees with every fully supported wallet", () => {
  const { snapshot, evidence } = loadPepe();
  const market = snapshot.markets[0];
  const poolId = market.id.toLowerCase(),
    tokenAddress = market.token.toLowerCase();
  const timestamps = new Map(
    evidence.blocks.map((b) => [Number(b.number), Number(b.timestamp)]),
  );
  const receipts = new Map(
    evidence.receipts.map((r) => [r.transactionHash.toLowerCase(), r]),
  );
  const word = (data: string, i: number) =>
    BigInt(`0x${data.slice(2 + 64 * i, 66 + 64 * i)}`);
  const signed = (v: bigint) => (v >= 1n << 255n ? v - (1n << 256n) : v);
  const topicAddress = (t: string) => `0x${t.slice(26)}`.toLowerCase();
  const swaps: LedgerSwap[] = evidence.swaps
    .filter((log) => log.topics[1].toLowerCase() === poolId)
    .map((log) => {
      const receipt = receipts.get(log.transactionHash.toLowerCase())!;
      assert.equal(receipt.status, "0x1");
      const amount0 = signed(word(log.data, 0)),
        amount1 = signed(word(log.data, 1));
      return {
        txHash: log.transactionHash,
        logIndex: Number(log.logIndex),
        block: Number(log.blockNumber),
        blockHash: log.blockHash,
        timestamp: timestamps.get(Number(log.blockNumber))!,
        poolId,
        token: tokenAddress,
        initiator: receipt.from,
        txTo: receipt.to,
        side: amount0 < 0n ? "buy" : "sell",
        ethWei: (amount0 < 0n ? -amount0 : amount0).toString(),
        tokenRaw: (amount1 < 0n ? -amount1 : amount1).toString(),
        sqrtPriceX96: word(log.data, 2).toString(),
        liquidity: word(log.data, 3).toString(),
        tick: Number(signed(word(log.data, 4))),
      };
    });
  const transfers: LedgerTransfer[] = evidence.transfers
    .filter((log) => log.address.toLowerCase() === tokenAddress)
    .map((log) => ({
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      block: Number(log.blockNumber),
      blockHash: log.blockHash,
      timestamp: timestamps.get(Number(log.blockNumber))!,
      token: tokenAddress,
      from: topicAddress(log.topics[1]),
      to: topicAddress(log.topics[2]),
      value: word(log.data, 0).toString(),
    }));
  assert.equal(swaps.length, market.accounting!.executions!.length);
  const events = planLedgerBatch(
    { swaps, transfers, registry: [{ poolId, token: tokenAddress }] },
    rules,
  );
  const state = createLedgerState();
  const application = applyLedgerEvents(state, events);
  stateHolds(state);
  const summary = {
    swaps: swaps.length,
    transfers: transfers.length,
    initiator: application.liveTrades.filter(
      (t) => t.attribution === "initiator",
    ).length,
    counterparty: application.liveTrades.filter(
      (t) => t.attribution === "counterparty",
    ).length,
    unattributed: application.liveTrades.filter(
      (t) => t.attribution === "unattributed",
    ).length,
    positions: state.positions.size,
    supported: [...state.positions.values()].filter((p) => p.supported).length,
    withInflow: [...state.positions.values()].filter((p) => p.inflow > 0n)
      .length,
    oldSupported: 0,
    equalToOld: 0,
    oldExcludedNowSupported: 0,
  };
  const oldExecutions = market.accounting!.executions!;
  for (const row of market.accounting!.wallets) {
    const p = state.positions.get(
      positionKey(poolId, row.address.toLowerCase()),
    );
    if (row.flags.length) {
      if (p?.supported) summary.oldExcludedNowSupported++;
      continue;
    }
    summary.oldSupported++;
    assert.ok(p, `${row.address} has no ledger position`);
    const untouched =
      p.counterpartySwaps === 0 && p.inflow === 0n && p.outflow === 0n;
    const old = foldTrades(
      oldExecutions
        .filter(
          (e) => e.trade.trader.toLowerCase() === row.address.toLowerCase(),
        )
        .map((e) => e.trade),
    );
    if (!untouched) continue;
    assert.equal(p.supported, true, row.address);
    assert.equal(p.realized.toString(), row.realizedWei, row.address);
    assert.equal(p.quantity.toString(), row.inventoryRaw, row.address);
    assert.equal(p.cost.toString(), old.costWei, row.address);
    assert.equal(p.buys, row.buys);
    assert.equal(p.sells, row.sells);
    summary.equalToOld++;
  }
  assert.deepEqual(summary, {
    swaps: 1477,
    transfers: 1517,
    initiator: 1473,
    counterparty: 3,
    unattributed: 1,
    positions: 363,
    supported: 363,
    withInflow: 3,
    oldSupported: 341,
    equalToOld: 341,
    oldExcludedNowSupported: 17,
  });
});
