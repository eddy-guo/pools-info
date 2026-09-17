import {
  createLocalSearchProvider,
  searchEntryIdentity,
  walletHref,
  type ChainSnapshot,
  type ChainCatalog,
  type PoolAudit,
  type SearchProvider,
  type SearchResponse,
} from "@pools/core";
import catalog from "../../../../data/catalog/chain.json";
type SearchResult = SearchResponse & {
  indexNotice?: string;
  resolvedEns?: { name: string; address: string };
};
type ExtendedSearchProvider = SearchProvider & {
  extend(
    query: string,
    options: Parameters<SearchProvider["search"]>[1],
    base: SearchResult,
  ): Promise<SearchResult>;
};
// Local lookup appears first. Saved catalog search extends it asynchronously;
// complete ENS names use the separate Ethereum resolver.
export function createSearchProvider(
  snapshot: ChainSnapshot,
  audits: Record<string, PoolAudit>,
): ExtendedSearchProvider {
  const local = createLocalSearchProvider(
    snapshot,
    audits,
    catalog as ChainCatalog,
  );
  const provider: ExtendedSearchProvider = {
    async extend(query, options, base) {
      if (base.kind === "ens") {
        if (!base.resolvedEns) return base;
        const prefix = /^(token|wallet|creator|tx):/i.exec(query.trim())?.[0];
        query = `${prefix || (options.group ? "" : "wallet:")}${base.resolvedEns.address}`;
      }
      const prefixes = {
        Tokens: "token",
        Wallets: "wallet",
        Creators: "creator",
        Transactions: "tx",
      };
      const q =
        options.group && !/^(token|wallet|creator|tx):/i.test(query.trim())
          ? `${prefixes[options.group]}:${query}`
          : query;
      if (q.length > 100) return base;
      try {
        const response = await fetch(
          `/api/product/search/?q=${encodeURIComponent(q)}`,
          {
            signal: AbortSignal.any([
              options.signal,
              AbortSignal.timeout(12000),
            ]),
            cache: "no-store",
          },
        );
        if (!response.ok) throw Error("Saved search unavailable");
        const remote = (await response.json()) as SearchResponse;
        if (
          !Array.isArray(remote.entries) ||
          remote.entries.length > 32 ||
          !remote.coverage ||
          remote.entries.some(
            (e) =>
              !e ||
              typeof e.href !== "string" ||
              typeof e.address !== "string" ||
              typeof e.title !== "string" ||
              typeof e.context !== "string" ||
              !["Tokens", "Wallets", "Creators", "Transactions"].includes(
                e.group,
              ) ||
              (!/^\/(pool|wallet|creators)\//.test(e.href) &&
                !e.href.startsWith("https://robinhoodchain.blockscout.com/")),
          )
        )
          throw Error("Invalid saved search");
        const verified = new Set(
          remote.entries
            .filter((e) => e.group === "Tokens" && !e.external)
            .map((e) => e.address.toLowerCase()),
        );
        const merged = new Map<string, (typeof remote.entries)[number]>();
        for (const e of [...remote.entries, ...base.entries]) {
          if (
            e.group === "Tokens" &&
            e.external &&
            verified.has(e.address.toLowerCase())
          )
            continue;
          const key = searchEntryIdentity(e);
          if (!merged.has(key)) merged.set(key, e);
        }
        const counts = new Map<string, number>();
        const entries = [...merged.values()].filter((e) => {
          const n = counts.get(e.group) ?? 0;
          counts.set(e.group, n + 1);
          return n < 8;
        });
        return {
          ...base,
          entries: base.resolvedEns
            ? entries.map((e) => ({
                ...e,
                title: e.group === "Wallets" ? base.resolvedEns!.name : e.title,
                href: e.group === "Wallets" ? walletHref(e.address) : e.href,
              }))
            : entries,
          total: entries.length,
          coverage: remote.coverage,
        };
      } catch {
        return {
          ...base,
          indexNotice: "Some results are unavailable. Try again shortly.",
        };
      }
    },
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
          href: e.group === "Wallets" ? walletHref(e.address) : e.href,
        }));
      return {
        ...resolved,
        entries,
        total: entries.length,
        kind: "ens",
        resolvedEns: { name: data.name, address: data.address },
      };
    },
  };
  return provider;
}
