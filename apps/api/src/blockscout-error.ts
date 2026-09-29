/** Why the explorer could not answer, as the wallet history route reports it.
 * `budget_unavailable` is the shared credit budget's store not answering: no
 * paid call is ever made without a reservation, so the read is refused. */
export type BlockscoutFailure =
  | "misconfigured_key"
  | "key_rejected"
  | "upstream_unavailable"
  | "budget_exhausted"
  | "budget_unavailable";
export class BlockscoutError extends Error {
  constructor(
    public kind: BlockscoutFailure,
    /** Seconds a caller should wait before trying the explorer again. */
    public retryAfter: number,
  ) {
    super(kind);
  }
}
