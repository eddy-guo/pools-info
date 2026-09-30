import { targetedMarketSnapshot } from "../../../../lib/chain-server";
import { admission, visitorAddress } from "../../../../lib/product-admission";
import {
  ProductUnavailableError,
  productUnavailableResponse,
  readsUpstream,
} from "../../../../lib/product-server";
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
    return Response.json(
      await targetedMarketSnapshot(
        poolId.toLowerCase(),
        launch as `0x${string}`,
        new URL(request.url).searchParams.get("refresh") === "1",
        visitor,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ProductUnavailableError)
      return productUnavailableResponse(error);
    return Response.json(
      { error: "market_unavailable_or_outside_bounded_coverage" },
      { status: 503 },
    );
  }
}
