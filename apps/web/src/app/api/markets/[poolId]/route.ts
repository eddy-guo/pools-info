import { targetedMarketSnapshot } from "@/lib/chain-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 12;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ poolId: string }> },
) {
  const { poolId } = await params;
  const launch = new URL(request.url).searchParams.get("launch");
  if (
    !/^0x[0-9a-f]{64}$/i.test(poolId) ||
    !launch ||
    !/^0x[0-9a-f]{64}$/i.test(launch)
  )
    return Response.json({ error: "invalid_launch" }, { status: 400 });
  try {
    return Response.json(
      await targetedMarketSnapshot(
        poolId.toLowerCase(),
        launch as `0x${string}`,
        new URL(request.url).searchParams.get("refresh") === "1",
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "market_unavailable_or_outside_bounded_coverage" },
      { status: 503 },
    );
  }
}
