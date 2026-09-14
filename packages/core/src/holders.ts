import type { Address, Amount } from "./types";

const ZERO = `0x${"0".repeat(40)}`;
const UINT256_MAX = (1n << 256n) - 1n;

export interface HolderTransfer {
  token: Address;
  txHash: Address;
  blockHash: Address;
  block: number;
  logIndex: number;
  from: Address;
  to: Address;
  valueRaw: Amount;
}

export interface HolderCoverage {
  fromBlock: number;
  toBlock: number;
  cutoffBlockHash: Address;
  /** Null when deployment has not been verified. Includes the creation block. */
  tokenBirthBlock: number | null;
}

export interface HolderLedgerOptions {
  token: Address;
  coverage: HolderCoverage;
  /** totalSupply() read at the same captured cutoff, in raw token units. */
  totalSupplyRaw: Amount;
  infrastructure?: readonly { address: Address; label: string }[];
}

export interface HolderBalance {
  address: Address;
  balanceRaw: Amount;
  kind: "holder" | "infrastructure";
  infrastructureLabel: string | null;
}

export interface HolderLedger {
  token: Address;
  coverage: HolderCoverage;
  /** Requires birth coverage AND supply reconciliation. See collector contract. */
  complete: boolean;
  incompleteReasons: ("missing_birth_coverage" | "supply_mismatch")[];
  /** Positive tracked balances, highest balance first, address breaks ties. */
  balances: HolderBalance[];
  positiveHoldersIncludingInfrastructure: number;
  positiveHoldersExcludingInfrastructure: number;
  uniqueTransferCount: number;
  trackedSupplyRaw: Amount;
  totalSupplyRaw: Amount;
  supplyMatches: boolean;
}

function address(value: string): Address {
  if (!/^0x[0-9a-f]{40}$/i.test(value))
    throw new Error("Invalid holder address");
  return value.toLowerCase() as Address;
}

function hash(value: string): Address {
  if (!/^0x[0-9a-f]{64}$/i.test(value))
    throw new Error("Invalid event block/transaction hash");
  return value.toLowerCase() as Address;
}

function index(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid block/log index");
  return value;
}

function amount(value: Amount): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new Error("Invalid raw token amount");
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error("Raw token amount exceeds uint256");
  return parsed;
}

/**
 * Folds canonical ERC20 Transfer events, never prices or cost basis.
 * Collector contract: provide ALL token Transfer logs in the inclusive range,
 * verify canonical blocks and totalSupply at cutoff, and verify token deployment
 * before supplying tokenBirthBlock. Supply equality alone cannot prove that logs
 * are complete, nor that a rebasing/nonstandard token reports balances via events.
 * Incomplete coverage can return tracked balances but cannot claim a full list.
 */
export function buildHolderLedger(
  input: readonly HolderTransfer[],
  options: HolderLedgerOptions,
): HolderLedger {
  const token = address(options.token);
  const coverage = {
    fromBlock: index(options.coverage.fromBlock),
    toBlock: index(options.coverage.toBlock),
    cutoffBlockHash: hash(options.coverage.cutoffBlockHash),
    tokenBirthBlock:
      options.coverage.tokenBirthBlock === null
        ? null
        : index(options.coverage.tokenBirthBlock),
  };
  if (
    coverage.fromBlock > coverage.toBlock ||
    (coverage.tokenBirthBlock !== null &&
      coverage.tokenBirthBlock > coverage.toBlock)
  )
    throw new Error("Invalid holder coverage range");
  const totalSupply = amount(options.totalSupplyRaw);
  const infrastructure = new Map<Address, string>();
  for (const item of options.infrastructure ?? []) {
    const key = address(item.address);
    const label = item.label.trim();
    if (key === ZERO || !label)
      throw new Error("Invalid infrastructure label/address");
    if (infrastructure.has(key) && infrastructure.get(key) !== label)
      throw new Error("Conflicting infrastructure labels");
    infrastructure.set(key, label);
  }
  const events = input
    .map((event) => ({
      token: address(event.token),
      txHash: hash(event.txHash),
      blockHash: hash(event.blockHash),
      block: index(event.block),
      logIndex: index(event.logIndex),
      from: address(event.from),
      to: address(event.to),
      valueRaw: amount(event.valueRaw).toString(),
    }))
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const seen = new Map<string, string>();
  const positions = new Map<string, string>();
  const blockHashes = new Map<number, Address>();
  const balances = new Map<Address, bigint>();
  for (const event of events) {
    if (event.token !== token) throw new Error("Mixed token holder ledger");
    if (
      event.block < coverage.fromBlock ||
      event.block > coverage.toBlock ||
      (coverage.tokenBirthBlock !== null &&
        event.block < coverage.tokenBirthBlock)
    )
      throw new Error("Transfer outside captured coverage");
    if (
      (event.block === coverage.toBlock &&
        event.blockHash !== coverage.cutoffBlockHash) ||
      (blockHashes.has(event.block) &&
        blockHashes.get(event.block) !== event.blockHash)
    )
      throw new Error("Conflicting canonical block hashes");
    blockHashes.set(event.block, event.blockHash);
    const id = `${event.txHash}:${event.logIndex}`;
    const content = JSON.stringify(event);
    if (seen.has(id)) {
      if (seen.get(id) !== content)
        throw new Error("Conflicting duplicate transfer");
      continue;
    }
    const position = `${event.block}:${event.logIndex}`;
    if (positions.has(position))
      throw new Error("Conflicting event block/log position");
    seen.set(id, content);
    positions.set(position, id);
    const value = BigInt(event.valueRaw);
    if (event.from !== ZERO) {
      const balance = balances.get(event.from) ?? 0n;
      if (balance < value)
        throw new Error(
          "Negative holder balance; incomplete or unsupported transfer history",
        );
      balances.set(event.from, balance - value);
    }
    if (event.to !== ZERO) {
      const balance = (balances.get(event.to) ?? 0n) + value;
      if (balance > UINT256_MAX)
        throw new Error("Holder balance exceeds uint256");
      balances.set(event.to, balance);
    }
  }
  const positive = [...balances]
    .filter(([, balance]) => balance > 0n)
    .sort(([a, left], [b, right]) =>
      left > right ? -1 : left < right ? 1 : a < b ? -1 : a > b ? 1 : 0,
    );
  const trackedSupply = positive.reduce(
    (sum, [, balance]) => sum + balance,
    0n,
  );
  if (trackedSupply > UINT256_MAX)
    throw new Error("Tracked supply exceeds uint256");
  const supplyMatches = trackedSupply === totalSupply;
  const incompleteReasons: HolderLedger["incompleteReasons"] = [];
  if (
    coverage.tokenBirthBlock === null ||
    coverage.fromBlock > coverage.tokenBirthBlock
  )
    incompleteReasons.push("missing_birth_coverage");
  if (!supplyMatches) incompleteReasons.push("supply_mismatch");
  return {
    token,
    coverage,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    balances: positive.map(([owner, balance]) => ({
      address: owner,
      balanceRaw: balance.toString(),
      kind: infrastructure.has(owner) ? "infrastructure" : "holder",
      infrastructureLabel: infrastructure.get(owner) ?? null,
    })),
    positiveHoldersIncludingInfrastructure: positive.length,
    positiveHoldersExcludingInfrastructure: positive.filter(
      ([owner]) => !infrastructure.has(owner),
    ).length,
    uniqueTransferCount: seen.size,
    trackedSupplyRaw: trackedSupply.toString(),
    totalSupplyRaw: totalSupply.toString(),
    supplyMatches,
  };
}
