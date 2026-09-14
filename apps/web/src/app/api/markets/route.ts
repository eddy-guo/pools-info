import { currentChainSnapshot } from "@/lib/chain-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 110;
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
  } catch (error) {
    const reason =
      error instanceof Error &&
      error.message.startsWith("Collection budget exceeded")
        ? "scan_budget"
        : error instanceof Error && /timeout/i.test(error.name)
          ? "upstream_timeout"
          : error instanceof Error &&
              /^RPC HTTP (429|5\d\d)$/.test(error.message)
            ? "upstream_rate_or_availability"
            : "source_or_verification";
    // Keep internal RPC errors, including provider URL details, out of responses.
    return Response.json(
      { error: "source_unavailable", reason },
      {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      },
    );
  }
}
