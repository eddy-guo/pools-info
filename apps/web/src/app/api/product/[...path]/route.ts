import { productRequest } from "@/lib/product-request";
import {
  readProduct,
  readWalletHistory,
  WalletHistoryUnavailableError,
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
  // Explorer history is on-demand and unsaved: its outage contract, including
  // Retry-After, reaches the browser instead of becoming a coverage fallback.
  if (path.length === 3 && path[2] === "history")
    try {
      return Response.json(await readWalletHistory(path, query), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const failure =
        error instanceof WalletHistoryUnavailableError
          ? error
          : new WalletHistoryUnavailableError("upstream_unavailable", 30);
      return Response.json(
        { error: "wallet_history_unavailable", reason: failure.reason },
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
  } catch {
    return Response.json(
      { error: "This item is outside available saved coverage." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
