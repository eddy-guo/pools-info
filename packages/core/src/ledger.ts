// The aggregate ledger (docs/AGGREGATE-LEDGER.md): pure functions that turn
// one batch of PoolManager swaps and ERC-20 transfers into position, hour and
// pool-state changes. Integer arithmetic only; nothing is inferred from a
// balance, a price or a later event. The position machine is foldTrades
// (accounting.ts) made incremental, so every existing accounting fixture folds
// to the same numbers (ledger.test.ts); the closure metrics are the ones
// walletMetrics (live-analytics.ts) computes from a folded position.

export const ledgerHour = (timestamp: number) => Math.floor(timestamp / 3600);
/** A closed inventory cycle held for less than this many seconds is a flash
 * cycle: the "held under 60 s" share walletMetrics calls fastHoldShare. */
export const ledgerFlashHoldSeconds = 60;
export const ledgerZeroAddress = "0x0000000000000000000000000000000000000000";
export type LedgerFlag =
  | "zero_cost_inflow"
  | "wrapper_route"
  | "counterparty_route"
  | "unknown_basis"
  | "unattributed_swap_activity";
/** Flags a supported position may carry: they describe, they never exclude. */
export const ledgerInformationalFlags: readonly LedgerFlag[] = [
  "zero_cost_inflow",
  "wrapper_route",
  "counterparty_route",
];
/** Flags that exclude a position: its finances are never served. */
export const ledgerExcludingFlags: readonly LedgerFlag[] = [
  "unknown_basis",
  "unattributed_swap_activity",
];
export type LedgerAttribution = "initiator" | "counterparty" | "unattributed";
export type LedgerSide = "buy" | "sell";

/** Addresses the attribution rule treats as infrastructure. The manager and
 * the zero address move tokens in every swap and mint but are never wallets;
 * the router decides the route label. */
export interface LedgerRules {
  manager: string;
  router: string;
}
/** One registered PoolManager Swap log joined to its transaction. */
export interface LedgerSwap {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  poolId: string;
  token: string;
  /** The transaction's from: the initiator, never assumed to be the beneficiary. */
  initiator: string;
  /** The transaction's to; null for a contract creation. */
  txTo: string | null;
  side: LedgerSide;
  ethWei: string;
  tokenRaw: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
}
/** One ERC-20 Transfer log of a registered token. */
export interface LedgerTransfer {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
  token: string;
  from: string;
  to: string;
  value: string;
}
/** The registered pools a batch may touch: one pool per token. */
export interface LedgerRegistryEntry {
  poolId: string;
  token: string;
}
export interface LedgerBatchRows {
  swaps: readonly LedgerSwap[];
  transfers: readonly LedgerTransfer[];
  registry: readonly LedgerRegistryEntry[];
}
interface LogSite {
  txHash: string;
  logIndex: number;
  block: number;
  blockHash: string;
  timestamp: number;
}
interface SwapQuote {
  side: LedgerSide;
  ethWei: bigint;
  tokenRaw: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  initiator: string;
}
/** Position-level effects of a batch, in application order. */
export type LedgerEvent =
  | (LogSite &
      SwapQuote & {
        kind: "swap";
        poolId: string;
        wallet: string;
        attribution: "initiator" | "counterparty";
        wrapper: boolean;
      })
  | (LogSite &
      SwapQuote & {
        kind: "unattributed_swap";
        poolId: string;
        /** Every non-infrastructure address whose balance moved in the transaction. */
        wallets: string[];
      })
  | (LogSite & {
      kind: "inflow" | "outflow";
      poolId: string;
      wallet: string;
      tokenRaw: bigint;
    });

