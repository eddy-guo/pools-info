import { RequestError } from "./request";

type Query = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export const ledgerFreshnessDefaults = Object.freeze({
  /** Ten minutes without a committed batch is six missed production cycles
   * (one every 80 to 90 s). The collector's own `/health` degrades on the
   * same age, from the same variable, `LEDGER_STALE_MS`. */
  staleMs: 600000,
});
export function ledgerStaleSetting(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.LEDGER_STALE_MS;
  if (raw === undefined) return ledgerFreshnessDefaults.staleMs;
  const n = Number(raw);
  if (!raw.trim() || !Number.isSafeInteger(n) || n < 60000 || n > 86400000)
    throw Error("Invalid LEDGER_STALE_MS");
  return n;
}

/** The aggregate ledger's freshness as `agg_streams` records it: the
 * committed cursor against the head the collector last saw, and how long
 * ago the stream last moved. Served on `/health` and `/v1/status`. */
export interface LedgerFreshness {
  cursorBlock: number;
  cursorTimestamp: number;
  headBlock: number | null;
  headTimestamp: number | null;
  lagBlocks: number | null;
  lagSeconds: number | null;
  /** The last commit that moved the stream: a folded batch or a mode change. */
  indexedAt: string;
  /** The collector's last head observation, at the start of every cycle. */
  checkedAt: string | null;
  /** Seconds since `indexedAt` on the database's own clock, which stamped
   * it, so a container's clock cannot skew the verdict. */
  ageSeconds: number;
  staleAfterSeconds: number;
  /** `ageSeconds` past the threshold: the ledger has stopped moving. */
  stale: boolean;
}
export const ledgerFreshnessSql = `SELECT cursor_block::text,cursor_timestamp::text,head_block::text,head_timestamp::text,checked_at,updated_at,
  GREATEST(0,floor(extract(epoch FROM clock_timestamp()-updated_at)))::bigint::text AS age_seconds
  FROM agg_streams WHERE chain_id=4663 AND stream_key='ledger:agg:v1'`;

function chainNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RequestError(503, "chain_evidence_invalid");
  return n;
}
function isoTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime()))
    throw new RequestError(503, "chain_evidence_invalid");
  return date.toISOString();
}
/** Null without a ledger row or before the pass has committed a cursor. */
export function ledgerFreshness(
  row: Record<string, unknown> | undefined,
  staleMs: number,
): LedgerFreshness | null {
  if (!row || row.cursor_block === null || row.cursor_block === undefined)
    return null;
  const cursorBlock = chainNumber(row.cursor_block)!;
  const cursorTimestamp = chainNumber(row.cursor_timestamp)!;
  const headBlock = chainNumber(row.head_block);
  const headTimestamp = chainNumber(row.head_timestamp);
  const ageSeconds = chainNumber(row.age_seconds)!;
  return {
    cursorBlock,
    cursorTimestamp,
    headBlock,
    headTimestamp,
    lagBlocks: headBlock === null ? null : Math.max(0, headBlock - cursorBlock),
    lagSeconds:
      headTimestamp === null
        ? null
        : Math.max(0, headTimestamp - cursorTimestamp),
    indexedAt: isoTime(row.updated_at)!,
    checkedAt: isoTime(row.checked_at),
    ageSeconds,
    staleAfterSeconds: Math.floor(staleMs / 1000),
    stale: ageSeconds * 1000 > staleMs,
  };
}
export async function readLedgerFreshness(query: Query, staleMs: number) {
  const { rows } = await query(ledgerFreshnessSql);
  return ledgerFreshness(rows[0], staleMs);
}
