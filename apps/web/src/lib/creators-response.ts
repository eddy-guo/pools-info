import type { CreatorsResponse } from "@pools/core";

const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const wei = /^(0|[1-9][0-9]{0,80})$/;
const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;

function validBestLaunch(value: unknown): boolean {
  const pool = value as Record<string, unknown> | null;
  return (
    !!pool &&
    typeof pool.id === "string" &&
    hash.test(pool.id) &&
    typeof pool.token === "string" &&
    address.test(pool.token) &&
    typeof pool.name === "string" &&
    typeof pool.symbol === "string" &&
    typeof pool.launchTx === "string" &&
    hash.test(pool.launchTx) &&
    typeof pool.launchSender === "string" &&
    address.test(pool.launchSender) &&
    integer(pool.launchBlock) &&
    integer(pool.launchedAt) &&
    typeof pool.volumeWei === "string" &&
    wei.test(pool.volumeWei)
  );
}

/** A stale or misrouted response must never show another query's creators. */
export function validateCreatorsResponse(
  value: unknown,
  params: URLSearchParams,
): asserts value is CreatorsResponse {
  const data = value as CreatorsResponse | null;
  if (
    !data ||
    !["launches", "volume", "median"].includes(data.sort) ||
    data.sort !== (params.get("sort") ?? "launches") ||
    !["asc", "desc"].includes(data.direction) ||
    data.direction !== (params.get("direction") ?? "desc") ||
    data.window !== (params.get("window") ?? "All") ||
    data.attribution !== "launch_transaction_initiator" ||
    !Array.isArray(data.items) ||
    data.items.length > Number(params.get("limit") ?? 25) ||
    !integer(data.total) ||
    data.total < data.items.length ||
    (data.nextOffset !== null && !integer(data.nextOffset))
  )
    throw Error("Invalid creators response");
  for (const row of data.items) {
    if (
      !row ||
      typeof row.address !== "string" ||
      !address.test(row.address) ||
      !integer(row.launches) ||
      !integer(row.measured) ||
      !integer(row.traded) ||
      row.measured > row.launches ||
      row.traded > row.measured ||
      (row.volumeWei !== null && !wei.test(row.volumeWei)) ||
      (row.medianVolumeWei !== null && !wei.test(row.medianVolumeWei)) ||
      (row.volumeWei === null) !== (row.measured === 0) ||
      (row.bestLaunch !== null && !validBestLaunch(row.bestLaunch)) ||
      (row.measured === 0) !== (row.bestLaunch === null) ||
      (row.boughtOwnLaunch !== null &&
        typeof row.boughtOwnLaunch !== "boolean") ||
      (row.measured === 0 && row.boughtOwnLaunch !== null)
    )
      throw Error("Invalid creator row");
  }
}