export interface LedgerPosition {
  poolId: string;
  wallet: string;
  quantity: bigint;
  cost: bigint;
  invested: bigint;
  proceeds: bigint;
  disposedCost: bigint;
  realized: bigint;
  inflow: bigint;
  outflow: bigint;
  outflowCost: bigint;
  buys: number;
  sells: number;
  wrapperSwaps: number;
  counterpartySwaps: number;
  cycleOpenedAt: number | null;
  cycleGain: bigint | null;
  /** Cycles closed by a sale since hold times are folded, those held under
   * ledgerFlashHoldSeconds, and the shortest. Null together on a position
   * that predates the fold, whose earlier closures carry no hold time; a
   * closure then leaves them null. */
  closedCycles: number | null;
  flashCycles: number | null;
  shortestCycleSeconds: number | null;
  firstBlock: number;
  lastBlock: number;
  lastTimestamp: number;
  supported: boolean;
  flags: LedgerFlag[];
}
export interface LedgerWalletHour {
  wallet: string;
  poolId: string;
  hour: number;
  realized: bigint;
  disposedCost: bigint;
  proceeds: bigint;
  spent: bigint;
  volume: bigint;
  buys: number;
  sells: number;
  supportedTrades: number;
  wins: number;
  losses: number;
  closures: number;
  holdSeconds: number;
  /** Of closures, those held under ledgerFlashHoldSeconds; null on a row that
   * predates the fold, and a closure then leaves it null. */
  flashClosures: number | null;
  best: bigint | null;
}
export interface LedgerPoolHour {
  poolId: string;
  hour: number;
  trades: number;
  buys: number;
  sells: number;
  unattributed: number;
  volume: bigint;
  buyers: number;
  sellers: number;
  open: bigint;
  close: bigint;
  high: bigint;
  low: bigint;
  closeBlock: number;
  closeLogIndex: number;
}
export interface LedgerPoolState {
  poolId: string;
  trades: number;
  volume: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  priceBlock: number;
  priceLogIndex: number;
  priceTx: string;
  priceTimestamp: number;
  firstTradeTimestamp: number;
  lastTradeTimestamp: number;
}
export interface LedgerLiveTrade extends LogSite {
  poolId: string;
  wallet: string | null;
  side: LedgerSide;
  ethWei: bigint;
  tokenRaw: bigint;
  sqrtPriceX96: bigint;
  attribution: LedgerAttribution;
}
/** One sale's realized value: the per-sale row a D3 flip would persist. */
export interface LedgerSale extends LogSite {
  poolId: string;
  wallet: string;
  ethWei: bigint;
  tokenRaw: bigint;
  realized: bigint;
  disposedCost: bigint;
  closedGain: bigint | null;
  closedHoldSeconds: number | null;
  /** False when the position was excluded at or before this sale. */
  supported: boolean;
}
export interface LedgerState {
  positions: Map<string, LedgerPosition>;
  walletHours: Map<string, LedgerWalletHour>;
  poolHours: Map<string, LedgerPoolHour>;
  pools: Map<string, LedgerPoolState>;
}
export interface LedgerApplication {
  liveTrades: LedgerLiveTrade[];
  sales: LedgerSale[];
  /** Positions that became excluded during this application. Every hour row
   * they ever touched has its finances zeroed; the state's rows already are,
   * rows outside the state are the writer's to zero. */
  excluded: LedgerPosition[];
  changed: {
    positions: Set<string>;
    walletHours: Set<string>;
    poolHours: Set<string>;
    pools: Set<string>;
  };
}
/** The rows a batch can touch, known before it is applied so a writer can
 * load and journal them first. */
export interface LedgerKeys {
  positions: { poolId: string; wallet: string }[];
  walletHours: { wallet: string; poolId: string; hour: number }[];
  poolHours: { poolId: string; hour: number }[];
  pools: string[];
  wallets: { wallet: string; firstBlock: number }[];
}

export const positionKey = (poolId: string, wallet: string) =>
  `${poolId}:${wallet}`;
export const walletHourKey = (wallet: string, poolId: string, hour: number) =>
  `${wallet}:${poolId}:${hour}`;
export const poolHourKey = (poolId: string, hour: number) =>
  `${poolId}:${hour}`;
export function createLedgerState(): LedgerState {
  return {
    positions: new Map(),
    walletHours: new Map(),
    poolHours: new Map(),
    pools: new Map(),
  };
}

