import type { Client } from "./index";

/** One token's `totalSupply()` in raw units and the block it was read at. */
export interface TokenSupplyRow {
  token: string;
  supplyRaw: string;
  block: number;
}
export interface UnreadTokenSupply {
  poolRef: number;
  token: string;
}

const address = (v: string) => /^0x[\da-f]{40}$/.test(v);
const uint256 = (v: string) => /^\d{1,78}$/.test(v) && BigInt(v) < 1n << 256n;

/** Catalog pools whose token supply is unread, after `afterPoolRef` in
 * `pool_ref` order, so a run pages forward and never revisits a token it could
 * not read. */
export async function unreadTokenSupplies(
  db: Client,
  afterPoolRef: number,
  limit: number,
): Promise<UnreadTokenSupply[]> {
  if (
    !Number.isSafeInteger(afterPoolRef) ||
    afterPoolRef < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 10000
  )
    throw Error("Invalid token supply page");
  const rows = (
    await db.query(
      "SELECT pool_ref,token FROM indexed_pools WHERE chain_id=4663 AND pool_ref>$1 AND token_total_supply_raw IS NULL ORDER BY pool_ref LIMIT $2",
      [afterPoolRef, limit],
    )
  ).rows;
  return rows.map((r) => ({ poolRef: Number(r.pool_ref), token: r.token }));
}

/** Stores each supply on every catalog pool of its token. A reading never
 * replaces one taken at a later block. Returns the pools updated. */
export async function saveTokenSupplies(
  db: Client,
  rows: readonly TokenSupplyRow[],
): Promise<number> {
  if (rows.length > 10000) throw Error("Invalid token supply rows");
  for (const r of rows)
    if (
      !address(r.token) ||
      !uint256(r.supplyRaw) ||
      !Number.isSafeInteger(r.block) ||
      r.block < 0
    )
      throw Error("Invalid token supply rows");
  if (!rows.length) return 0;
  const result = await db.query(
    `UPDATE indexed_pools p
        SET token_total_supply_raw=x.supply, token_supply_block=x.block
       FROM jsonb_to_recordset($1::jsonb) AS x(token text, supply numeric, block bigint)
      WHERE p.chain_id=4663 AND p.token=x.token
        AND (p.token_supply_block IS NULL OR p.token_supply_block<=x.block)`,
    [
      JSON.stringify(
        rows.map((r) => ({
          token: r.token,
          supply: r.supplyRaw,
          block: r.block,
        })),
      ),
    ],
  );
  return result.rowCount ?? 0;
}

export async function tokenSupplyCoverage(db: Client) {
  const row = (
    await db.query(
      `SELECT count(*)::int AS pools,
              count(token_total_supply_raw)::int AS read,
              min(token_supply_block)::text AS "firstBlock",
              max(token_supply_block)::text AS "lastBlock"
         FROM indexed_pools WHERE chain_id=4663`,
    )
  ).rows[0];
  return {
    pools: row.pools as number,
    read: row.read as number,
    unread: (row.pools - row.read) as number,
    firstBlock: row.firstBlock === null ? null : Number(row.firstBlock),
    lastBlock: row.lastBlock === null ? null : Number(row.lastBlock),
  };
}
