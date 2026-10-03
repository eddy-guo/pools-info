import {
  auditedPoolSnapshot,
  currentChainSnapshot,
  capturedPoolSnapshot,
} from "../../../../../lib/chain-server";
import {
  admission,
  visitorAddress,
} from "../../../../../lib/product-admission";
import {
  ProductUnavailableError,
  productUnavailableResponse,
  readsUpstream,
} from "../../../../../lib/product-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 240;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ poolId: string }> },
) {
  const { poolId } = await params;
  if (!/^0x[0-9a-f]{64}$/.test(poolId))
    return Response.json({ error: "unknown_pool" }, { status: 404 });
  const suppliedLaunch = new URL(request.url).searchParams.get("launch");
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (
    process.env.CHAIN_REFRESH_DISABLED === "1" &&
    (refresh ||
      !suppliedLaunch ||
      !capturedPoolSnapshot(poolId, suppliedLaunch)?.markets[0]?.accounting)
  )
    return Response.json({ error: "refresh_disabled" }, { status: 503 });
  // The product proxy's admission line and visitor: this route reads the
  // same pool from the read API (product-admission.ts).
  const visitor = visitorAddress(request.headers);
  if (readsUpstream()) {
    const admitted = admission.admit(visitor);
    if (!admitted.ok)
      return productUnavailableResponse(
        new ProductUnavailableError(
          String(admitted.retryAfterSeconds),
          "request_limit",
        ),
      );
  }
  try {
    const launch = new URL(request.url).searchParams.get("launch");
    const current = launch ? null : await currentChainSnapshot();
    const market = current?.markets.find((p) => p.id === poolId);
    const launchTx =
      launch && /^0x[0-9a-f]{64}$/i.test(launch) ? launch : market?.launchTx;
    if (!launchTx)
      return Response.json(
        { error: "outside_current_coverage" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    const result = await auditedPoolSnapshot(
      poolId,
      launchTx as `0x${string}`,
      refresh,
      visitor,
    );
    const { accounting, ...auditedMarket } = result.markets[0];
    return Response.json(
      {
        poolId,
        toBlock: result.toBlock,
        toTimestamp: result.toTimestamp,
        generatedAt: result.generatedAt,
        market: auditedMarket,
        ...accounting,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ProductUnavailableError)
      return productUnavailableResponse(error);
    return Response.json(
      { error: "audit_unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "300" },
      },
    );
  }
}
