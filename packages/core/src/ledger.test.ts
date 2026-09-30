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
  pooledSwapShares,
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
      // Held under 60 s, folded at closure: the share walletMetrics derives.
      assert.equal(
        closures ? (count((h) => h.flashClosures!) / closures) * 100 : null,
        metrics.fastHoldShare,
      );
      const position = [...state.positions.values()].find(
        (p) => p.wallet === trader,
      )!;
      assert.equal(position.closedCycles, closures);
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

test("a closure folds its hold time: flash cycles under 60 s, the shortest, and nothing on a position or hour that predates the fold", () => {
  // Cycle 1: bought at 1,000, closed at 1,030 (30 s, flash). Cycle 2: bought
  // at 2,000, closed at 2,060 (60 s, not flash). Cycle 3: bought at 3,000,
  // partly sold at 3,010, closed at 3,045 (45 s, flash).
  const trades = [
    { ...trade(1, "buy", E, 100n), timestamp: 1000 },
    { ...trade(2, "sell", E, 100n), timestamp: 1030 },
    { ...trade(3, "buy", E, 50n), timestamp: 2000 },
    { ...trade(4, "sell", E, 50n), timestamp: 2060 },
    { ...trade(5, "buy", E, 80n), timestamp: 3000 },
    { ...trade(6, "sell", E / 2n, 40n), timestamp: 3010 },
    { ...trade(7, "sell", E / 2n, 40n), timestamp: 3045 },
  ];
  const state = createLedgerState();
  const { sales } = applyLedgerEvents(state, swapEvents(trades));
  stateHolds(state);
  const p = state.positions.get(positionKey(pool, wallet))!;
  assert.deepEqual(
    [p.closedCycles, p.flashCycles, p.shortestCycleSeconds],
    [3, 2, 30],
  );
  assert.deepEqual(
    sales.map((s) => s.closedHoldSeconds),
    [30, 60, null, 45],
  );
  const hours = [...state.walletHours.values()];
  assert.deepEqual(
    hours.map((h) => [h.hour, h.closures, h.flashClosures]),
    [[0, 3, 2]],
  );
  // A position and an hour row loaded from before the fold keep null: their
  // earlier closures carry no hold time, so a count from here on would read as
  // the whole history. Their other figures fold as always.
  const old = createLedgerState();
  applyLedgerEvents(old, swapEvents(trades.slice(0, 5)));
  const loaded = old.positions.get(positionKey(pool, wallet))!;
  loaded.closedCycles = null;
  loaded.flashCycles = null;
  loaded.shortestCycleSeconds = null;
  for (const h of old.walletHours.values()) h.flashClosures = null;
  applyLedgerEvents(old, swapEvents(trades.slice(5)));
  stateHolds(old);
  assert.deepEqual(
    [
      loaded.closedCycles,
      loaded.flashCycles,
      loaded.shortestCycleSeconds,
      loaded.sells,
    ],
    [null, null, null, 4],
  );
  assert.deepEqual(
    [...old.walletHours.values()].map((h) => [h.closures, h.flashClosures]),
    [[3, null]],
  );
  // A new hour row started after the fold counts its own flash closures.
  const later = createLedgerState();
  applyLedgerEvents(later, swapEvents(trades.slice(0, 5)));
  for (const h of later.walletHours.values()) h.flashClosures = null;
  applyLedgerEvents(
    later,
    swapEvents([
      { ...trade(6, "sell", E, 80n), timestamp: 3610 },
      { ...trade(8, "buy", E, 10n), timestamp: 3620 },
      { ...trade(9, "sell", E, 10n), timestamp: 3650 },
    ]),
  );
  assert.deepEqual(
    [...later.walletHours.values()].map((h) => [
      h.hour,
      h.closures,
      h.flashClosures,
    ]),
    [
      [0, 2, null],
      [1, 2, 1],
    ],
  );
  // An exclusion zeroes an hour's closures, so its flash count is a known zero.
  const oversold = createLedgerState();
  applyLedgerEvents(
    oversold,
    swapEvents([
      { ...trade(1, "buy", E, 100n), timestamp: 1000 },
      { ...trade(2, "sell", E, 100n), timestamp: 1010 },
      { ...trade(3, "sell", E, 5n), timestamp: 1020 },
    ]),
  );
  stateHolds(oversold);
  assert.deepEqual(
    [...oversold.walletHours.values()].map((h) => [
      h.closures,
      h.flashClosures,
    ]),
    [[0, 0]],
  );
  assert.deepEqual(
    [
      oversold.positions.get(positionKey(pool, wallet))!.closedCycles,
      oversold.positions.get(positionKey(pool, wallet))!.flashCycles,
    ],
    [1, 1],
  );
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
/** Rule 2: pooled swaps attributed pro rata (docs/AGGREGATE-LEDGER.md). */
const pooledRules = { ...rules, pooledSwaps: true };
function plan(swaps: LedgerSwap[], transfers: LedgerTransfer[], r = rules) {
  return planLedgerBatch({ swaps, transfers, registry }, r);
}
function run(
  swaps: LedgerSwap[],
  transfers: LedgerTransfer[],
  state = createLedgerState(),
  r = rules,
) {
  const events = plan(swaps, transfers, r);
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
  // The 20 have no basis the ledger can vouch for: excluded from here on.
  assert.equal(mine.supported, false);
  assert.equal(theirs.quantity, 80n);
  // The 20 left the holder without a sale: its basis went with them and
  // the holder's outcome is no longer the ledger's to state.
  assert.equal(theirs.supported, false);
  assert.deepEqual(theirs.flags, ["unattributed_outflow"]);
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
  assert.deepEqual(mine.flags, [
    "unattributed_outflow",
    "wrapper_route",
    "zero_cost_inflow",
  ]);
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
  assert.deepEqual(position(state, wallet).flags, ["unattributed_outflow"]);
  assert.equal(position(state, wallet).supported, false);
  assert.equal(position(state, other).quantity, 25n);
  assert.equal(position(state, other).cost, 0n);
  assert.deepEqual(position(state, other).flags, ["zero_cost_inflow"]);
  assert.equal(position(state, other).supported, false);
  assert.deepEqual(move.application.excluded, [
    position(state, wallet),
    position(state, other),
  ]);
  // The recipient sells what arrived free: the position folds the proceeds
  // (the sale is not an unknown basis, the tokens were seen arriving) but the
  // sale is excluded, so nothing of it reaches the wallet's hour.
  const free = run(
    [swap(4, { side: "sell", ethWei: E, tokenRaw: 25n, initiator: other })],
    [transfer(4, 11, other, rules.manager, 25n)],
    state,
  );
  assert.equal(position(state, other).realized, E);
  assert.equal(position(state, other).supported, false);
  assert.deepEqual(position(state, other).flags, ["zero_cost_inflow"]);
  assert.equal(free.application.sales[0].supported, false);
  const freeHour = state.walletHours.get(
    `${other}:${pool}:${ledgerHour(4000)}`,
  )!;
  assert.equal(freeHour.sells, 1);
  assert.equal(freeHour.volume, E);
  assert.equal(freeHour.supportedTrades, 0);
  assert.equal(freeHour.proceeds, 0n);
  assert.equal(freeHour.realized, 0n);
  assert.equal(freeHour.wins, 0);
  assert.equal(freeHour.best, null);
  // Transferring more than the ledger holds is an unknown basis: excluded.
  run([], [transfer(5, 5, wallet, other, 76n)], state);
  assert.equal(position(state, wallet).supported, false);
  assert.deepEqual(position(state, wallet).flags, [
    "unattributed_outflow",
    "unknown_basis",
  ]);
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
  // ...though the one token it sent b in that transaction excludes it.
  assert.equal(position(state, other).supported, false);
  assert.deepEqual(position(state, other).flags, ["unattributed_outflow"]);
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
    supported: 359,
    withInflow: 3,
    oldSupported: 341,
    equalToOld: 341,
    oldExcludedNowSupported: 16,
  });
  for (const p of state.positions.values())
    assert.equal(p.supported, p.inflow === 0n && p.outflow === 0n, p.wallet);
});

