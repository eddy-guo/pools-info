import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";
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
    "Explore real Robinhood Chain instant launches, swaps, and per-pool trader audits with explicit block coverage.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <LiveProvider initial={initial as ChainSnapshot}>
          <Shell>{children}</Shell>
        </LiveProvider>
      </body>
    </html>
  );
}
