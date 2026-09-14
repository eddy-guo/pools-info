import { unstable_cache } from "next/cache";
import { normalizeEnsName, resolveEnsName } from "@pools/chain";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;
const resolve = unstable_cache(resolveEnsName, ["ethereum-ens-v1"], {
  revalidate: 300,
});
export async function GET(request: Request) {
  let name: string;
  try {
    name = normalizeEnsName(
      new URL(request.url).searchParams.get("name") ?? "",
    );
  } catch {
    return Response.json({ error: "Invalid .eth name" }, { status: 400 });
  }
  if (process.env.CHAIN_REFRESH_DISABLED === "1")
    return Response.json(
      { error: "Name resolution unavailable in offline mode" },
      { status: 503 },
    );
  try {
    const address = await resolve(name);
    return Response.json(
      { name, address, record: "Ethereum address (coin type 60)", chainId: 1 },
      { headers: { "Cache-Control": "private, max-age=60" } },
    );
  } catch {
    return Response.json(
      {
        error:
          "ENS lookup unavailable. The provider may be busy or this name may need an unsupported offchain resolver. Try the wallet address.",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
