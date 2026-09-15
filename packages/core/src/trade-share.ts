import type { FollowingActivityItem } from "./following";

export interface TradeShareResponse {
  trade: Omit<FollowingActivityItem, "id" | "priceWei" | "side"> & {
    side: "sell";
    realizedWei: string;
    disposedCostWei: string;
  };
  scope: "saved_verified_sale";
  coverage: { complete: false; registryExhaustive: false };
}
