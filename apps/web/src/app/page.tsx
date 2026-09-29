import { ProductExplore } from "@/components/product-explore";
import { readScreenerStats } from "@/lib/product-server";
import { windows, type LiveWindow } from "@pools/core";
import { watchlistRowsScript } from "@/lib/watchlist";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = await searchParams;
  const raw = requested.window;
  const window: LiveWindow =
    typeof raw === "string" && Object.hasOwn(windows, raw)
      ? (raw as LiveWindow)
      : "24h";
  const initial = new URLSearchParams();
  for (const [key, value] of Object.entries(requested)) {
    const values = Array.isArray(value)
      ? value
      : value === undefined
        ? []
        : [value];
    for (const item of values) {
      initial.append(key, item);
    }
  }
  const stats = await readScreenerStats(window);
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: watchlistRowsScript }} />
      <ProductExplore
        initialStats={stats.status === 200 ? stats.data : null}
        initialSearch={initial.toString()}
      />
    </>
  );
}
