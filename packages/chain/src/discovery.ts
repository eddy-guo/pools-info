import { toEventSelector } from "viem";
import { contracts, launchEvent, type RawLog } from "./events";
import type { Rpc } from "./rpc";

// Find the newest sample first. Report only the range actually scanned;
// stopping early must never look like complete discovery of the maximum span.
export async function discoverRecentLaunches(
  rpc: Pick<Rpc, "logs">,
  fromBlock: number,
  toBlock: number,
  limit: number,
) {
  const launches: RawLog[] = [];
  let scannedFrom = toBlock;
  for (let end = toBlock; end >= fromBlock; end -= 10000) {
    scannedFrom = Math.max(fromBlock, end - 9999);
    launches.unshift(
      ...(await rpc.logs(
        contracts.strategies,
        [toEventSelector(launchEvent)],
        scannedFrom,
        end,
      )),
    );
    if (launches.length >= limit) break;
  }
  return { launches, fromBlock: scannedFrom };
}
