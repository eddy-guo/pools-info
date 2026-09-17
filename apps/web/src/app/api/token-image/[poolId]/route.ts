import { tokenImageResponse } from "@/lib/token-image-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

type Context = { params: Promise<{ poolId: string }> };

export async function GET(request: Request, { params }: Context) {
  return tokenImageResponse(request, (await params).poolId);
}

/** A validator check costs the store one primary-key read and no bytes. */
export async function HEAD(request: Request, context: Context) {
  return GET(request, context);
}
