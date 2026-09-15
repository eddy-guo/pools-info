import { assertObservedMarket } from "@pools/core";

export function validatePoolResponse(
  data: unknown,
  id: string,
  window = "24h",
) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("Invalid saved pool");
  const value = data as Record<string, unknown>;
  const pool = (value.pool ?? value) as Record<string, unknown>;
  if (!pool || typeof pool !== "object" || Array.isArray(pool))
    throw Error("Invalid saved pool identity");
  if (
    pool.poolId !== id ||
    typeof pool.token !== "string" ||
    !/^0x[0-9a-f]{40}$/i.test(pool.token) ||
    typeof pool.name !== "string" ||
    typeof pool.symbol !== "string"
  )
    throw Error("Mismatched saved pool");
  // Older capture responses remain compatible; additive data must be validated.
  const analytics = value.analytics as
    Record<string, unknown> | null | undefined;
  if (
    value.analytics !== null &&
    value.analytics !== undefined &&
    (typeof value.analytics !== "object" ||
      Array.isArray(value.analytics) ||
      !analytics?.snapshot)
  )
    throw Error("Invalid published pool analytics");
  if (analytics?.snapshot) {
    const snapshot = analytics.snapshot as Record<string, unknown>;
    const markets = snapshot.markets;
    const market =
      Array.isArray(markets) && markets.length === 1
        ? (markets[0] as Record<string, unknown>)
        : null;
    if (
      snapshot.schemaVersion !== 1 ||
      snapshot.chainId !== 4663 ||
      !Number.isSafeInteger(snapshot.toBlock) ||
      (snapshot.toBlock as number) < 0 ||
      !Number.isSafeInteger(snapshot.toTimestamp) ||
      (snapshot.toTimestamp as number) < 0 ||
      typeof snapshot.blockHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(snapshot.blockHash) ||
      !market ||
      market.id !== id ||
      typeof market.token !== "string" ||
      market.token.toLowerCase() !== pool.token.toLowerCase()
    )
      throw Error("Invalid published pool identity");
  }
  if (value.market !== undefined && value.market !== null) {
    const launch = pool.launch as Record<string, unknown>;
    if (
      !launch ||
      !Number.isSafeInteger(launch.block) ||
      (launch.block as number) < 0 ||
      !Number.isSafeInteger(launch.timestamp) ||
      (launch.timestamp as number) < 0 ||
      typeof launch.transactionHash !== "string" ||
      !/^0x[0-9a-f]{64}$/.test(launch.transactionHash) ||
      typeof launch.transactionInitiator !== "string" ||
      !/^0x[0-9a-f]{40}$/.test(launch.transactionInitiator)
    )
      throw Error("Invalid saved launch");
    assertObservedMarket(value.market, id, pool.token, window);
  }
}
