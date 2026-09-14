import { currentChainSnapshot } from "@/lib/chain-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET() {
  if (process.env.CHAIN_REFRESH_DISABLED === "1") {
    return Response.json(
      { error: "refresh_disabled" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const snapshot = await currentChainSnapshot();
    return Response.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    // Keep internal RPC errors, including provider URL details, out of responses.
    return Response.json(
      { error: "source_unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
}
