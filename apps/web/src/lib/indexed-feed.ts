import type { RecentSwaps } from "@pools/chain";

/** Server-only URL supplied to the route handler, never sent to the browser. */
export async function indexedFeed(
  base: string,
  ids: string[],
): Promise<RecentSwaps> {
  const url = new URL("/v1/feed", base);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Invalid indexer URL");
  url.searchParams.set("pools", ids.join(","));
  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw Error("Indexed feed unavailable");
  const data = await response.json();
  if (
    !data ||
    data.source !== "indexed_chain_events" ||
    !Number.isSafeInteger(data.fromBlock) ||
    data.fromBlock < 0 ||
    !Number.isSafeInteger(data.toBlock) ||
    data.toBlock < data.fromBlock ||
    !Number.isSafeInteger(data.toTimestamp) ||
    data.toTimestamp < 0 ||
    typeof data.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(data.generatedAt)) ||
    typeof data.truncated !== "boolean" ||
    !Array.isArray(data.events) ||
    data.events.length > 50 ||
    !data.events.every(
      (e: Record<string, unknown>) =>
        e &&
        typeof e.poolId === "string" &&
        ids.includes(e.poolId.toLowerCase()) &&
        typeof e.txHash === "string" &&
        /^0x[0-9a-f]{64}$/i.test(e.txHash) &&
        typeof e.amount0 === "string" &&
        /^-?\d+$/.test(e.amount0) &&
        typeof e.amount1 === "string" &&
        /^-?\d+$/.test(e.amount1) &&
        Number.isSafeInteger(e.logIndex) &&
        Number(e.logIndex) >= 0 &&
        Number.isSafeInteger(e.block) &&
        Number(e.block) >= data.fromBlock &&
        Number(e.block) <= data.toBlock &&
        Number.isSafeInteger(e.timestamp) &&
        Number(e.timestamp) >= 0 &&
        Number(e.timestamp) <= data.toTimestamp &&
        (e.transactionSender === null ||
          (typeof e.transactionSender === "string" &&
            /^0x[0-9a-f]{40}$/i.test(e.transactionSender))),
    )
  )
    throw Error("Invalid indexed feed");
  return data;
}
