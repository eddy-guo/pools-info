import {
  createLocalSearchProvider,
  type ChainSnapshot,
  type ChainCatalog,
  type PoolAudit,
  type SearchProvider,
} from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
// Static/local lookup stays instant; only a complete ENS name triggers a remote
// read. Replace this adapter with a paginated public index as coverage grows.
export function createSearchProvider(
  snapshot: ChainSnapshot,
  audits: Record<string, PoolAudit>,
): SearchProvider {
  const local = createLocalSearchProvider(
    snapshot,
    audits,
    catalog as ChainCatalog,
  );
  return {
    async search(query, options) {
      const result = await local.search(query, options);
      if (result.kind !== "ens") return result;
      const name = query.trim().replace(/^(token|wallet|creator|tx):\s*/i, "");
      const response = await fetch(
        `/api/ens/?name=${encodeURIComponent(name)}`,
        { signal: options.signal },
      );
      const data: { name?: string; address?: string | null; error?: string } =
        await response.json();
      if (!response.ok)
        return {
          ...result,
          message:
            data.error ?? "ENS lookup is unavailable. Try the wallet address.",
        };
      if (!data.address)
        return {
          ...result,
          message:
            "No Ethereum address record was returned for this name. Try the wallet’s 0x address.",
        };
      if (!/^0x[0-9a-f]{40}$/i.test(data.address) || !data.name)
        throw Error("Invalid ENS response");
      const prefix =
        /^(token|wallet|creator|tx):/i.exec(query.trim())?.[0] ?? "";
      const resolved = await local.search(`${prefix}${data.address}`, options);
      // By default, show a wallet for the standard ENS Ethereum address. This
      // does not claim the name has a Robinhood-specific record or trade history.
      const entries = resolved.entries
        .filter((e) => options.group || prefix || e.group === "Wallets")
        .map((e) => ({
          ...e,
          title: e.group === "Wallets" ? data.name! : e.title,
          context: `Ethereum ENS address · ${e.context}`,
        }));
      return { ...resolved, entries, total: entries.length, kind: "ens" };
    },
  };
}
