import { validateLiveFeed } from "@/lib/live-feed";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 12;
export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const poolId = query.get("poolId")?.toLowerCase();
  if (
    [...query.keys()].some((key) => key !== "poolId") ||
    query.getAll("poolId").length > 1 ||
    (poolId !== undefined && !/^0x[0-9a-f]{64}$/.test(poolId))
  )
    return Response.json({ error: "Invalid pool filter" }, { status: 400 });
  const base = process.env.INDEXER_API_URL;
  if (!base || process.env.CHAIN_REFRESH_DISABLED === "1")
    return Response.json(
      { error: "Recent trades are not connected yet." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  try {
    const origin = new URL(base);
    if (
      !["https:", "http:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    )
      throw Error("Invalid origin");
    const url = new URL("/v1/live-trades", origin);
    if (poolId) url.searchParams.set("poolId", poolId);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw Error("Unavailable");
    return Response.json(validateLiveFeed(await response.json(), poolId), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      { error: "Recent trades are temporarily unavailable." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "15" },
      },
    );
  }
}
