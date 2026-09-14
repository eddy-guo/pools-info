import type { Metadata } from "next";
import { reader } from "@/lib/data";
import { Shell } from "@/components/shell";
import { DataProvider } from "@/components/state";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.SITE_URL ??
      (process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3100"),
  ),
  title: {
    default: "Pools Info | Explore pools on Robinhood Chain",
    template: "%s | Pools Info",
  },
  description:
    "Explore pools, trader performance, and creator activity with transparent snapshot analytics. This preview uses simulated data.",
  robots: { index: false, follow: false },
};
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [manifest, index] = await Promise.all([
    reader.manifest(),
    reader.searchIndex(),
  ]);
  return (
    <html lang="en">
      <body>
        <DataProvider manifest={manifest}>
          <Shell searchIndex={index.filter((r) => r.type !== "Transaction")}>
            {children}
          </Shell>
        </DataProvider>
      </body>
    </html>
  );
}