test("a zero-cost inflow excludes the position: of one wallet's bought and received positions, only the bought sale counts", () => {
  const sender = addr(0x301),
    poolB = hash(0x101),
    tokenB = addr(0x201);
  const registry = [
    { poolId: pool, token },
    { poolId: poolB, token: tokenB },
  ];
  const events = (swaps: LedgerSwap[], transfers: LedgerTransfer[]) =>
    planLedgerBatch({ swaps, transfers, registry }, rules);
  const state = createLedgerState();
  // Hour 0: the wallet buys 100 of A for 1 ETH, and receives 100 of B from
  // another wallet (which bought them) without a swap of its own.
  applyLedgerEvents(
    state,
    events(
      [
        swap(1, { side: "buy", ethWei: E, tokenRaw: 100n }),
        swap(2, {
          side: "buy",
          ethWei: E,
          tokenRaw: 100n,
          poolId: poolB,
          token: tokenB,
          initiator: sender,
        }),
      ],
      [
        transfer(1, 11, rules.manager, wallet, 100n),
        transfer(2, 11, rules.manager, sender, 100n, { token: tokenB }),
        transfer(3, 5, sender, wallet, 100n, { token: tokenB }),
      ],
    ),
  );
  stateHolds(state);
  const bought = position(state, wallet),
    received = position(state, wallet, poolB);
  assert.equal(bought.supported, true);
  assert.deepEqual(bought.flags, []);
  assert.equal(received.quantity, 100n);
  assert.equal(received.cost, 0n);
  assert.equal(received.inflow, 100n);
  assert.equal(received.supported, false);
  assert.deepEqual(received.flags, ["zero_cost_inflow"]);
  // Hour 1: both sold whole, each for 2 ETH.
  const sold = applyLedgerEvents(
    state,
    events(
      [
        swap(3601, { side: "sell", ethWei: 2n * E, tokenRaw: 100n }),
        swap(3602, {
          side: "sell",
          ethWei: 2n * E,
          tokenRaw: 100n,
          poolId: poolB,
          token: tokenB,
        }),
      ],
      [
        transfer(3601, 11, wallet, rules.manager, 100n),
        transfer(3602, 11, wallet, rules.manager, 100n, { token: tokenB }),
      ],
    ),
  );
  stateHolds(state);
  // Both positions fold their own figures; the received one stays excluded.
  assert.equal(bought.realized, E);
  assert.equal(bought.disposedCost, E);
  assert.equal(bought.supported, true);
  assert.equal(received.proceeds, 2n * E);
  assert.equal(received.realized, 2n * E);
  assert.equal(received.disposedCost, 0n);
  assert.equal(received.supported, false);
  assert.deepEqual(
    sold.sales.map((s) => [s.poolId, s.supported]),
    [
      [pool, true],
      [poolB, false],
    ],
  );
  // The hour rows: the bought sale is the only supported trade, win and
  // realized figure; the received sale is a count and volume, nothing else.
  const hour = ledgerHour(3601 * 1000);
  const boughtHour = state.walletHours.get(`${wallet}:${pool}:${hour}`)!,
    receivedHour = state.walletHours.get(`${wallet}:${poolB}:${hour}`)!;
  assert.deepEqual(
    [boughtHour, receivedHour].map((h) => ({
      sells: h.sells,
      volume: h.volume,
      supportedTrades: h.supportedTrades,
      proceeds: h.proceeds,
      disposedCost: h.disposedCost,
      realized: h.realized,
      wins: h.wins,
      closures: h.closures,
      best: h.best,
    })),
    [
      {
        sells: 1,
        volume: 2n * E,
        supportedTrades: 1,
        proceeds: 2n * E,
        disposedCost: E,
        realized: E,
        wins: 1,
        closures: 1,
        best: E,
      },
      {
        sells: 1,
        volume: 2n * E,
        supportedTrades: 0,
        proceeds: 0n,
        disposedCost: 0n,
        realized: 0n,
        wins: 0,
        closures: 0,
        best: null,
      },
    ],
  );
  // A buy into a position that already received tokens counts as volume and
  // a trade, never as spent; nothing later un-excludes it.
  applyLedgerEvents(
    state,
    events(
      [
        swap(7201, {
          side: "buy",
          ethWei: E,
          tokenRaw: 50n,
          poolId: poolB,
          token: tokenB,
        }),
      ],
      [transfer(7201, 11, rules.manager, wallet, 50n, { token: tokenB })],
    ),
  );
  stateHolds(state);
  assert.equal(received.supported, false);
  assert.equal(received.buys, 1);
  const laterHour = state.walletHours.get(
    `${wallet}:${poolB}:${ledgerHour(7201 * 1000)}`,
  )!;
  assert.equal(laterHour.buys, 1);
  assert.equal(laterHour.volume, E);
  assert.equal(laterHour.supportedTrades, 0);
  assert.equal(laterHour.spent, 0n);
});

