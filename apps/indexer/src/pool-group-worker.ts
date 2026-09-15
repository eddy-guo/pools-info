import { collectPoolEventGroup, type Rpc } from "@pools/chain";
import { commitPoolGroup, type Client, type Stream } from "@pools/db";
import { canonicalHeader, reconcileStream } from "./checkpoints";

/** Shorten the first range to a shared boundary; never skip earlier blocks. */
export function alignedPoolEnd(
  from: number,
  batchSize: number,
  confirmed: number,
) {
  if (
    !Number.isSafeInteger(from) ||
    from < 0 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 2000 ||
    !Number.isSafeInteger(confirmed)
  )
    throw Error("Invalid aligned pool range");
  return Math.min(
    confirmed,
    Math.floor(from / batchSize) * batchSize + batchSize - 1,
  );
}

export async function runPoolGroup(
  db: Client,
  initial: (Stream & { token: string })[],
  rpc: Rpc,
  batchSize: number,
  signal?: AbortSignal,
) {
  const started = performance.now();
  if (
    !initial.length ||
    initial.length > 200 ||
    initial.some((p) => p.kind !== "pool" || !p.poolId)
  )
    throw Error("Invalid pool worker group");
  if (Number(await rpc.call<string>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  // Share only the starting reconciliation observations. Collection boundaries
  // below are always fetched afresh, including the final canonical recheck.
  const observations = new Map<
    number,
    Awaited<ReturnType<typeof canonicalHeader>>
  >();
  const read = async (n: number) => {
    if (!observations.has(n))
      observations.set(n, await canonicalHeader(rpc, n));
    return observations.get(n)!;
  };
  const group: (Stream & { token: string })[] = [];
  for (const pool of initial)
    group.push({
      ...(await reconcileStream(db, pool, rpc, read)),
      token: pool.token,
    });
  const from = group[0].cursor === null ? group[0].start : group[0].cursor + 1;
  if (group.some((p) => (p.cursor === null ? p.start : p.cursor + 1) !== from))
    throw Error("Group cursors changed; reselect before collecting");
  const head = Number(await rpc.call<string>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  const to = alignedPoolEnd(from, batchSize, head - 128);
  if (from > to || signal?.aborted) return { pools: group.length, advanced: 0 };
  const first = await canonicalHeader(rpc, from);
  if (group.some((p) => p.hash && first.parentHash !== p.hash))
    throw Error("Checkpoint parent changed");
  const results = await collectPoolEventGroup(
    {
      fromBlock: from,
      toBlock: to,
      pools: group.map((p) => ({ poolId: p.poolId!, token: p.token })),
    },
    rpc,
  );
  if (
    results.some((r) => r.fromBlockParentHash !== first.parentHash) ||
    (await canonicalHeader(rpc, from)).hash !== first.hash ||
    (await canonicalHeader(rpc, to)).hash !== results[0].blockHash
  )
    throw Error("Pool group boundary changed");
  if (signal?.aborted) return { pools: group.length, advanced: 0 };
  await commitPoolGroup(
    db,
    results.map((result, i) => ({
      expected: group[i],
      batch: {
        from,
        to,
        hash: result.blockHash,
        token: group[i].token,
        evidence: result.evidence,
        events: [
          ...result.swaps.map((e) => ({
            ...e,
            kind: "swap" as const,
            payload: e,
          })),
          ...result.transfers.map((e) => ({
            ...e,
            kind: "transfer" as const,
            payload: e,
          })),
        ],
      },
    })),
  );
  const summary = {
    pools: group.length,
    from,
    to,
    advanced: to - from + 1,
    swaps: results.reduce((n, r) => n + r.swaps.length, 0),
    transfers: results.reduce((n, r) => n + r.transfers.length, 0),
    httpRequests: rpc.requests,
    rpcCalls: rpc.calls,
    elapsedMs: Math.round(performance.now() - started),
  };
  console.log(JSON.stringify({ event: "indexed_group", ...summary }));
  return summary;
}
