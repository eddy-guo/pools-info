/** Per-process pacing, not an account-wide quota allocator. Defaults preserve
 * the existing Free-plan behavior; changing them requires verified capacity. */
export function rpcPacing(env: NodeJS.ProcessEnv = process.env) {
  function value(name: string, fallback: number, min: number, max: number) {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!raw.trim() || !Number.isSafeInteger(n) || n < min || n > max)
      throw Error(`Invalid ${name}`);
    return n;
  }
  return {
    minIntervalMs: value("RPC_MIN_INTERVAL_MS", 1000, 0, 10000),
    maxBatchSize: value("RPC_MAX_BATCH_SIZE", 2, 1, 20),
  };
}