test("a zero-cost inflow into a supported position zeroes the finances of every hour it already earned", () => {
  const sender = addr(0x301);
  const state = createLedgerState();
  // Hour 0: bought and sold at a gain, a supported closure.
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    state,
  );
  run(
    [swap(2, { side: "sell", ethWei: 3n * E, tokenRaw: 100n })],
    [transfer(2, 11, wallet, rules.manager, 100n)],
    state,
  );
  const earned = state.walletHours.get(`${wallet}:${pool}:0`)!;
  assert.equal(earned.realized, 2n * E);
  assert.equal(earned.wins, 1);
  // Hour 2: tokens arrive without a swap. The position is excluded and the
  // earlier hour's finances go with it; the writer zeroes rows outside the
  // state from `excluded`.
  run(
    [swap(7201, { side: "buy", ethWei: E, tokenRaw: 20n, initiator: sender })],
    [transfer(7201, 11, rules.manager, sender, 20n)],
    state,
  );
  const arrived = run([], [transfer(7202, 5, sender, wallet, 10n)], state);
  assert.deepEqual(arrived.application.excluded, [
    position(state, sender),
    position(state, wallet),
  ]);
  assert.equal(position(state, wallet).supported, false);
  assert.deepEqual(position(state, wallet).flags, ["zero_cost_inflow"]);
  assert.equal(earned.realized, 0n);
  assert.equal(earned.proceeds, 0n);
  assert.equal(earned.disposedCost, 0n);
  assert.equal(earned.spent, 0n);
  assert.equal(earned.supportedTrades, 0);
  assert.equal(earned.wins, 0);
  assert.equal(earned.closures, 0);
  assert.equal(earned.best, null);
  assert.equal(earned.buys, 1);
  assert.equal(earned.sells, 1);
  assert.equal(earned.volume, 4n * E);
  // A second inflow into the excluded position is not a second exclusion.
  const again = run([], [transfer(7203, 5, sender, wallet, 5n)], state);
  assert.deepEqual(again.application.excluded, []);
  assert.equal(position(state, wallet).inflow, 15n);
  // The sender is excluded by the same transfers, its basis gone with them.
  assert.equal(position(state, sender).supported, false);
  assert.deepEqual(position(state, sender).flags, ["unattributed_outflow"]);
  assert.equal(position(state, sender).outflowCost, (E * 3n) / 4n);
});

