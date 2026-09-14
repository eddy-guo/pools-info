import { indexedFeed } from "@/lib/indexed-feed";
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
  try {
    // Once configured, serve the stored index only. An outage must not silently
    // multiply RPC scans across visitors or mix unrelated coverage windows.
    const data = await indexedFeed(process.env.INDEXER_API_URL!, ids);
    return Response.json(data, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Recent swaps unavailable. Retain the last observed events." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "15" },
      },
    );
  }
}
