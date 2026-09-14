import { currentChainSnapshot } from "@/lib/chain-server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await currentChainSnapshot(), {
    headers: { "Cache-Control": "private, max-age=60" },
  });
}