test("an unattributed outflow excludes the position: the basis leaves with the tokens, no loss is booked, and neither its earlier nor its later sales count", () => {
  const cold = addr(0x301);
  const state = createLedgerState();
  // Hour 0: buy 100 for 4 ETH, sell 50 for 3 ETH (a supported sale, gain 1).
  run(
    [swap(1, { side: "buy", ethWei: 4n * E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    state,
  );
  run(
    [swap(2, { side: "sell", ethWei: 3n * E, tokenRaw: 50n })],
    [transfer(2, 11, wallet, rules.manager, 50n)],
    state,
  );
  const hour0 = state.walletHours.get(`${wallet}:${pool}:0`)!;
  assert.equal(hour0.realized, E);
  assert.equal(hour0.supportedTrades, 2);
  // Later: 20 move to another wallet (a cold wallet, a friend, a farm: the
  // ledger cannot tell). The position keeps its figures, its basis for the
  // 20 (0.8 ETH) moves to outflowCost rather than to a loss, and it is
  // excluded: hour 0's finances go, its counts stay.
  const moved = run([], [transfer(3601, 5, wallet, cold, 20n)], state);
  const p = position(state, wallet);
  assert.deepEqual(moved.application.excluded, [p, position(state, cold)]);
  assert.equal(p.supported, false);
  assert.deepEqual(p.flags, ["unattributed_outflow"]);
  assert.equal(p.realized, E);
  assert.equal(p.disposedCost, 2n * E);
  assert.equal(p.outflowCost, (8n * E) / 10n);
  assert.equal(p.cost, (12n * E) / 10n);
  assert.equal(p.quantity, 30n);
  assert.ok(ledgerIdentitiesHold(p));
  assert.deepEqual(
    [hour0.realized, hour0.proceeds, hour0.spent, hour0.supportedTrades],
    [0n, 0n, 0n, 0],
  );
  assert.deepEqual([hour0.buys, hour0.sells, hour0.volume], [1, 1, 7n * E]);
  // Later still: the remaining 30 sell for 9 ETH. The position books the gain
  // (proceeds 9 against basis 1.2); the sale is not supported and the hour
  // holds a count and volume only.
  const later = run(
    [swap(7201, { side: "sell", ethWei: 9n * E, tokenRaw: 30n })],
    [transfer(7201, 11, wallet, rules.manager, 30n)],
    state,
  );
  assert.equal(later.application.sales[0].supported, false);
  assert.equal(p.realized, E + 9n * E - (12n * E) / 10n);
  assert.equal(p.quantity, 0n);
  assert.equal(p.supported, false);
  const hour2 = state.walletHours.get(
    `${wallet}:${pool}:${ledgerHour(7201 * 1000)}`,
  )!;
  assert.deepEqual(
    [hour2.sells, hour2.volume, hour2.supportedTrades, hour2.realized],
    [1, 9n * E, 0, 0n],
  );
  stateHolds(state);
});

// Fold rule 2: a pooled swap (docs/AGGREGATE-LEDGER.md, "Pooled swaps"). A
// batch-sell contract collects many wallets' tokens and sells them in one
// PoolManager swap, so no single address's net movement covers the swap;
// rule 1 leaves it unattributed and excludes every contributor, rule 2
// attributes each contributor its own movement with its pro-rata share of
// the ETH leg. The contract nets to zero (a pass-through) and is no wallet.
const batchSeller = addr(0x900);
/** A pooled sell: each contributor sends its tokens to the batch contract,
 * which sends the total to the manager in one swap. */
function pooledSell(
  n: number,
  ethWei: bigint,
  contributions: [string, bigint][],
  fields: Omit<Partial<LedgerSwap>, "side" | "ethWei" | "tokenRaw"> = {},
) {
  const total = contributions.reduce((sum, [, v]) => sum + v, 0n);
  const swaps = [
    swap(n, {
      side: "sell",
      ethWei,
      tokenRaw: total,
      initiator: batchSeller,
      txTo: batchSeller,
      logIndex: 90,
      ...fields,
    }),
  ];
  const transfers = [
    ...contributions.map(([w, v], i) => transfer(n, 11 + i, w, batchSeller, v)),
    transfer(n, 80, batchSeller, rules.manager, total),
  ];
  return { swaps, transfers };
}
/** Two contributors' buys at blocks n and n + 1, so both hold tokens. */
function bought(state: LedgerState, n: number, holders: [string, bigint][]) {
  for (const [i, [w, v]] of holders.entries())
    run(
      [swap(n + i, { side: "buy", ethWei: v * E, tokenRaw: v, initiator: w })],
      [transfer(n + i, 11, rules.manager, w, v)],
      state,
    );
}

test("rule 2 attributes a pooled sell pro rata by token movement; rule 1 leaves it unattributed and excludes every contributor", () => {
  const a = addr(0x901),
    b = addr(0x902);
  // 10 ETH plus 7 wei for 100 tokens: the shares cannot be exact, so the
  // remainder rule decides the last wei (b's exact share lost 0.8 wei, a's
  // 0.2, so b gets it).
  const ethWei = E * 10n + 7n;
  const sell = pooledSell(3, ethWei, [
    [a, 60n],
    [b, 40n],
  ]);
  // Rule 1, the default: unattributed, both excluded, nothing applied.
  const old = createLedgerState();
  bought(old, 1, [
    [a, 60n],
    [b, 40n],
  ]);
  const before = run(sell.swaps, sell.transfers, old);
  assert.deepEqual(
    before.events.map((e) => e.kind),
    ["unattributed_swap"],
  );
  assert.deepEqual((before.events[0] as { wallets: string[] }).wallets, [a, b]);
  for (const w of [a, b]) {
    assert.equal(position(old, w).supported, false);
    assert.deepEqual(position(old, w).flags, ["unattributed_swap_activity"]);
    assert.equal(position(old, w).sells, 0);
  }
  assert.equal(before.application.liveTrades[0].attribution, "unattributed");
  // Rule 2: one pooled swap, each contributor's own movement, the shares
  // summing to the ETH leg exactly.
  const state = createLedgerState();
  bought(state, 1, [
    [a, 60n],
    [b, 40n],
  ]);
  const { events, application } = run(
    sell.swaps,
    sell.transfers,
    state,
    pooledRules,
  );
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.kind, "pooled_swap");
  if (e.kind !== "pooled_swap") throw Error("unreachable");
  assert.deepEqual(e.shares, [
    { wallet: a, tokenRaw: 60n, ethWei: E * 6n + 4n },
    { wallet: b, tokenRaw: 40n, ethWei: E * 4n + 3n },
  ]);
  assert.equal(e.wrapper, true, "tx.to was the batch contract, not the router");
  assert.equal(e.initiator, batchSeller);
  // The batch contract is a pass-through, never a wallet.
  assert.equal(state.positions.has(positionKey(pool, batchSeller)), false);
  // Each contributor sold its own tokens at its share: a bought 60 for 60
  // ETH and sold them for 6 ETH and 4 wei.
  const pa = position(state, a),
    pb = position(state, b);
  assert.deepEqual(
    [pa.quantity, pa.cost, pa.proceeds, pa.disposedCost, pa.realized],
    [0n, 0n, E * 6n + 4n, E * 60n, E * 6n + 4n - E * 60n],
  );
  assert.deepEqual(
    [pb.quantity, pb.proceeds, pb.disposedCost, pb.realized],
    [0n, E * 4n + 3n, E * 40n, E * 4n + 3n - E * 40n],
  );
  for (const p of [pa, pb]) {
    assert.equal(p.supported, true);
    assert.deepEqual(p.flags, ["pooled_route", "wrapper_route"]);
    assert.equal(p.pooledSwaps, 1);
    assert.equal(p.sells, 1);
    assert.equal(p.buys, 1);
    assert.equal(p.closedCycles, 1);
    assert.ok(ledgerIdentitiesHold(p));
  }
  assert.deepEqual([pa.boughtRaw, pa.soldRaw], [60n, 60n]);
  assert.deepEqual([pb.boughtRaw, pb.soldRaw], [40n, 40n]);
  // One trade for the pool, one sale per contributor for the wallets: the
  // hour holds the two buys and the one pooled sell, with two sellers.
  const hour = state.poolHours.get(`${pool}:${ledgerHour(3000)}`)!;
  assert.deepEqual(
    [
      hour.trades,
      hour.buys,
      hour.sells,
      hour.buyers,
      hour.sellers,
      hour.unattributed,
      hour.volume,
    ],
    [3, 2, 1, 2, 2, 0, E * 100n + ethWei],
  );
  assert.equal(state.pools.get(pool)!.trades, 3);
  assert.equal(state.pools.get(pool)!.volume, E * 100n + ethWei);
  assert.deepEqual(
    application.liveTrades.map((t) => [t.wallet, t.attribution, t.ethWei]),
    [[null, "pooled", ethWei]],
  );
  assert.deepEqual(
    application.sales.map((s) => [s.wallet, s.ethWei, s.tokenRaw, s.supported]),
    [
      [a, E * 6n + 4n, 60n, true],
      [b, E * 4n + 3n, 40n, true],
    ],
  );
  // Each wallet's hour row carries its own share and its closure beside
  // the buy it made in the same hour.
  const ha = state.walletHours.get(`${a}:${pool}:${ledgerHour(3000)}`)!;
  assert.deepEqual(
    [
      ha.buys,
      ha.sells,
      ha.supportedTrades,
      ha.proceeds,
      ha.volume,
      ha.closures,
      ha.losses,
    ],
    [1, 1, 2, E * 6n + 4n, E * 66n + 4n, 1, 1],
  );
  // Announced by the keys: both positions and both hour rows.
  const keys = ledgerKeys(events);
  assert.deepEqual(keys.positions.map((k) => k.wallet).sort(), [a, b].sort());
  assert.equal(keys.walletHours.length, 2);
});

test("the pro-rata shares sum to the ETH leg exactly, the truncated wei going to the largest losses first and the lower address among equal ones", () => {
  // 10 wei over three equal contributors: 3 each and one wei left, which
  // the lowest address takes since every exact share lost the same third.
  const [x, y, z] = [addr(0x903), addr(0x901), addr(0x902)];
  assert.deepEqual(
    pooledSwapShares(10n, 3n, [
      { wallet: x, tokenRaw: 1n },
      { wallet: y, tokenRaw: 1n },
      { wallet: z, tokenRaw: 1n },
    ]).map((s) => [s.wallet, s.ethWei]),
    [
      [x, 3n],
      [y, 4n],
      [z, 3n],
    ],
  );
  // Fifty contributors of uneven sizes: every share is its exact value
  // truncated or one wei above, never more, and the total is exact.
  const contributors = Array.from({ length: 50 }, (_, i) => ({
    wallet: addr(0x1000 + ((i * 7919) % 50)),
    tokenRaw: BigInt(1 + ((i * 104729) % 977)) * 10n ** 18n + BigInt(i),
  }));
  const tokenRaw = contributors.reduce((sum, c) => sum + c.tokenRaw, 0n);
  const ethWei = 6000423542526057991n;
  const shares = pooledSwapShares(ethWei, tokenRaw, contributors);
  assert.equal(shares.length, 50);
  assert.equal(
    shares.reduce((sum, s) => sum + s.ethWei, 0n),
    ethWei,
  );
  let extra = 0n;
  for (const [i, s] of shares.entries()) {
    const floor = (ethWei * contributors[i].tokenRaw) / tokenRaw;
    assert.equal(s.wallet, contributors[i].wallet);
    assert.equal(s.tokenRaw, contributors[i].tokenRaw);
    assert.ok(s.ethWei === floor || s.ethWei === floor + 1n);
    extra += s.ethWei - floor;
  }
  assert.ok(extra < 50n);
  // The same rows give the same shares, whatever order the caller holds them in.
  const reversed = pooledSwapShares(
    ethWei,
    tokenRaw,
    [...contributors].reverse(),
  );
  assert.deepEqual(
    [...reversed].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)),
    [...shares].sort((a, b) => (a.wallet < b.wallet ? -1 : 1)),
  );
  // Movements that do not sum to the swapped amount, one contributor, or a
  // zero ETH leg are refused: the plan never asks.
  assert.throws(
    () =>
      pooledSwapShares(10n, 4n, [
        { wallet: x, tokenRaw: 1n },
        { wallet: y, tokenRaw: 1n },
      ]),
    /ledger_invalid_pooled_swap/,
  );
  assert.throws(
    () => pooledSwapShares(10n, 1n, [{ wallet: x, tokenRaw: 1n }]),
    /ledger_invalid_pooled_swap/,
  );
  assert.throws(
    () =>
      pooledSwapShares(10n, 2n, [
        { wallet: x, tokenRaw: 2n },
        { wallet: y, tokenRaw: 0n },
      ]),
    /ledger_invalid_pooled_share/,
  );
});

