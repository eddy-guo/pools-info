import { productRequest } from "@/lib/product-request";
import { readProduct } from "@/lib/product-server";
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
  try {
    return Response.json(await readProduct(path, query), {
      headers: { "Cache-Control": "private, max-age=15" },
    });
  } catch {
    return Response.json(
      { error: "This item is outside available saved coverage." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
