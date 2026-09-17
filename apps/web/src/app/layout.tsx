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
import { LiveProvider } from "@/components/live-provider";
import initial from "../../../../data/snapshots/chain.json";
import type { ChainSnapshot } from "@pools/core";

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
        <LiveProvider initial={initial as ChainSnapshot}>
          <EthPriceProvider>
            <Shell>{children}</Shell>
          </EthPriceProvider>
        </LiveProvider>
      </body>
    </html>
  );
}
