import { unstable_cache } from "next/cache";
import { collectRecentSwaps, type RecentSwaps } from "@pools/chain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;
const pending = new Map<string, Promise<RecentSwaps>>();
const recent = unstable_cache(
  async (ids: string) => {
    let job = pending.get(ids);
    if (!job) {
      job = collectRecentSwaps(ids.split(",")).finally(() =>
        pending.delete(ids),
      );
      pending.set(ids, job);
    }
    return job;
  },
  ["recent-swaps-v1"],
  { revalidate: 10 },
);
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
  if (process.env.CHAIN_REFRESH_DISABLED === "1")
    return Response.json({ error: "offline" }, { status: 503 });
  try {
    return Response.json(await recent(ids.join(",")), {
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
