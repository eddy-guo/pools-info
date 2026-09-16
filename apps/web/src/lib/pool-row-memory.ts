"use client";
import { useMemo, useSyncExternalStore } from "react";
import type { AnalyticsPoolRow } from "@pools/core";
/**
 * What a screener row already showed about a pool, kept for this tab only so
 * that opening the row never loses the identity it displayed, even when the
 * read API does not publish that pool's detail.
 */
export interface RememberedPoolRow {
  poolId: string;
  token: string;
  name: string;
  symbol: string;
  imageUrl?: string;
  launch: {
    block: number;
    timestamp: number;
    transactionHash: string;
    transactionInitiator: string;
  };
  /** The row carried market evidence, so its page can still expect a chart. */
  measured: boolean;
}
const key = (poolId: string) => `pools-info:row:${poolId}`;
export function rememberPoolRow(pool: AnalyticsPoolRow): void {
  const row: RememberedPoolRow = {
    poolId: pool.id,
    token: pool.token,
    name: pool.name,
    symbol: pool.symbol,
    imageUrl: pool.imageUrl,
    launch: {
      block: pool.launchBlock,
      timestamp: pool.launchedAt,
      transactionHash: pool.launchTx,
      transactionInitiator: pool.launchSender,
    },
    measured: pool.processed || !!pool.marketCoverage,
  };
  try {
    sessionStorage.setItem(key(pool.id), JSON.stringify(row));
  } catch {
    /* A private window or a full quota simply forgets the row. */
  }
}
function parse(raw: string | null): RememberedPoolRow | null {
  if (!raw) return null;
  try {
    const row = JSON.parse(raw) as RememberedPoolRow;
    return typeof row?.poolId === "string" &&
      typeof row.token === "string" &&
      typeof row.name === "string" &&
      typeof row.symbol === "string" &&
      typeof row.launch?.block === "number" &&
      typeof row.launch.timestamp === "number" &&
      typeof row.launch.transactionHash === "string" &&
      typeof row.launch.transactionInitiator === "string"
      ? row
      : null;
  } catch {
    return null;
  }
}
const noRowUpdates = () => () => {};
/** The server has no session storage, so a direct URL reads nothing here. */
export function useRememberedPoolRow(poolId: string) {
  const raw = useSyncExternalStore(
    noRowUpdates,
    () => {
      try {
        return sessionStorage.getItem(key(poolId));
      } catch {
        return null;
      }
    },
    () => null,
  );
  return useMemo(() => parse(raw), [raw]);
}
