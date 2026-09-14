import { initialSnapshot } from "@/lib/data";
import { poolHref } from "@pools/core";
export const dynamic = "force-static";
export function GET() {
  return Response.json({
    capturedAt: initialSnapshot.generatedAt,
    scope: "Build-time on-chain token sample",
    tokens: initialSnapshot.markets.map((m) => ({
      name: m.name,
      symbol: m.symbol,
      address: m.token,
      href: poolHref(m),
    })),
  });
}
