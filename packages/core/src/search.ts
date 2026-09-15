import type { ChainCatalog } from "./catalog";
import type { ChainSnapshot, PoolAudit } from "./chain-types";
import { poolHref, walletHref } from "./live-analytics";
import { shortAddress } from "./format";

export const searchGroups = [
  "Tokens",
  "Wallets",
  "Creators",
  "Transactions",
] as const;
export type SearchGroup = (typeof searchGroups)[number];
export interface SearchEntry {
  id: string;
  group: SearchGroup;
  title: string;
  context: string;
  address: string;
  terms: string[];
  href: string;
  external?: boolean;
}
export interface SearchResponse {
  message?: string;
  entries: SearchEntry[];
  total: number;
  kind: "text" | "address" | "hash" | "ens";
  coverage: {
    scope: "sample" | "indexed";
    pools: number;
    fromBlock: number;
    toBlock: number;
  };
}
// A remote index can implement this contract without changing the search UI.
export interface SearchProvider {
  search(
    query: string,
    options: { group?: SearchGroup; signal: AbortSignal },
  ): Promise<SearchResponse>;
}

/** Query strings select a view, not a different wallet, creator or pool. Keep
 * groups separate and distinguish multiple pools trading the same token. */
export function searchEntryIdentity(entry: SearchEntry): string {
  const address = entry.address.toLowerCase();
  if (
    ((entry.group === "Wallets" || entry.group === "Creators") &&
      /^0x[0-9a-f]{40}$/.test(address)) ||
    (entry.group === "Transactions" && /^0x[0-9a-f]{64}$/.test(address))
  )
    return `${entry.group}:${address}`;
  if (entry.group === "Tokens") {
    const pool = /^\/pool\/(0x[0-9a-f]{64})(?:\/|\?|#|$)/i.exec(entry.href);
    if (pool) return `Tokens:pool:${pool[1].toLowerCase()}`;
  }
  return `${entry.group}:${entry.href}`;
}

const explorer = "https://robinhoodchain.blockscout.com";
const normalize = (s: string) =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

// Bounded edit distance with adjacent transpositions. Only used for names,
// never addresses or hashes: a typo must not silently select another address.
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}
function score(entry: SearchEntry, q: string) {
  if (!q) return 1;
  const address = entry.address.toLowerCase();
  if (q.startsWith("0x"))
    return address === q ? 1000 : address.startsWith(q) ? 900 : 0;
  const terms = entry.terms.map(normalize);
  if (terms.includes(q)) return 800;
  if (terms.some((t) => t.startsWith(q))) return 700;
  if (terms.some((t) => t.includes(q))) return 600;
  const words = terms
    .flatMap((t) => t.split(/[^\p{L}\p{N}]+/u))
    .filter((w) => w && w.length <= 64 && !w.startsWith("0x"));
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.every((t) =>
    words.some(
      (w) =>
        w.includes(t) ||
        (t.length >= 3 &&
          t.length <= 64 &&
          Math.abs(t.length - w.length) <= 2 &&
          distance(t, w) <= (t.length >= 6 ? 2 : 1)),
    ),
  )
    ? 300
    : 0;
}
export function createLocalSearchProvider(
  snapshot: ChainSnapshot,
  audits: Record<string, PoolAudit>,
  catalog?: ChainCatalog,
): SearchProvider {
  const markets = new Map(snapshot.markets.map((m) => [m.id, m]));
  for (const a of Object.values(audits))
    if (!markets.has(a.poolId)) markets.set(a.poolId, a.market);
  const entries = new Map<string, SearchEntry>();
  function add(e: SearchEntry) {
    if (!entries.has(e.id)) entries.set(e.id, e);
  }
  for (const m of markets.values()) {
    add({
      id: `token:${m.id}`,
      group: "Tokens",
      title: `${m.name} (${m.symbol})`,
      address: m.token,
      context: "Robinhood · observed pool",
      terms: [m.name, m.symbol, m.token, m.id],
      href: poolHref(m),
    });
    // Pool IDs are 32 bytes, just like transaction hashes. Exact known pool IDs
    // must remain navigable without pretending we resolved a transaction.
    add({
      id: `pool:${m.id}`,
      group: "Tokens",
      title: `${m.name} (${m.symbol})`,
      address: m.id,
      context: "Pool ID · Robinhood",
      terms: [m.id],
      href: poolHref(m),
    });
    const a = m.launchSender.toLowerCase();
    add({
      id: `creator:${a}`,
      group: "Creators",
      title: shortAddress(a),
      address: a,
      context: "Launch sender · identity not verified",
      terms: [a],
      href: `/creators/${a}/`,
    });
  }
  for (const m of catalog?.pools ?? []) {
    add({
      id: `token:${m.id}`,
      group: "Tokens",
      title: `${m.name} (${m.symbol})`,
      address: m.token,
      context: "Verified launch catalog · details load on demand",
      terms: [m.name, m.symbol, m.token],
      href: poolHref(m),
    });
    add({
      id: `pool:${m.id}`,
      group: "Tokens",
      title: `${m.name} (${m.symbol})`,
      address: m.id,
      context: "Pool ID · verified launch catalog",
      terms: [m.id],
      href: poolHref(m),
    });
    const address = m.launchSender.toLowerCase();
    add({
      id: `creator:${address}`,
      group: "Creators",
      title: shortAddress(address),
      address,
      context: "Launch sender · verified launch catalog",
      terms: [address],
      href: `/creators/${address}/`,
    });
    entries.get(`creator:${address}`)!.terms.push(m.name, m.symbol);
    add({
      id: `tx:${m.launchTx.toLowerCase()}`,
      group: "Transactions",
      title: `Launch · ${m.symbol}`,
      address: m.launchTx,
      context: "Verified launch transaction · explorer ↗",
      terms: [m.launchTx],
      href: `${explorer}/tx/${m.launchTx}`,
      external: true,
    });
  }
  for (const a of Object.values(audits).sort((a, b) => b.toBlock - a.toBlock)) {
    for (const w of a.wallets) {
      const address = w.address.toLowerCase();
      add({
        id: `wallet:${address}`,
        group: "Wallets",
        title: shortAddress(address),
        address,
        context: `Audited in ${a.market.symbol} · block ${a.toBlock}`,
        terms: [address],
        href: walletHref(address, a.market),
      });
    }
    for (const e of a.executions) {
      const t = e.trade;
      add({
        id: `tx:${t.txHash.toLowerCase()}`,
        group: "Transactions",
        title: `${t.side} · ${a.market.symbol}`,
        address: t.txHash,
        context: "Audited transaction · explorer ↗",
        terms: [t.txHash],
        href: `${explorer}/tx/${t.txHash}`,
        external: true,
      });
    }
  }
  for (const t of snapshot.trades)
    add({
      id: `tx:${t.txHash.toLowerCase()}`,
      group: "Transactions",
      title: `${t.side} · ${markets.get(t.poolId)?.symbol ?? "pool"}`,
      address: t.txHash,
      context: "Observed transaction · explorer ↗",
      terms: [t.txHash],
      href: `${explorer}/tx/${t.txHash}`,
      external: true,
    });
  return {
    async search(query, { group, signal }) {
      signal.throwIfAborted();
      const prefix = /^(token|wallet|creator|tx):\s*/i.exec(query.trim());
      const groups: Record<string, SearchGroup> = {
        token: "Tokens",
        wallet: "Wallets",
        creator: "Creators",
        tx: "Transactions",
      };
      const selectedGroup = prefix ? groups[prefix[1].toLowerCase()] : group;
      const q = normalize(
        query.trim().replace(/^(token|wallet|creator|tx):\s*/i, ""),
      ).slice(0, 256);
      const kind = /^0x[0-9a-f]{40}$/.test(q)
        ? "address"
        : /^0x[0-9a-f]{64}$/.test(q)
          ? "hash"
          : /^(?:[^\s.]+\.)+eth$/u.test(q)
            ? "ens"
            : "text";
      const scored = [...entries.values()]
        .map((entry) => ({ entry, score: score(entry, q) }))
        .filter(
          ({ entry, score }) =>
            score &&
            (!selectedGroup || entry.group === selectedGroup) &&
            (!entry.id.startsWith("pool:") || q.startsWith("0x")),
        )
        .sort(
          (a, b) =>
            b.score - a.score ||
            searchGroups.indexOf(a.entry.group) -
              searchGroups.indexOf(b.entry.group) ||
            a.entry.id.localeCompare(b.entry.id),
        );
      const result = scored.map((s) => s.entry);
      if (kind === "address") {
        if (
          !result.some((e) => e.group === "Wallets") &&
          (!selectedGroup || selectedGroup === "Wallets")
        )
          result.push({
            id: `lookup:${q}`,
            group: "Wallets",
            title: "Look up this address",
            address: q,
            context: "Public wallet profile · coverage checked on page",
            terms: [],
            href: walletHref(q),
          });
        if (
          !result.some((e) => e.group === "Tokens") &&
          (!selectedGroup || selectedGroup === "Tokens")
        )
          result.push({
            id: `contract:${q}`,
            group: "Tokens",
            title: "Inspect address on explorer",
            address: q,
            context:
              "Token or contract? Outside current coverage · not verified ↗",
            terms: [],
            href: `${explorer}/address/${q}`,
            external: true,
          });
        if (
          !result.some((e) => e.group === "Creators") &&
          selectedGroup === "Creators"
        )
          result.push({
            id: `creator-lookup:${q}`,
            group: "Creators",
            title: "Look up launch sender",
            address: q,
            context: "Check available launches · creator status not verified",
            terms: [],
            href: `/creators/${q}/`,
          });
      }
      if (
        kind === "hash" &&
        (!selectedGroup || selectedGroup === "Transactions") &&
        !result.some((e) => e.group === "Transactions")
      )
        result.push({
          id: `tx-lookup:${q}`,
          group: "Transactions",
          title: "Look up transaction",
          address: q,
          context: "Outside current coverage · inspect on explorer ↗",
          terms: [],
          href: `${explorer}/tx/${q}`,
          external: true,
        });
      const seen = new Set<string>();
      const unique = result.filter((e) => {
        const key = searchEntryIdentity(e);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const counts = new Map<SearchGroup, number>();
      const limited = unique.filter((e) => {
        const n = counts.get(e.group) ?? 0;
        counts.set(e.group, n + 1);
        return n < 8;
      });
      return {
        entries: limited,
        total: unique.length,
        kind,
        coverage: {
          scope: "sample",
          pools: new Set([
            ...markets.keys(),
            ...(catalog?.pools.map((m) => m.id) ?? []),
          ]).size,
          fromBlock: Math.min(
            snapshot.fromBlock,
            ...(catalog?.ranges.map((r) => r.fromBlock) ?? []),
            ...Object.values(audits).map((a) => a.market.launchBlock),
          ),
          toBlock: Math.max(
            snapshot.toBlock,
            catalog?.toBlock ?? snapshot.toBlock,
            ...Object.values(audits).map((a) => a.toBlock),
          ),
        },
      };
    },
  };
}
