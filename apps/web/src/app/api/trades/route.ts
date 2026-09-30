import {
  IndexedFeedUnavailableError,
  indexedFeed,
} from "../../../lib/indexed-feed";
import {
  admission,
  upstreamIdentity,
  visitorAddress,
} from "../../../lib/product-admission";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("pools") ?? "";
  if (raw.length > 540)
    return Response.json({ error: "Too many pools" }, { status: 400 });
  const ids = [...new Set(raw.toLowerCase().split(","))].sort();
  if (
    !ids.length ||
    ids.length > 8 ||
    ids.some((p) => !/^0x[0-9a-f]{64}$/.test(p))
  )
    return Response.json({ error: "Invalid pools" }, { status: 400 });
  if (
    process.env.CHAIN_REFRESH_DISABLED === "1" ||
    !process.env.INDEXER_API_URL
  )
    return Response.json({ error: "offline" }, { status: 503 });
  // The same admission line and visitor identity as the product proxy: this
  // route forwards to the read API's feed and spends its allowance the same way.
  const visitor = visitorAddress(request.headers);
  const admitted = admission.admit(visitor);
  if (!admitted.ok)
    return Response.json(
      { error: "Recent swaps unavailable. Retain the last observed events." },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(admitted.retryAfterSeconds),
        },
      },
    );
  try {
    // Once configured, serve the stored index only. An outage must not silently
    // multiply RPC scans across visitors or mix unrelated coverage windows.
    const data = await indexedFeed(
      process.env.INDEXER_API_URL!,
      ids,
      upstreamIdentity(visitor),
    );
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return Response.json(
      { error: "Recent swaps unavailable. Retain the last observed events." },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After":
            error instanceof IndexedFeedUnavailableError
              ? (error.retryAfter ?? "15")
              : "15",
        },
      },
    );
  }
}