const hex32 = /^0x[0-9a-f]{64}$/;
const hex20 = /^0x[0-9a-f]{40}$/;
function address(value: string, what: string) {
  const v = value.toLowerCase();
  if (!hex20.test(v)) throw Error(`ledger_invalid_${what}`);
  return v;
}
function amount(value: string, what: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw Error(`ledger_invalid_${what}`);
  return BigInt(value);
}
function site(row: LogSite): LogSite {
  const txHash = row.txHash.toLowerCase(),
    blockHash = row.blockHash.toLowerCase();
  if (
    !hex32.test(txHash) ||
    !hex32.test(blockHash) ||
    !Number.isSafeInteger(row.logIndex) ||
    row.logIndex < 0 ||
    !Number.isSafeInteger(row.block) ||
    row.block < 0 ||
    !Number.isSafeInteger(row.timestamp) ||
    row.timestamp < 0
  )
    throw Error("ledger_invalid_log");
  return {
    txHash,
    logIndex: row.logIndex,
    block: row.block,
    blockHash,
    timestamp: row.timestamp,
  };
}
const logOrder = (a: LogSite, b: LogSite) =>
  a.block - b.block || a.logIndex - b.logIndex;
type CheckedSwap = LogSite &
  SwapQuote & { poolId: string; token: string; wrapper: boolean };
type CheckedTransfer = LogSite & {
  token: string;
  from: string;
  to: string;
  value: bigint;
};

/** The attribution rule (report section 4.3), per transaction: the beneficiary
 * of a swap is the address whose net token movement in the swap's direction
 * is at least the swapped amount, the initiator when it qualifies, otherwise
 * the only candidate. Its remainder and every other net movement of the token
 * in the transaction are inflows at zero cost or outflows with basis removal.
 * A transaction with two swaps of one pool, or without a single candidate,
 * leaves the swap unattributed and marks every address whose balance of the
 * token moved in it; nothing of that transaction is applied.
 * Swaps apply before residual transfers; transactions in block order, both in
 * log order. */