test("a pooled swap through the plan: fifty contributors, a pass-through mover, a shortfall, a counter-movement, two swaps of the pool, and a pooled buy", () => {
  const holders: [string, bigint][] = Array.from({ length: 50 }, (_, i) => [
    addr(0x2000 + i),
    BigInt(10 + i),
  ]);
  const state = createLedgerState();
  bought(state, 1, holders);
  // Fifty contributors: fifty shares, fifty supported sellers, one sell.
  const fifty = pooledSell(100, E * 7n + 3n, holders);
  const { events } = run(fifty.swaps, fifty.transfers, state, pooledRules);
  assert.equal(events[0].kind, "pooled_swap");
  if (events[0].kind !== "pooled_swap") throw Error("unreachable");
  assert.equal(events[0].shares.length, 50);
  assert.equal(
    events[0].shares.reduce((sum, s) => sum + s.ethWei, 0n),
    E * 7n + 3n,
  );
  for (const [w] of holders) {
    assert.equal(position(state, w).supported, true);
    assert.equal(position(state, w).quantity, 0n);
    assert.equal(position(state, w).pooledSwaps, 1);
  }
  const hour = state.poolHours.get(`${pool}:${ledgerHour(100000)}`)!;
  assert.deepEqual([hour.trades, hour.sells, hour.sellers], [1, 1, 50]);

  // A wallet whose tokens only pass through the transaction (in and out
  // in the same amount) moved nothing: it is neither a contributor nor
  // excluded, and no position is opened for it.
  const a = addr(0x901),
    b = addr(0x902),
    relay = addr(0x903);
  const passed = createLedgerState();
  bought(passed, 200, [
    [a, 60n],
    [b, 40n],
  ]);
  const viaRelay = {
    swaps: pooledSell(203, E * 10n, [
      [a, 60n],
      [b, 40n],
    ]).swaps,
    transfers: [
      transfer(203, 11, a, relay, 60n),
      transfer(203, 12, relay, batchSeller, 60n),
      transfer(203, 13, b, batchSeller, 40n),
      transfer(203, 80, batchSeller, rules.manager, 100n),
    ],
  };
  const relayed = run(viaRelay.swaps, viaRelay.transfers, passed, pooledRules);
  assert.equal(relayed.events[0].kind, "pooled_swap");
  assert.deepEqual(
    (relayed.events[0] as { shares: { wallet: string }[] }).shares.map(
      (s) => s.wallet,
    ),
    [a, b],
  );
  assert.equal(passed.positions.has(positionKey(pool, relay)), false);
  assert.equal(position(passed, a).supported, true);

  // The movements fall short of the swapped amount (the contract kept a
  // fee in tokens, or the token burned some): rule 2 does not guess who
  // covers the gap, so the swap stays unattributed and every mover excluded.
  const short = createLedgerState();
  bought(short, 300, [
    [a, 60n],
    [b, 40n],
  ]);
  const shortfall = {
    swaps: pooledSell(303, E * 10n, [
      [a, 60n],
      [b, 40n],
    ]).swaps, // tokenRaw 100
    transfers: [
      transfer(303, 11, a, batchSeller, 60n),
      transfer(303, 12, b, batchSeller, 30n),
      transfer(303, 80, batchSeller, rules.manager, 100n),
      transfer(303, 81, ledgerZeroAddress, batchSeller, 10n),
    ],
  };
  const gap = run(shortfall.swaps, shortfall.transfers, short, pooledRules);
  assert.equal(gap.events[0].kind, "unattributed_swap");
  assert.equal(position(short, a).supported, false);
  assert.equal(position(short, b).supported, false);
  assert.equal(position(short, a).quantity, 60n, "nothing was applied");

  // A movement against the swap's direction (a wallet received tokens in
  // the same sell) leaves the swap unattributed under rule 2 as well.
  const mixed = createLedgerState();
  bought(mixed, 400, [
    [a, 60n],
    [b, 40n],
  ]);
  const c = addr(0x904);
  const against = {
    swaps: pooledSell(403, E * 10n, [
      [a, 60n],
      [b, 40n],
    ]).swaps,
    transfers: [
      transfer(403, 11, a, batchSeller, 60n),
      transfer(403, 12, b, batchSeller, 45n),
      transfer(403, 13, batchSeller, c, 5n),
      transfer(403, 80, batchSeller, rules.manager, 100n),
    ],
  };
  const counter = run(against.swaps, against.transfers, mixed, pooledRules);
  assert.equal(counter.events[0].kind, "unattributed_swap");
  assert.deepEqual((counter.events[0] as { wallets: string[] }).wallets, [
    a,
    b,
    c,
  ]);

  // Two swaps of one pool in the transaction: an arbitrage loop, still
  // unattributed, since no movement can be split between two swaps.
  const looped = createLedgerState();
  bought(looped, 500, [
    [a, 60n],
    [b, 40n],
  ]);
  const twice = pooledSell(503, E * 10n, [
    [a, 60n],
    [b, 40n],
  ]);
  const loop = run(
    [
      ...twice.swaps,
      swap(503, {
        side: "buy",
        ethWei: E,
        tokenRaw: 1n,
        initiator: batchSeller,
        logIndex: 95,
      }),
    ],
    [...twice.transfers, transfer(503, 96, rules.manager, batchSeller, 1n)],
    looped,
    pooledRules,
  );
  assert.deepEqual(
    loop.events.map((e) => e.kind),
    ["unattributed_swap", "unattributed_swap"],
  );

  // A pooled buy: one swap bought for many, the tokens fanned out; each
  // recipient's position opens at its share of the cost.
  const fanned = createLedgerState();
  const buy = run(
    [
      swap(600, {
        side: "buy",
        ethWei: E * 3n + 1n,
        tokenRaw: 30n,
        initiator: batchSeller,
        txTo: batchSeller,
      }),
    ],
    [
      transfer(600, 11, rules.manager, batchSeller, 30n),
      transfer(600, 12, batchSeller, a, 10n),
      transfer(600, 13, batchSeller, b, 20n),
    ],
    fanned,
    pooledRules,
  );
  assert.equal(buy.events[0].kind, "pooled_swap");
  assert.deepEqual((buy.events[0] as { shares: unknown[] }).shares, [
    { wallet: a, tokenRaw: 10n, ethWei: E + 0n },
    { wallet: b, tokenRaw: 20n, ethWei: E * 2n + 1n },
  ]);
  assert.deepEqual(
    [
      position(fanned, a).cost,
      position(fanned, a).quantity,
      position(fanned, a).boughtRaw,
    ],
    [E, 10n, 10n],
  );
  assert.equal(position(fanned, b).cost, E * 2n + 1n);
  const buyHour = fanned.poolHours.get(`${pool}:${ledgerHour(600000)}`)!;
  assert.deepEqual([buyHour.buys, buyHour.buyers, buyHour.sellers], [1, 2, 0]);
  assert.equal(buy.application.liveTrades[0].attribution, "pooled");
});

