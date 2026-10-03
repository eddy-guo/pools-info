import { headers } from "next/headers";
import { ProductExplore } from "@/components/product-explore";
import { admission, visitorAddress } from "@/lib/product-admission";
import { readScreenerStats, readsUpstream } from "@/lib/product-server";
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
  // The render's stats read is charged to the visitor like the product
  // proxy's: a visitor past the admission line gets the page without its
  // stat cards and spends nothing upstream.
  const visitor = visitorAddress(await headers());
  const admitted = readsUpstream()
    ? admission.admit(visitor)
    : { ok: true as const };
  const stats = admitted.ok ? await readScreenerStats(window, visitor) : null;
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: watchlistRowsScript }} />
      <ProductExplore
        initialStats={stats?.status === 200 ? stats.data : null}
        initialSearch={initial.toString()}
      />
    </>
  );
}
