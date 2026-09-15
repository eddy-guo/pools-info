import {
  type SearchEntry,
  type SearchGroup,
  type SearchResponse,
} from "@pools/core";
import {
  assertCatalogIdentity,
  catalogCte,
  type ReadQuery,
} from "./catalog-read";
import { catalogSummary } from "./explore-read";
import { accountingCoverage } from "./accounting-read";
import { searchPattern } from "./request";
const explorer = "https://robinhoodchain.blockscout.com";
export async function readSearch(
  query: ReadQuery,
  input: string,
  group?: SearchGroup,
): Promise<SearchResponse> {
  await assertCatalogIdentity(query);
  const prefix = /^(token|wallet|creator|tx):\s*/i.exec(input.trim());
  const groups: Record<string, SearchGroup> = {
    token: "Tokens",
    wallet: "Wallets",
    creator: "Creators",
    tx: "Transactions",
  };
  const selected = prefix ? groups[prefix[1].toLowerCase()] : group;
  const q = input
    .trim()
    .replace(/^(token|wallet|creator|tx):\s*/i, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const kind = /^0x[0-9a-f]{40}$/.test(q)
    ? "address"
    : /^0x[0-9a-f]{64}$/.test(q)
      ? "hash"
      : /^(?:[^\s.]+\.)+eth$/u.test(q)
        ? "ens"
        : "text";
  const summary = await catalogSummary(query);
  await accountingCoverage(query);
  const through = Number(
    (
      await query(
        "SELECT coalesce(max(through_block),0)::text AS height FROM analytics_accounting_pools WHERE chain_id=4663",
      )
    ).rows[0].height,
  );
  const capability = await query(
    "SELECT to_regprocedure('public.similarity(text,text)') IS NOT NULL AS fuzzy",
  );
  const fuzzy =
    capability.rows[0].fuzzy === true && q.length >= 3 && !q.startsWith("0x");
  const textScore = `CASE WHEN $1='' THEN 1 WHEN $1 LIKE '0x%' THEN 0
    WHEN lower(p.name)=$1 OR lower(p.symbol)=$1 THEN 800
    WHEN lower(p.name) LIKE $3 ESCAPE '\\' OR lower(p.symbol) LIKE $3 ESCAPE '\\' THEN 700
    WHEN lower(p.name) LIKE $2 ESCAPE '\\' OR lower(p.symbol) LIKE $2 ESCAPE '\\' THEN 600
    ${fuzzy ? "WHEN lower(p.name) OPERATOR(public.%) $1 OR lower(p.symbol) OPERATOR(public.%) $1 THEN 300 + floor(100*greatest(public.similarity(lower(p.name),$1),public.similarity(lower(p.symbol),$1)))" : ""} ELSE 0 END`;
  const addressScore = (column: string) =>
    `CASE WHEN $1='' THEN 1 WHEN ${column}=$1 THEN 1000 WHEN $1 LIKE '0x%' AND ${column} LIKE $3 ESCAPE '\\' THEN 900 ELSE 0 END`;
  const candidateWhere =
    selected === "Wallets"
      ? "false"
      : `$1='' OR
    ($1 NOT LIKE '0x%' AND (lower(p.name) LIKE $2 ESCAPE '\\' OR lower(p.symbol) LIKE $2 ESCAPE '\\'
      ${fuzzy ? "OR lower(p.name) OPERATOR(public.%) $1 OR lower(p.symbol) OPERATOR(public.%) $1" : ""})) OR
    ($1 LIKE '0x%' AND (p.token LIKE $3 ESCAPE '\\' OR p.pool_id LIKE $3 ESCAPE '\\' OR p.launch_sender LIKE $3 ESCAPE '\\' OR p.launch_tx LIKE $3 ESCAPE '\\'))`;
  const sql = `${catalogCte}, token_matches AS (
    SELECT p.*,greatest(${textScore},${addressScore("p.token")},${addressScore("p.pool_id")}) AS token_score,
      greatest(${textScore},${addressScore("p.launch_sender")}) AS creator_score,${addressScore("p.launch_tx")} AS tx_score FROM catalog p WHERE ${candidateWhere}
  ), entries AS (
    SELECT 'token:'||pool_id AS id,'Tokens'::text AS category,name||' ('||symbol||')' AS title,
      CASE WHEN pool_id=$1 THEN pool_id ELSE token END AS address,'Verified launch catalog · details load on demand'::text AS context,
      '/pool/'||pool_id||'/?launch='||launch_tx AS href,false AS external,token_score AS score
    FROM token_matches WHERE token_score>0
    UNION ALL SELECT 'creator:'||launch_sender,'Creators',left(launch_sender,6)||'…'||right(launch_sender,4),launch_sender,
      'Launch sender · verified launch catalog','/creators/'||launch_sender||'/',false,max(creator_score)
    FROM token_matches WHERE creator_score>0 GROUP BY launch_sender
    UNION ALL SELECT DISTINCT ON(launch_tx) 'tx:'||launch_tx,'Transactions','Launch · '||symbol,launch_tx,
      'Verified launch transaction · explorer ↗','${explorer}/tx/'||launch_tx,true,tx_score
    FROM token_matches WHERE tx_score>0
    UNION ALL SELECT DISTINCT ON(p.wallet) 'wallet:'||p.wallet,'Wallets',left(p.wallet,6)||'…'||right(p.wallet,4),p.wallet,
      'Published activity · coverage on profile','/wallet/'||p.wallet||'/?window=All',false,${addressScore("p.wallet")}
    FROM analytics_accounting_positions p WHERE p.chain_id=4663 AND ($1='' OR ($1 LIKE '0x%' AND p.wallet LIKE $3 ESCAPE '\\'))
    UNION ALL SELECT DISTINCT ON(t.transaction_hash) 'tx:'||t.transaction_hash,'Transactions',t.side||' · '||(p.market->>'symbol'),t.transaction_hash,
      'Published transaction · explorer ↗','${explorer}/tx/'||t.transaction_hash,true,${addressScore("t.transaction_hash")}
    FROM analytics_accounting_trades t JOIN analytics_accounting_pools p USING(chain_id,pool_id)
    WHERE t.chain_id=4663 AND ($1='' OR ($1 LIKE '0x%' AND t.transaction_hash LIKE $3 ESCAPE '\\'))
  ), unique_entries AS (
    SELECT DISTINCT ON(category,href) * FROM entries WHERE ($4::text IS NULL OR category=$4)
      ORDER BY category,href,score DESC,id
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY category ORDER BY score DESC,id) AS rank,count(*) OVER()::text AS total FROM unique_entries
  ) SELECT * FROM ranked WHERE rank<=8 ORDER BY score DESC,CASE category WHEN 'Tokens' THEN 0 WHEN 'Wallets' THEN 1 WHEN 'Creators' THEN 2 ELSE 3 END,id`;
  const rows = (
    await query(sql, [
      q,
      searchPattern(q),
      searchPattern(q).slice(1),
      selected ?? null,
    ])
  ).rows;
  const entries: SearchEntry[] = rows.map((r) => ({
    id: r.id,
    group: r.category,
    title: r.title,
    address: r.address,
    context: r.context,
    href: r.href,
    terms: [],
    ...(r.external ? { external: true } : {}),
  }));
  let total = Number(rows[0]?.total ?? 0);
  const append = (entry: SearchEntry) => {
    entries.push(entry);
    total++;
  };
  if (kind === "address") {
    if (
      (!selected || selected === "Wallets") &&
      !entries.some((e) => e.group === "Wallets")
    )
      append({
        id: `lookup:${q}`,
        group: "Wallets",
        title: "Look up this address",
        address: q,
        context: "Public wallet profile · coverage checked on page",
        terms: [],
        href: `/wallet/${q}/?window=All`,
      });
    if (
      (!selected || selected === "Tokens") &&
      !entries.some((e) => e.group === "Tokens")
    )
      append({
        id: `contract:${q}`,
        group: "Tokens",
        title: "Inspect address on explorer",
        address: q,
        context: "Outside current coverage · not verified ↗",
        terms: [],
        href: `${explorer}/address/${q}`,
        external: true,
      });
    if (selected === "Creators" && !entries.some((e) => e.group === "Creators"))
      append({
        id: `creator-lookup:${q}`,
        group: "Creators",
        title: "Look up launch sender",
        address: q,
        context: "Creator status not verified",
        terms: [],
        href: `/creators/${q}/`,
      });
  }
  if (
    kind === "hash" &&
    (!selected || selected === "Transactions") &&
    !entries.some((e) => e.group === "Transactions")
  )
    append({
      id: `tx-lookup:${q}`,
      group: "Transactions",
      title: "Look up transaction",
      address: q,
      context: "Inspect on explorer ↗",
      terms: [],
      href: `${explorer}/tx/${q}`,
      external: true,
    });
  return {
    entries,
    total,
    kind,
    coverage: {
      scope: "indexed",
      pools: summary.count,
      fromBlock: summary.firstBlock,
      toBlock: Math.max(summary.lastBlock, through),
    },
    message:
      "Search covers all stored verified launches and published activity; unknown addresses remain public lookups.",
  };
}
