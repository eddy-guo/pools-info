import { currentChainSnapshot } from "@/lib/chain-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    return Response.json(await currentChainSnapshot(), {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch {
    return Response.json(
      { error: "data_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
