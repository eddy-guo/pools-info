import pg from "pg";
import type {
  AnalyticsExploreResponse,
  AnalyticsLeaderboardResponse,
} from "@pools/core";
import { readData } from "./reader";
import { ledgerCut, type MarketSource } from "./ledger-market";
import { parseRequest } from "./request";
import { warmPolicy, type WarmAttempt } from "./database-warmth";

export const databaseIdentitySql =
  "SELECT pg_postmaster_start_time()::text AS identity, pg_backend_pid() AS backend_pid";

async function cancelBackend(url: string, pid: number) {
  const client = new pg.Client({
    connectionString: url,
    connectionTimeoutMillis: 1000,
    statement_timeout: 1000,
    query_timeout: 2000,
    application_name: "pools-reader-warmup-cancel",
  });
  client.on("error", () => {});
  try {
    await client.connect();
    await client.query("SELECT pg_cancel_backend($1)", [pid]);
  } finally {
    await client.end().catch(() => {});
  }
}

/** The production readers, in the approved order. No alternate SQL summaries,
 * accounting snapshots, cached responses or writes are used to warm them. */
export function createWarmSet(
  url: string,
  marketSource: MarketSource,
  testSchema?: string,
  log: (event: Record<string, unknown>) => void = () => {},
) {
  if (testSchema && !/^api_test_[a-z0-9_]+$/.test(testSchema))
    throw Error("Invalid test schema");
  return async (context: WarmAttempt) => {
    const client = new pg.Client({
      connectionString: url,
      connectionTimeoutMillis: 2000,
      statement_timeout: warmPolicy.statementMs,
      query_timeout: warmPolicy.statementMs + 1000,
      application_name: "pools-reader-warmup",
      options:
        "-c default_transaction_read_only=on -c jit=off" +
        (testSchema ? ` -c search_path=${testSchema}` : ""),
    });
    let backendPid: number | null = null;
    let cancellation: Promise<void> | null = null;
    const disconnect = () => {
      if (cancellation) return;
      cancellation = (
        backendPid ? cancelBackend(url, backendPid) : Promise.resolve()
      )
        .catch(() => {})
        .then(() => client.end())
        .catch(() => {});
    };
    const timeout = setTimeout(() => {
      disconnect();
    }, warmPolicy.attemptMs);
    const abort = () => {
      disconnect();
    };
    context.signal.addEventListener("abort", abort, { once: true });
    client.on("error", () => {});
    try {
      context.signal.throwIfAborted();
      await client.connect();
      context.signal.throwIfAborted();
      const identity = (await client.query(databaseIdentitySql)).rows[0];
      backendPid = Number(identity.backend_pid);
      context.identity(identity.identity);
      // Autocommit is intentional: the tip's idle warmer must never hold a
      // transaction across a writer cycle. Serving readers' local planner
      // settings apply to this disposable read-only session instead.
      const query = (sql: string, values?: unknown[]) => {
        context.signal.throwIfAborted();
        return client.query(sql.replace(/^SET LOCAL /, "SET "), values);
      };
      async function measured<T>(
        name: string,
        read: () => Promise<T>,
      ): Promise<T> {
        const start = performance.now();
        const timer = setTimeout(
          () => context.slow(name),
          warmPolicy.servingMs,
        );
        try {
          const result = await read();
          const ms = performance.now() - start;
          if (ms >= warmPolicy.servingMs) context.slow(name);
          log({ event: "database_warm_read", name, ms: Math.round(ms) });
          return result;
        } catch (error) {
          log({
            event: "database_warm_read_failed",
            name,
            ms: Math.round(performance.now() - start),
            code:
              typeof (error as { code?: unknown })?.code === "string"
                ? (error as { code: string }).code
                : null,
          });
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      const read = (path: string) =>
        readData(query, parseRequest(path), marketSource);
      const explore = await measured("screener", async () => {
        const ranked = (await read(
          "/v1/explore?window=24h&sort=volume&limit=25",
        )) as AnalyticsExploreResponse;
        await read("/v1/explore?window=24h&sort=launch&limit=6");
        return ranked;
      });
      const home = (await measured("home_leaderboard", () =>
        read("/v1/leaderboard?window=24h&limit=5&minTrades=10"),
      )) as AnalyticsLeaderboardResponse;
      const traders = (await measured("traders", () =>
        read("/v1/leaderboard?window=7d&limit=25&minTrades=10"),
      )) as AnalyticsLeaderboardResponse;
      await measured("busy_pool", async () => {
        // A quiet launch is not a substitute for real market history. Prefer
        // the ledger's busiest lifetime pool even when this day's flow is low.
        const busy =
          marketSource === "ledger"
            ? (
                await query(`SELECT p.pool_id FROM agg_pool_state s JOIN indexed_pools p USING(chain_id,pool_ref)
              WHERE s.chain_id=4663 AND s.trades>0 ORDER BY s.trades DESC,p.pool_id LIMIT 1`)
              ).rows[0]?.pool_id
            : explore.items.find((p) => (p.stats.trades ?? 0) > 0)?.id;
        if (busy) await read(`/v1/pools/${busy}?window=24h`);
      });
      if (marketSource === "ledger")
        await measured("ledger_cut", () => ledgerCut(query));
      await measured("wallet", async () => {
        let wallet = traders.items[0]?.address ?? home.items[0]?.address;
        if (!wallet && marketSource === "ledger")
          wallet = (
            await query(`SELECT '0x'||encode(w.address,'hex') AS address FROM agg_wallets w
            WHERE EXISTS(SELECT 1 FROM agg_positions p WHERE p.chain_id=4663 AND p.wallet_ref=w.wallet_ref) LIMIT 1`)
          ).rows[0]?.address;
        if (wallet) await read(`/v1/wallets/${wallet}?window=All`);
      });
      context.signal.throwIfAborted();
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", abort);
      if (cancellation) await cancellation;
      else await client.end();
    }
  };
}
