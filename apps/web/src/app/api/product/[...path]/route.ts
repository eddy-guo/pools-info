import { admission, visitorAddress } from "@/lib/product-admission";
import { productRequest } from "@/lib/product-request";
import {
  EthPriceUnavailableError,
  ProductUnavailableError,
  productUnavailableResponse,
  readEthPrice,
  readProduct,
  readScreenerStats,
  readsUpstream,
  readWalletTradeHistory,
} from "@/lib/product-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 12;
export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const query = new URL(request.url).searchParams;
  try {
    productRequest(path, query);
  } catch {
    return Response.json(
      { error: "Invalid saved-data request" },
      { status: 400 },
    );
  }
  // The proxy's own admission line, in front of every upstream read: a
  // visitor past it is answered here, with the wait that clears it, and
  // spends nothing of the read API's allowance (product-admission.ts).
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
  if (path.length === 1 && path[0] === "stats") {
    const result = await readScreenerStats(
      (query.get("window") ?? "24h") as
        "1h" | "6h" | "24h" | "7d" | "30d" | "All",
      visitor,
    );
    if (result.status === 200)
      return Response.json(result.data, {
        headers: { "Cache-Control": "no-store" },
      });
    return Response.json(
      {
        error:
          result.status === 404 ? "not_found" : "stats_coverage_unavailable",
      },
      {
        status: result.status,
        headers: {
          "Cache-Control": "no-store",
          ...(result.retryAfter ? { "Retry-After": result.retryAfter } : {}),
        },
      },
    );
  }
  // Display-only market context with no saved counterpart: an outage stays an
  // outage instead of falling back to the preloaded dataset or a stale rate.
  if (path.length === 2 && path[0] === "prices" && path[1] === "eth-usd")
    try {
      return Response.json(await readEthPrice(path, query, visitor), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const failure =
        error instanceof EthPriceUnavailableError
          ? error
          : new EthPriceUnavailableError(30);
      return Response.json(
        { error: "price_unavailable" },
        {
          status: 503,
          headers: {
            "Retry-After": String(failure.retryAfter),
            "Cache-Control": "no-store",
          },
        },
      );
    }
  // The explorer-backed trade history: on demand only, like the price above,
  // never served from the preloaded dataset (see readWalletTradeHistory).
  if (path.length === 3 && path[0] === "wallets" && path[2] === "history")
    try {
      return Response.json(await readWalletTradeHistory(path, query, visitor), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof ProductUnavailableError)
        return productUnavailableResponse(error);
      return Response.json(
        { error: "This item is outside available saved coverage." },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
  try {
    return Response.json(await readProduct(path, query, visitor), {
      headers: {
        "Cache-Control": ["following", "trades"].includes(path[0])
          ? "no-store"
          : "private, max-age=15",
      },
    });
  } catch (error) {
    /* An outage is a 503 and stays one: the page shows its unavailable state
       rather than being handed a stored answer it would paint as current. A
       404 still means the read was answered and this item is not covered. */
    if (error instanceof ProductUnavailableError)
      return productUnavailableResponse(error);
    return Response.json(
      { error: "This item is outside available saved coverage." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
