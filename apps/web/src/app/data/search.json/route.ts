import { initialSnapshot } from "@/lib/data";
import { poolHref } from "@pools/core";
import catalog from "../../../../../../data/catalog/chain.json";
export const dynamic = "force-static";
export function GET() {
  return Response.json({
    capturedAt: catalog.generatedAt,
    ranges: catalog.ranges,
    tokens: [
      ...new Map(
        [...catalog.pools, ...initialSnapshot.markets].map((m) => [m.id, m]),
      ).values(),
    ].map((m) => ({
      name: m.name,
      symbol: m.symbol,
      address: m.token,
      href: poolHref(m),
    })),
  });
}
