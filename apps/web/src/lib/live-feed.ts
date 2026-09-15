import type { LiveTradeFeedResponse } from "@pools/core";
const hash = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const address = (v: unknown): v is string =>
  typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const integer = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const iso = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const amount = (v: unknown) =>
  typeof v === "string" &&
  /^[1-9][0-9]{0,77}$/.test(v) &&
  BigInt(v) < 1n << 256n;
/** Public persisted-feed boundary shared by the proxy and browser. No RPC calls. */
export function validateLiveFeed(
  value: unknown,
  poolId?: string,
): LiveTradeFeedResponse {
  const data = value as LiveTradeFeedResponse;
  if (
    !data ||
    typeof data !== "object" ||
    data.source !== "indexed_recent_chain_events" ||
    data.replacement !== true ||
    !iso(data.generatedAt) ||
    typeof data.truncated !== "boolean" ||
    data.poolId !== (poolId ?? null) ||
    !Array.isArray(data.events) ||
    data.events.length > 50
  )
    throw Error("Invalid saved feed");
  const c = data.coverage;
  if (
    !c ||
    !["uninitialized", "current", "stale"].includes(c.state) ||
    c.scope !== "verified_pools_launches_only" ||
    c.registryExhaustive !== false ||
    c.pnlAvailable !== false ||
    !integer(c.knownPools) ||
    !integer(c.staleAfterSeconds) ||
    c.staleAfterSeconds === 0 ||
    ![
      c.startBlock,
      c.headBlock,
      c.throughBlock,
      c.asOf,
      c.lagBlocks,
      c.discoveryThroughBlock,
      c.discoveryLagBlocks,
    ].every((v) => v === null || integer(v)) ||
    (c.throughHash !== null && !hash(c.throughHash)) ||
    (c.checkedAt !== null && !iso(c.checkedAt))
  )
    throw Error("Invalid saved coverage");
  if (
    c.state === "current" &&
    (c.throughBlock === null ||
      c.asOf === null ||
      c.checkedAt === null ||
      c.throughHash === null)
  )
    throw Error("Missing saved cutoff");
  const seen = new Map<string, string>();
  for (const e of data.events) {
    if (
      !e ||
      !hash(e.poolId) ||
      (poolId && e.poolId.toLowerCase() !== poolId) ||
      !address(e.token) ||
      !hash(e.launchTx) ||
      !hash(e.transactionHash) ||
      !hash(e.blockHash) ||
      !integer(e.logIndex) ||
      !integer(e.block) ||
      !integer(e.timestamp) ||
      c.throughBlock === null ||
      e.block > c.throughBlock ||
      (c.startBlock !== null && e.block < c.startBlock) ||
      c.asOf === null ||
      e.timestamp > c.asOf ||
      !["buy", "sell"].includes(e.side) ||
      !amount(e.ethWei) ||
      !amount(e.tokenRaw) ||
      (e.transactionInitiator !== null && !address(e.transactionInitiator)) ||
      e.attribution !== "transaction_initiator_only" ||
      typeof e.name !== "string" ||
      e.name.length > 256 ||
      typeof e.symbol !== "string" ||
      e.symbol.length > 128 ||
      e.id !== `${e.transactionHash.toLowerCase()}:${e.logIndex}`
    )
      throw Error("Invalid saved trade");
    const serialized = JSON.stringify(e),
      prior = seen.get(e.id);
    if (prior && prior !== serialized) throw Error("Conflicting saved trade");
    seen.set(e.id, serialized);
  }
  return data;
}
