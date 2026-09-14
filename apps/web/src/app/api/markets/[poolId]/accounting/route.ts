import { auditedPoolSnapshot, currentChainSnapshot } from "@/lib/chain-server";
import initial from "../../../../../../../../data/snapshots/chain.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ poolId: string }> },
) {
  const { poolId } = await params;
  if (!/^0x[0-9a-f]{64}$/.test(poolId))
    return Response.json({ error: "unknown_pool" }, { status: 404 });
  if (process.env.CHAIN_REFRESH_DISABLED === "1")
    return Response.json({ error: "refresh_disabled" }, { status: 503 });
  try {
    const current = await currentChainSnapshot().catch(() => initial);
    const market = current.markets.find((p) => p.id === poolId);
    if (!market)
      return Response.json(
        { error: "outside_current_coverage" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    const result = await auditedPoolSnapshot(
      poolId,
      market.launchTx as `0x${string}`,
    );
    return Response.json(
      {
        poolId,
        toBlock: result.toBlock,
        toTimestamp: result.toTimestamp,
        generatedAt: result.generatedAt,
        ...result.markets[0].accounting,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "audit_unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "300" },
      },
    );
  }
}
