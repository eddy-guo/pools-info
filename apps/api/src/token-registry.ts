/** One registry row: the pool's surrogate key, which only grows, its pool id
 * and its launch token, lowercase as `indexed_pools` stores them. */
export interface RegistryToken {
  ref: number;
  poolId: string;
  token: string;
}

/** The launch tokens of the verified registry (`indexed_pools`), whose rows are
 * admitted only after the pool id is recomputed from its key. The explorer's
 * trade list keeps a PoolManager leg only when its token is here: a Transfer
 * log's token is the contract that emitted it, which the EVM sets, so a
 * spoofing contract can write any `from` and `to` but never a registered
 * token's address. */
export interface TokenRegistry {
  current(): Promise<ReadonlySet<string>>;
  /** The pool of a token in the set `current()` last answered: null when the
   * token is not there, or when more than one registered pool launched it. */
  poolOf(token: string): string | null;
}

/** Holds the set in memory. It loads every token once, then only rows past the
 * highest ref it holds every `refreshMs`, and reloads in full every
 * `fullReloadMs` so a pool a reorg removed drops out. Concurrent callers share
 * one load. A failed refresh keeps serving the last set it loaded, since that
 * set was verified when it was read; with no set yet, the failure is the
 * caller's. */
export function createTokenRegistry(
  load: (afterRef: number) => Promise<RegistryToken[]>,
  {
    now = Date.now,
    refreshMs = 30000,
    fullReloadMs = 3600000,
  }: { now?: () => number; refreshMs?: number; fullReloadMs?: number } = {},
): TokenRegistry {
  let tokens: Set<string> | null = null;
  let pools = new Map<string, string | null>();
  let lastRef = 0,
    refreshedAt = 0,
    fullAt = 0;
  let pending: Promise<void> | null = null;
  async function refresh() {
    const t = now();
    const full = !tokens || t - fullAt >= fullReloadMs;
    const rows = await load(full ? 0 : lastRef);
    const next = full ? new Set<string>() : tokens!;
    const nextPools = full ? new Map<string, string | null>() : pools;
    let max = full ? 0 : lastRef;
    for (const row of rows) {
      next.add(row.token);
      const held = nextPools.get(row.token);
      nextPools.set(
        row.token,
        held === undefined ? row.poolId : held === row.poolId ? held : null,
      );
      if (row.ref > max) max = row.ref;
    }
    tokens = next;
    pools = nextPools;
    lastRef = max;
    refreshedAt = t;
    if (full) fullAt = t;
  }
  return {
    async current() {
      if (!tokens || now() - refreshedAt >= refreshMs) {
        pending ??= refresh().finally(() => {
          pending = null;
        });
        try {
          await pending;
        } catch (error) {
          if (!tokens) throw error;
          process.stderr.write('{"event":"token_registry_refresh_failed"}\n');
        }
      }
      return tokens!;
    },
    poolOf(token) {
      return pools.get(token) ?? null;
    },
  };
}
