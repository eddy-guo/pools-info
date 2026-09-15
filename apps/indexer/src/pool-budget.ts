/** Keep dense pools moving without weakening evidence checks or increasing RPC rates.
 * Sizes are process-local hints; durable cursors remain the only progress authority. */
export class PoolBatchBudget {
  private sizes = new Map<string, number>();
  constructor(private readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2000)
      throw Error("Invalid pool batch maximum");
  }

  async run<T>(
    keys: string[],
    attempt: (blocks: number) => Promise<T>,
    options: {
      signal?: AbortSignal;
      onReduce?: (previous: number, next: number) => void;
    } = {},
  ): Promise<T> {
    if (!keys.length || keys.length > 200 || new Set(keys).size !== keys.length)
      throw Error("Invalid pool batch keys");
    let blocks = Math.min(
      ...keys.map((k) => this.sizes.get(k) ?? this.maximum),
    );
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        return await attempt(blocks);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const budget =
          /^(Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls|Event (?:group|batch) exceeds 10000 logs; use a smaller range)$/.test(
            message,
          );
        if (!budget || blocks === 1 || options.signal?.aborted) throw error;
        const smaller = Math.max(1, Math.floor(blocks / 2));
        for (const key of keys) this.sizes.set(key, smaller);
        options.onReduce?.(blocks, smaller);
        blocks = smaller;
      }
    }
  }
}