test("the initiator of a pooled swap is one contributor among the others, never its beneficiary", () => {
  const a = addr(0x901),
    b = addr(0x902);
  const state = createLedgerState();
  bought(state, 1, [
    [a, 60n],
    [b, 40n],
  ]);
  // a sends the transaction itself: its share is still its own 60 tokens'
  // worth, and b's is b's.
  const sell = pooledSell(
    3,
    E * 10n,
    [
      [a, 60n],
      [b, 40n],
    ],
    { initiator: a },
  );
  const { events, application } = run(
    sell.swaps,
    sell.transfers,
    state,
    pooledRules,
  );
  assert.equal(events[0].kind, "pooled_swap");
  assert.deepEqual(
    (events[0] as { shares: { wallet: string; ethWei: bigint }[] }).shares.map(
      (s) => [s.wallet, s.ethWei],
    ),
    [
      [a, E * 6n],
      [b, E * 4n],
    ],
  );
  assert.equal(application.liveTrades[0].wallet, null);
  assert.equal(position(state, a).counterpartySwaps, 0);
  assert.equal(position(state, b).counterpartySwaps, 0);
  // The same transaction under rule 1 excludes both: the sender is no
  // beneficiary there either.
  const old = createLedgerState();
  bought(old, 1, [
    [a, 60n],
    [b, 40n],
  ]);
  assert.equal(
    run(sell.swaps, sell.transfers, old).events[0].kind,
    "unattributed_swap",
  );
});

