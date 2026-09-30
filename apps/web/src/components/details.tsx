"use client";
import { ProductWallet } from "./product-wallet";
import type { LiveWindow } from "@pools/core";

export const walletWindows: LiveWindow[] = ["24h", "7d", "30d", "All"];

export function WalletView({ address }: { address: string }) {
  return <ProductWallet address={address} />;
}