export function planLedgerBatch(
  rows: LedgerBatchRows,
  rules: LedgerRules,
): LedgerEvent[] {
  const manager = address(rules.manager, "manager"),
    router = address(rules.router, "router");
  const infrastructure = new Set([manager, ledgerZeroAddress]);
  const poolByToken = new Map<string, string>();
  for (const e of rows.registry) {
    const token = address(e.token, "token"),
      poolId = e.poolId.toLowerCase();
    if (!hex32.test(poolId)) throw Error("ledger_invalid_pool");
    if (poolByToken.has(token) && poolByToken.get(token) !== poolId)
      throw Error("ledger_ambiguous_token");
    poolByToken.set(token, poolId);
  }
  const seen = new Set<string>();
  const logId = (s: LogSite) => `${s.txHash}:${s.logIndex}`;
  const swaps: CheckedSwap[] = rows.swaps
    .map((s) => {
      const at = site(s);
      const poolId = s.poolId.toLowerCase(),
        token = address(s.token, "token");
      if (!hex32.test(poolId)) throw Error("ledger_invalid_pool");
      if (poolByToken.get(token) !== poolId)
        throw Error("ledger_unregistered_swap");
      const ethWei = amount(s.ethWei, "eth"),
        tokenRaw = amount(s.tokenRaw, "token_amount");
      if (
        ethWei <= 0n ||
        tokenRaw <= 0n ||
        (s.side !== "buy" && s.side !== "sell") ||
        !Number.isSafeInteger(s.tick)
      )
        throw Error("ledger_invalid_swap");
      if (seen.has(logId(at))) throw Error("ledger_duplicate_log");
      seen.add(logId(at));
      return {
        ...at,
        poolId,
        token,
        initiator: address(s.initiator, "initiator"),
        wrapper: s.txTo === null || address(s.txTo, "tx_to") !== router,
        side: s.side,
        ethWei,
        tokenRaw,
        sqrtPriceX96: amount(s.sqrtPriceX96, "price"),
        liquidity: amount(s.liquidity, "liquidity"),
        tick: s.tick,
      };
    })
    .sort(logOrder);
  const transfers: CheckedTransfer[] = rows.transfers
    .map((t) => {
      const at = site(t);
      const token = address(t.token, "token");
      if (!poolByToken.has(token)) throw Error("ledger_unregistered_transfer");
      if (seen.has(logId(at))) throw Error("ledger_duplicate_log");
      seen.add(logId(at));
      return {
        ...at,
        token,
        from: address(t.from, "transfer_from"),
        to: address(t.to, "transfer_to"),
        value: amount(t.value, "transfer_value"),
      };
    })
    .sort(logOrder);
  interface Tx {
    first: LogSite;
    swaps: CheckedSwap[];
    transfers: CheckedTransfer[];
  }
  const txs = new Map<string, Tx>();
  const tx = (at: LogSite) => {
    let t = txs.get(at.txHash);
    if (!t) {
      t = { first: at, swaps: [], transfers: [] };
      txs.set(at.txHash, t);
    }
    if (
      t.first.block !== at.block ||
      t.first.blockHash !== at.blockHash ||
      t.first.timestamp !== at.timestamp
    )
      throw Error("ledger_split_transaction");
    if (logOrder(at, t.first) < 0) t.first = at;
    return t;
  };
  for (const s of swaps) tx(s).swaps.push(s);
  for (const t of transfers) tx(t).transfers.push(t);
  const events: LedgerEvent[] = [];
  const unattributed = (s: CheckedSwap, wallets: string[]): LedgerEvent => ({
    kind: "unattributed_swap",
    txHash: s.txHash,
    logIndex: s.logIndex,
    block: s.block,
    blockHash: s.blockHash,
    timestamp: s.timestamp,
    poolId: s.poolId,
    wallets,
    side: s.side,
    ethWei: s.ethWei,
    tokenRaw: s.tokenRaw,
    sqrtPriceX96: s.sqrtPriceX96,
    liquidity: s.liquidity,
    tick: s.tick,
    initiator: s.initiator,
  });
  const movement = (
    at: LogSite,
    poolId: string,
    wallet: string,
    net: bigint,
  ): LedgerEvent => ({
    kind: net > 0n ? "inflow" : "outflow",
    txHash: at.txHash,
    logIndex: at.logIndex,
    block: at.block,
    blockHash: at.blockHash,
    timestamp: at.timestamp,
    poolId,
    wallet,
    tokenRaw: net > 0n ? net : -net,
  });
  const ordered = [...txs.values()].sort((a, b) => logOrder(a.first, b.first));
  for (const t of ordered) {
    // Net movement per token per address, addresses in first-appearance order.
    const nets = new Map<string, Map<string, bigint>>();
    for (const x of t.transfers) {
      if (x.value === 0n) continue;
      let net = nets.get(x.token);
      if (!net) nets.set(x.token, (net = new Map()));
      net.set(x.from, (net.get(x.from) ?? 0n) - x.value);
      net.set(x.to, (net.get(x.to) ?? 0n) + x.value);
    }
    // Addresses whose balance of the token moved: a pass-through nets to zero.
    const walletsOf = (token: string) =>
      [...(nets.get(token) ?? [])]
        .filter(([a, net]) => net !== 0n && !infrastructure.has(a))
        .map(([a]) => a);
    const groups = new Map<string, CheckedSwap[]>();
    for (const s of t.swaps) {
      if (!groups.has(s.poolId)) groups.set(s.poolId, []);
      groups.get(s.poolId)!.push(s);
    }
    const handled = new Set<string>();
    for (const group of groups.values()) {
      const token = group[0].token;
      handled.add(token);
      const net = nets.get(token) ?? new Map<string, bigint>();
      const moved = walletsOf(token);
      if (group.length > 1) {
        for (const s of group) events.push(unattributed(s, moved));
        continue;
      }
      const s = group[0];
      const sign = s.side === "buy" ? 1n : -1n;
      const candidates = moved.filter((a) => net.get(a)! * sign >= s.tokenRaw);
      const beneficiary = candidates.includes(s.initiator)
        ? s.initiator
        : candidates.length === 1
          ? candidates[0]
          : null;
      if (beneficiary === null) {
        events.push(unattributed(s, moved));
        continue;
      }
      events.push({
        kind: "swap",
        txHash: s.txHash,
        logIndex: s.logIndex,
        block: s.block,
        blockHash: s.blockHash,
        timestamp: s.timestamp,
        poolId: s.poolId,
        wallet: beneficiary,
        attribution: beneficiary === s.initiator ? "initiator" : "counterparty",
        wrapper: s.wrapper,
        side: s.side,
        ethWei: s.ethWei,
        tokenRaw: s.tokenRaw,
        sqrtPriceX96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        tick: s.tick,
        initiator: s.initiator,
      });
      const remainder = net.get(beneficiary)! * sign - s.tokenRaw;
      if (remainder > 0n)
        events.push(movement(s, s.poolId, beneficiary, sign * remainder));
      for (const a of moved)
        if (a !== beneficiary)
          events.push(movement(s, s.poolId, a, net.get(a)!));
    }
    for (const [token, net] of nets) {
      if (handled.has(token)) continue;
      const poolId = poolByToken.get(token)!;
      for (const a of walletsOf(token)) {
        const first = t.transfers.find(
          (x) => x.token === token && (x.from === a || x.to === a),
        )!;
        events.push(movement(first, poolId, a, net.get(a)!));
      }
    }
  }
  return events;
}

