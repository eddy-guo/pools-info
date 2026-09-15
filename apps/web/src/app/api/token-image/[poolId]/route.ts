import { tokenImageResponse } from "@/lib/token-image-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ poolId: string }> },
) {
  return tokenImageResponse(request, (await params).poolId);
}
