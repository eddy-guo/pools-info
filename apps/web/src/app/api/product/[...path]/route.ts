import { productRequest } from "@/lib/product-request";
import {
  EthPriceUnavailableError,
  ProductUnavailableError,
  productUnavailableResponse,
  readEthPrice,
  readProduct,
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
  // Display-only market context with no saved counterpart: an outage stays an
  // outage instead of falling back to the preloaded dataset or a stale rate.
  if (path.length === 2 && path[0] === "prices" && path[1] === "eth-usd")
    try {
      return Response.json(await readEthPrice(path, query), {
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
  try {
    return Response.json(await readProduct(path, query), {
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