/** The rows the events can touch; a wallet's first block is the earliest event
 * that names it. */
export function ledgerKeys(events: readonly LedgerEvent[]): LedgerKeys {
  const positions = new Map<string, { poolId: string; wallet: string }>();
  const walletHours = new Map<
    string,
    { wallet: string; poolId: string; hour: number }
  >();
  const poolHours = new Map<string, { poolId: string; hour: number }>();
  const pools = new Set<string>();
  const wallets = new Map<string, number>();
  const wallet = (poolId: string, w: string, block: number) => {
    positions.set(positionKey(poolId, w), { poolId, wallet: w });
    wallets.set(w, Math.min(wallets.get(w) ?? block, block));
  };
  for (const e of events) {
    pools.add(e.poolId);
    if (e.kind === "unattributed_swap") {
      for (const w of e.wallets) wallet(e.poolId, w, e.block);
    } else wallet(e.poolId, e.wallet, e.block);
    if (e.kind === "swap" || e.kind === "unattributed_swap") {
      const hour = ledgerHour(e.timestamp);
      poolHours.set(poolHourKey(e.poolId, hour), { poolId: e.poolId, hour });
      if (e.kind === "swap")
        walletHours.set(walletHourKey(e.wallet, e.poolId, hour), {
          wallet: e.wallet,
          poolId: e.poolId,
          hour,
        });
    }
  }
  return {
    positions: [...positions.values()],
    walletHours: [...walletHours.values()],
    poolHours: [...poolHours.values()],
    pools: [...pools],
    wallets: [...wallets].map(([w, firstBlock]) => ({ wallet: w, firstBlock })),
  };
}

function newPosition(
  poolId: string,
  wallet: string,
  at: LogSite,
): LedgerPosition {
  return {
    poolId,
    wallet,
    quantity: 0n,
    cost: 0n,
    invested: 0n,
    proceeds: 0n,
    disposedCost: 0n,
    realized: 0n,
    inflow: 0n,
    outflow: 0n,
    outflowCost: 0n,
    buys: 0,
    sells: 0,
    wrapperSwaps: 0,
    counterpartySwaps: 0,
    cycleOpenedAt: null,
    cycleGain: null,
    closedCycles: 0,
    flashCycles: 0,
    shortestCycleSeconds: null,
    firstBlock: at.block,
    lastBlock: at.block,
    lastTimestamp: at.timestamp,
    supported: true,
    flags: [],
  };
}
function newWalletHour(
  wallet: string,
  poolId: string,
  hour: number,
): LedgerWalletHour {
  return {
    wallet,
    poolId,
    hour,
    realized: 0n,
    disposedCost: 0n,
    proceeds: 0n,
    spent: 0n,
    volume: 0n,
    buys: 0,
    sells: 0,
    supportedTrades: 0,
    wins: 0,
    losses: 0,
    closures: 0,
    holdSeconds: 0,
    flashClosures: 0,
    best: null,
  };
}
/** An excluded position contributes counts and volume, never finances. */
export function zeroWalletHourFinances(row: LedgerWalletHour) {
  row.realized = 0n;
  row.disposedCost = 0n;
  row.proceeds = 0n;
  row.spent = 0n;
  row.supportedTrades = 0;
  row.wins = 0;
  row.losses = 0;
  row.closures = 0;
  row.holdSeconds = 0;
  row.flashClosures = 0;
  row.best = null;
}
/** Flags follow the counters; excluding flags are sticky. */
function refreshFlags(p: LedgerPosition) {
  const flags = new Set<LedgerFlag>(
    p.flags.filter((f) => ledgerExcludingFlags.includes(f)),
  );
  if (p.inflow > 0n) flags.add("zero_cost_inflow");
  if (p.wrapperSwaps > 0) flags.add("wrapper_route");
  if (p.counterpartySwaps > 0) flags.add("counterparty_route");
  p.flags = [...flags].sort();
  p.supported = !p.flags.some((f) => ledgerExcludingFlags.includes(f));
}
/** Basis of `tokenRaw` at average cost: the whole cost when the inventory
 * closes, else the floor share (foldTrades). */
