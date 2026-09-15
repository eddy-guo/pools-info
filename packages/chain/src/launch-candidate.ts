import { collectCatalog } from "./catalog";
import {
  instantRegistryRevision,
  instantRegistrySourceRevision,
  instantRegistryStartBlock,
} from "./deployments";
import { Rpc, hex } from "./rpc";

export interface LaunchCandidate {
  chainId: 4663;
  launchpadId: string;
  poolId: string;
  token: string;
  creator: string;
  createdAt: string;
}

/** Candidate timestamps locate a small range; only canonical launch evidence
 * establishes membership. This never certifies the gaps between candidates. */
export async function verifyLaunchCandidate(
  candidate: LaunchCandidate,
  rpc: Rpc,
) {
  const timestamp = Date.parse(candidate.createdAt) / 1000;
  if (
    candidate.chainId !== 4663 ||
    candidate.launchpadId !== "uniswap-bonding-curve" ||
    !/^0x[\da-f]{64}$/i.test(candidate.poolId) ||
    ![candidate.token, candidate.creator].every((v) =>
      /^0x[\da-f]{40}$/i.test(v),
    ) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  )
    throw Error("Invalid or unsupported Instant launch candidate");
  if (Number(await rpc.call("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const head = Number(await rpc.call("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head - 128 < instantRegistryStartBlock)
    throw Error("Invalid candidate chain head");
  const confirmed = head - 128;
  const header = async (n: number) => {
    const h = await rpc.call<{
      number: string;
      hash: string;
      timestamp: string;
    }>("eth_getBlockByNumber", [hex(n), false]);
    if (
      !h ||
      Number(h.number) !== n ||
      !/^0x[\da-f]{64}$/i.test(h.hash) ||
      !Number.isSafeInteger(Number(h.timestamp)) ||
      Number(h.timestamp) < 0
    )
      throw Error("Invalid candidate locator header");
    return Number(h.timestamp);
  };
  if (
    timestamp < (await header(instantRegistryStartBlock)) ||
    timestamp > (await header(confirmed))
  )
    throw Error("Candidate timestamp outside confirmed registry history");
  let low = instantRegistryStartBlock,
    high = confirmed;
  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);
    if ((await header(mid)) < timestamp) low = mid + 1;
    else high = mid;
  }
  const fromBlock = Math.max(instantRegistryStartBlock, low - 1);
  const toBlock = Math.min(confirmed, low + 30);
  const result = await collectCatalog(undefined, rpc, { fromBlock, toBlock });
  const pool = result.catalog.pools.find(
    (p) => p.id.toLowerCase() === candidate.poolId.toLowerCase(),
  );
  if (
    !pool ||
    pool.token.toLowerCase() !== candidate.token.toLowerCase() ||
    pool.launchSender.toLowerCase() !== candidate.creator.toLowerCase() ||
    pool.launchedAt !== timestamp
  )
    throw Error("Candidate did not match a verified launch");
  return {
    schemaVersion: 1 as const,
    kind: "verified_instant_candidate" as const,
    registryRevision: instantRegistryRevision,
    registrySourceRevision: instantRegistrySourceRevision,
    verifiedAt: new Date().toISOString(),
    candidate: {
      ...candidate,
      poolId: candidate.poolId.toLowerCase(),
      token: candidate.token.toLowerCase(),
      creator: candidate.creator.toLowerCase(),
    },
    pool,
    fromBlock,
    toBlock,
    ...result,
  };
}
