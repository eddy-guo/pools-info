import type { Metadata } from "next";
import localFont from "next/font/local";
const geist = localFont({
  src: "../../public/fonts/Geist.woff2",
  variable: "--font-geist",
  display: "swap",
  weight: "100 900",
});
const geistMono = localFont({
  src: "../../public/fonts/GeistMono.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
});
import { Shell } from "@/components/shell";
import "./globals.css";
import { EthPriceProvider } from "@/components/eth-price-provider";
import { ToastProvider } from "@/components/saved-toast";
import { LiveProvider } from "@/components/live-provider";
import initial from "../../../../data/snapshots/chain.json";
import type { ChainSnapshot } from "@pools/core";

const fixtureMode = process.env.PRODUCT_FIXTURES === "1";
const emptySnapshot: ChainSnapshot = {
  schemaVersion: 1,
  chainId: 4663,
  generatedAt: "1970-01-01T00:00:00.000Z",
  fromBlock: 0,
  toBlock: 0,
  fromTimestamp: 0,
  toTimestamp: 0,
  blockHash: "",
  discoveredLaunches: 0,
  markets: [],
  trades: [],
  requests: 0,
  durationMs: 0,
  reconciliation: null,
};

export const metadata: Metadata = {
  metadataBase: new URL(process.env.SITE_URL ?? "https://www.poolsinfo.com"),
  title: {
    default: "Pools Info | Explore pools on Robinhood Chain",
    template: "%s | Pools Info",
  },
  description:
    "Explore real Robinhood Chain instant launches, swaps, and per-pool trader audits.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  /* The stylesheet scrolls smoothly; the attribute lets the router jump
     instead of animating when a route changes, so a scroll the screener
     restores on Back never races that animation. */
  return (
    <html
      lang="en"
      className={`${geist.variable} ${geistMono.variable}`}
      data-scroll-behavior="smooth"
    >
      <body>
        <LiveProvider
          initial={fixtureMode ? (initial as ChainSnapshot) : emptySnapshot}
          fixtureMode={fixtureMode}
        >
          <EthPriceProvider>
            <ToastProvider>
              <Shell>{children}</Shell>
            </ToastProvider>
          </EthPriceProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