function basisOf(p: LedgerPosition, tokenRaw: bigint) {
  return tokenRaw === p.quantity ? p.cost : (p.cost * tokenRaw) / p.quantity;
}

/** Apply planned events to a state holding every row they can touch (missing
 * rows are new). Buys and sells are foldTrades; a sell or an outflow above the
 * held quantity empties the inventory and excludes the position with
 * `unknown_basis`, as foldTrades does; an unattributed swap excludes every
 * position its token touched. Inventory cycles open when the quantity leaves
 * zero and close on the sell that returns it to zero, exactly the closures
 * walletMetrics derives; an outflow that empties the inventory ends the cycle
 * without a closure, since a transfer out is not a sale. */
export function applyLedgerEvents(
  state: LedgerState,
  events: readonly LedgerEvent[],
): LedgerApplication {
  const out: LedgerApplication = {
    liveTrades: [],
    sales: [],
    excluded: [],
    changed: {
      positions: new Set(),
      walletHours: new Set(),
      poolHours: new Set(),
      pools: new Set(),
    },
  };
  const position = (poolId: string, wallet: string, at: LogSite) => {
    const key = positionKey(poolId, wallet);
    let p = state.positions.get(key);
    if (!p) state.positions.set(key, (p = newPosition(poolId, wallet, at)));
    if (at.block < p.lastBlock) throw Error("ledger_out_of_order");
    p.lastBlock = at.block;
    p.lastTimestamp = at.timestamp;
    out.changed.positions.add(key);
    return p;
  };
  const exclude = (p: LedgerPosition, flag: LedgerFlag) => {
    if (p.flags.includes(flag)) return;
    const wasSupported = p.supported;
    p.flags = [...p.flags, flag];
    refreshFlags(p);
    if (!wasSupported) return;
    out.excluded.push(p);
    for (const [key, row] of state.walletHours)
      if (row.wallet === p.wallet && row.poolId === p.poolId) {
        zeroWalletHourFinances(row);
        out.changed.walletHours.add(key);
      }
  };
  const openCycle = (p: LedgerPosition, before: bigint, at: LogSite) => {
    if (before === 0n && p.quantity > 0n) {
      p.cycleOpenedAt = at.timestamp;
      p.cycleGain = 0n;
    }
  };
  const walletHour = (e: LedgerEvent & { wallet: string }) => {
    const hour = ledgerHour(e.timestamp);
    const key = walletHourKey(e.wallet, e.poolId, hour);
    let row = state.walletHours.get(key);
    if (!row)
      state.walletHours.set(
        key,
        (row = newWalletHour(e.wallet, e.poolId, hour)),
      );
    out.changed.walletHours.add(key);
    return row;
  };
  const poolHour = (e: LedgerEvent & SwapQuote, unattributed: boolean) => {
    const hour = ledgerHour(e.timestamp);
    const key = poolHourKey(e.poolId, hour);
    let row = state.poolHours.get(key);
    if (!row)
      state.poolHours.set(
        key,
        (row = {
          poolId: e.poolId,
          hour,
          trades: 0,
          buys: 0,
          sells: 0,
          unattributed: 0,
          volume: 0n,
          buyers: 0,
          sellers: 0,
          open: e.sqrtPriceX96,
          close: e.sqrtPriceX96,
          high: e.sqrtPriceX96,
          low: e.sqrtPriceX96,
          closeBlock: e.block,
          closeLogIndex: e.logIndex,
        }),
      );
    row.trades++;
    if (e.side === "buy") row.buys++;
    else row.sells++;
    if (unattributed) row.unattributed++;
    row.volume += e.ethWei;
    if (
      logOrder(e, {
        ...e,
        block: row.closeBlock,
        logIndex: row.closeLogIndex,
      }) < 0
    )
      throw Error("ledger_out_of_order");
    row.close = e.sqrtPriceX96;
    row.closeBlock = e.block;
    row.closeLogIndex = e.logIndex;
    if (e.sqrtPriceX96 > row.high) row.high = e.sqrtPriceX96;
    if (e.sqrtPriceX96 < row.low) row.low = e.sqrtPriceX96;
    out.changed.poolHours.add(key);
    return row;
  };
  const poolState = (e: LedgerEvent & SwapQuote) => {
    let row = state.pools.get(e.poolId);
    if (!row)
      state.pools.set(
        e.poolId,
        (row = {
          poolId: e.poolId,
          trades: 0,
          volume: 0n,
          sqrtPriceX96: e.sqrtPriceX96,
          liquidity: e.liquidity,
          tick: e.tick,
          priceBlock: e.block,
          priceLogIndex: e.logIndex,
          priceTx: e.txHash,
          priceTimestamp: e.timestamp,
          firstTradeTimestamp: e.timestamp,
          lastTradeTimestamp: e.timestamp,
        }),
      );
    if (
      logOrder(e, {
        ...e,
        block: row.priceBlock,
        logIndex: row.priceLogIndex,
      }) < 0
    )
      throw Error("ledger_out_of_order");
    row.trades++;
    row.volume += e.ethWei;
    row.sqrtPriceX96 = e.sqrtPriceX96;
    row.liquidity = e.liquidity;
    row.tick = e.tick;
    row.priceBlock = e.block;
    row.priceLogIndex = e.logIndex;
    row.priceTx = e.txHash;
    row.priceTimestamp = e.timestamp;
    row.lastTradeTimestamp = e.timestamp;
    out.changed.pools.add(e.poolId);
  };
  for (const e of events) {
    if (e.kind === "swap" || e.kind === "unattributed_swap") {
      poolState(e);
      const hour = poolHour(e, e.kind === "unattributed_swap");
      out.liveTrades.push({
        txHash: e.txHash,
        logIndex: e.logIndex,
        block: e.block,
        blockHash: e.blockHash,
        timestamp: e.timestamp,
        poolId: e.poolId,
        wallet: e.kind === "swap" ? e.wallet : null,
        side: e.side,
        ethWei: e.ethWei,
        tokenRaw: e.tokenRaw,
        sqrtPriceX96: e.sqrtPriceX96,
        attribution: e.kind === "swap" ? e.attribution : "unattributed",
      });
      if (e.kind === "unattributed_swap") {
        for (const w of e.wallets)
          exclude(position(e.poolId, w, e), "unattributed_swap_activity");
        continue;
      }
      const p = position(e.poolId, e.wallet, e);
      const row = walletHour(e);
      if (e.wrapper) p.wrapperSwaps++;
      if (e.attribution === "counterparty") p.counterpartySwaps++;
      row.volume += e.ethWei;
      if (e.side === "buy") {
        if (row.buys++ === 0) hour.buyers++;
        const before = p.quantity;
        p.quantity += e.tokenRaw;
        p.cost += e.ethWei;
        p.invested += e.ethWei;
        p.buys++;
        openCycle(p, before, e);
        refreshFlags(p);
        if (p.supported) {
          row.supportedTrades++;
          row.spent += e.ethWei;
        }
        continue;
      }
      if (row.sells++ === 0) hour.sellers++;
      p.sells++;
      p.proceeds += e.ethWei;
      const sale: LedgerSale = {
        txHash: e.txHash,
        logIndex: e.logIndex,
        block: e.block,
        blockHash: e.blockHash,
        timestamp: e.timestamp,
        poolId: e.poolId,
        wallet: e.wallet,
        ethWei: e.ethWei,
        tokenRaw: e.tokenRaw,
        realized: 0n,
        disposedCost: 0n,
        closedGain: null,
        closedHoldSeconds: null,
        supported: false,
      };
      if (e.tokenRaw > p.quantity) {
        // Unknown basis: the whole held cost is disposed, the position is
        // excluded and its inventory emptied, as foldTrades does.
        sale.disposedCost = p.cost;
        sale.realized = e.ethWei - p.cost;
        p.disposedCost += p.cost;
        p.realized += e.ethWei - p.cost;
        p.quantity = 0n;
        p.cost = 0n;
        p.cycleOpenedAt = null;
        p.cycleGain = null;
        refreshFlags(p);
        exclude(p, "unknown_basis");
        out.sales.push(sale);
        continue;
      }
      const basis = basisOf(p, e.tokenRaw);
      const gain = e.ethWei - basis;
      p.quantity -= e.tokenRaw;
      p.cost -= basis;
      p.disposedCost += basis;
      p.realized += gain;
      sale.disposedCost = basis;
      sale.realized = gain;
      if (p.cycleGain !== null) p.cycleGain += gain;
      const closed = p.quantity === 0n && p.cycleOpenedAt !== null;
      const flash =
        closed && e.timestamp - p.cycleOpenedAt! < ledgerFlashHoldSeconds;
      if (closed) {
        sale.closedGain = p.cycleGain;
        sale.closedHoldSeconds = e.timestamp - p.cycleOpenedAt!;
        p.cycleOpenedAt = null;
        p.cycleGain = null;
        if (p.closedCycles !== null && p.flashCycles !== null) {
          p.closedCycles++;
          if (flash) p.flashCycles++;
          p.shortestCycleSeconds = Math.min(
            p.shortestCycleSeconds ?? sale.closedHoldSeconds,
            sale.closedHoldSeconds,
          );
        }
      }
      refreshFlags(p);
      sale.supported = p.supported;
      out.sales.push(sale);
      if (!p.supported) continue;
      row.supportedTrades++;
      row.proceeds += e.ethWei;
      row.disposedCost += basis;
      row.realized += gain;
      if (row.best === null || gain > row.best) row.best = gain;
      if (closed) {
        row.closures++;
        row.holdSeconds += sale.closedHoldSeconds!;
        if (flash && row.flashClosures !== null) row.flashClosures++;
        if (sale.closedGain! > 0n) row.wins++;
        else if (sale.closedGain! < 0n) row.losses++;
      }
      continue;
    }
    const p = position(e.poolId, e.wallet, e);
    if (e.kind === "inflow") {
      const before = p.quantity;
      p.quantity += e.tokenRaw;
      p.inflow += e.tokenRaw;
      openCycle(p, before, e);
      refreshFlags(p);
      continue;
    }
    p.outflow += e.tokenRaw;
    if (e.tokenRaw > p.quantity) {
      p.outflowCost += p.cost;
      p.quantity = 0n;
      p.cost = 0n;
      p.cycleOpenedAt = null;
      p.cycleGain = null;
      refreshFlags(p);
      exclude(p, "unknown_basis");
      continue;
    }
    const basis = basisOf(p, e.tokenRaw);
    p.quantity -= e.tokenRaw;
    p.cost -= basis;
    p.outflowCost += basis;
    if (p.quantity === 0n) {
      p.cycleOpenedAt = null;
      p.cycleGain = null;
    }
    refreshFlags(p);
  }
  return out;
}

/** Position-level identities the database enforces; true for every position
 * this module produces, at every step. */
export function ledgerIdentitiesHold(p: LedgerPosition) {
  return (
    p.realized === p.proceeds - p.disposedCost &&
    p.invested === p.cost + p.disposedCost + p.outflowCost &&
    p.quantity >= 0n &&
    p.cost >= 0n &&
    p.inflow > 0n === p.flags.includes("zero_cost_inflow") &&
    (p.cycleOpenedAt === null) === (p.cycleGain === null) &&
    p.quantity > 0n === (p.cycleOpenedAt !== null) &&
    (p.closedCycles === null) === (p.flashCycles === null) &&
    (p.shortestCycleSeconds === null) ===
      (p.closedCycles === null || p.closedCycles === 0) &&
    (p.flashCycles ?? 0) <= (p.closedCycles ?? 0) &&
    (!p.flashCycles || p.shortestCycleSeconds! < ledgerFlashHoldSeconds) &&
    p.supported === !p.flags.some((f) => ledgerExcludingFlags.includes(f))
  );
}