test("bought and sold unit totals fold from every attributed swap, stay null on a position from before the fold, and hold the units identity", () => {
  const state = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    state,
  );
  run(
    [swap(2, { side: "sell", ethWei: E, tokenRaw: 30n })],
    [transfer(2, 11, wallet, rules.manager, 30n)],
    state,
  );
  run(
    [swap(3, { side: "buy", ethWei: E, tokenRaw: 5n })],
    [transfer(3, 11, rules.manager, wallet, 5n)],
    state,
  );
  const p = position(state, wallet);
  assert.deepEqual([p.boughtRaw, p.soldRaw, p.quantity], [105n, 30n, 75n]);
  // An oversell empties the inventory and flags unknown_basis: the totals
  // keep counting the swaps and the identity is waived by the flag.
  run(
    [swap(4, { side: "sell", ethWei: E, tokenRaw: 80n })],
    [transfer(4, 11, wallet, rules.manager, 80n)],
    state,
  );
  assert.deepEqual([p.boughtRaw, p.soldRaw, p.quantity], [105n, 110n, 0n]);
  assert.ok(p.flags.includes("unknown_basis"));
  assert.ok(ledgerIdentitiesHold(p));
  // A position the fold met before the totals existed keeps them null,
  // whatever it trades from then on.
  const legacy = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    legacy,
  );
  position(legacy, wallet).boughtRaw = null;
  position(legacy, wallet).soldRaw = null;
  run(
    [swap(2, { side: "sell", ethWei: E, tokenRaw: 30n })],
    [transfer(2, 11, wallet, rules.manager, 30n)],
    legacy,
  );
  assert.deepEqual(
    [position(legacy, wallet).boughtRaw, position(legacy, wallet).soldRaw],
    [null, null],
  );
  assert.ok(ledgerIdentitiesHold(position(legacy, wallet)));
  // A transfer in or out counts in the identity through inflow and outflow.
  const moved = createLedgerState();
  run(
    [swap(1, { side: "buy", ethWei: E, tokenRaw: 100n })],
    [transfer(1, 11, rules.manager, wallet, 100n)],
    moved,
  );
  run([], [transfer(2, 11, wallet, addr(0x301), 10n)], moved);
  run([], [transfer(3, 11, addr(0x301), wallet, 4n)], moved);
  const m = position(moved, wallet);
  assert.deepEqual(
    [m.boughtRaw, m.soldRaw, m.inflow, m.outflow, m.quantity],
    [100n, 0n, 4n, 10n, 94n],
  );
  assert.ok(ledgerIdentitiesHold(m));
});
