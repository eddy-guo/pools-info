import type { Metadata } from "next";
import snapshot from "../../../../../data/snapshots/chain.json";
import { ChainMarkets } from "@/components/chain-markets";
import type { ChainSnapshot } from "@pools/core";

export const metadata: Metadata = {
  title: "On-chain markets",
  description:
    "Real Robinhood Chain instant launches and swaps, with explicit block coverage and transaction evidence.",
};
export default function LivePage() {
  return <ChainMarkets snapshot={snapshot as ChainSnapshot} />;
}
