import { ProductExplore } from "@/components/product-explore";
import { readScreenerStats } from "@/lib/product-server";
import { windows, type LiveWindow } from "@pools/core";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string }>;
}) {
  const raw = (await searchParams).window;
  const window: LiveWindow =
    raw && Object.hasOwn(windows, raw) ? (raw as LiveWindow) : "24h";
  const stats = await readScreenerStats(window);
  return (
    <ProductExplore initialStats={stats.status === 200 ? stats.data : null} />
  );
}
