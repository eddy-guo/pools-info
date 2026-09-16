import type { Client } from "./index";

export interface SenderCodeObservation {
  address: string;
  /** keccak256 of the code, or null when eth_getCode returned 0x. */
  codeHash: string | null;
  observedBlock: number;
}
const address = (v: string) => /^0x[\da-f]{40}$/.test(v),
  hash = (v: string) => /^0x[\da-f]{64}$/.test(v);
export async function loadSenderCode(
  db: Client,
  addresses: readonly string[],
): Promise<Map<string, SenderCodeObservation>> {
  const ids = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (ids.length > 10000 || ids.some((a) => !address(a)))
    throw Error("Invalid sender code selection");
  if (!ids.length) return new Map();
  const rows = (
    await db.query(
      "SELECT address,code_hash,observed_block::text FROM sender_code_observations WHERE chain_id=4663 AND address=ANY($1::text[])",
      [ids],
    )
  ).rows;
  return new Map(
    rows.map((r) => [
      String(r.address),
      {
        address: String(r.address),
        codeHash: r.code_hash === null ? null : String(r.code_hash),
        observedBlock: Number(r.observed_block),
      },
    ]),
  );
}
/** Record fresh observations. An older observation never overwrites a newer
 * one for the same address; equal heights keep the stored row. */
export async function saveSenderCode(
  db: Client,
  observations: readonly SenderCodeObservation[],
) {
  if (observations.length > 10000) throw Error("Invalid sender code batch");
  const rows = observations.map((o) => {
    if (
      !address(o.address) ||
      (o.codeHash !== null && !hash(o.codeHash)) ||
      !Number.isSafeInteger(o.observedBlock) ||
      o.observedBlock < 0
    )
      throw Error("Invalid sender code observation");
    return {
      address: o.address,
      code_hash: o.codeHash,
      observed_block: o.observedBlock,
    };
  });
  if (!rows.length) return;
  await db.query(
    `INSERT INTO sender_code_observations(chain_id,address,code_hash,observed_block)
    SELECT 4663,x.address,x.code_hash,x.observed_block
    FROM jsonb_to_recordset($1::jsonb) AS x(address text,code_hash text,observed_block bigint)
    ON CONFLICT (chain_id,address) DO UPDATE SET code_hash=excluded.code_hash,observed_block=excluded.observed_block,observed_at=now()
    WHERE excluded.observed_block>sender_code_observations.observed_block`,
    [JSON.stringify(rows)],
  );
}
/** Whether an observation may answer "does this address have code at block?".
 *
 * Code, once deployed, stays deployed (EIP-6780 leaves selfdestruct only to a
 * contract's own creation transaction), and a transaction sender is a
 * key-controlled account that never receives contract code. The one way such
 * an address changes is an EIP-7702 delegation, set or cleared by the account
 * itself, which is why every observation expires recheckBlocks after it was
 * taken. Within that window:
 *  - no code at B answers every block up to B + recheckBlocks: earlier blocks
 *    because code present earlier would still be present at B, later blocks
 *    because a sender gains code only by delegating;
 *  - code at B answers blocks from B to B + recheckBlocks: an earlier block may
 *    precede the deployment or delegation, so it needs its own read.
 * recheckBlocks 0 never reuses an observation. */
export function senderCodeReusable(
  observation: SenderCodeObservation,
  block: number,
  recheckBlocks: number,
): boolean {
  if (
    !Number.isSafeInteger(block) ||
    block < 0 ||
    !Number.isSafeInteger(recheckBlocks) ||
    recheckBlocks < 0
  )
    throw Error("Invalid sender code query");
  if (recheckBlocks === 0) return false;
  if (block > observation.observedBlock + recheckBlocks) return false;
  return observation.codeHash === null || block >= observation.observedBlock;
}
