import type { Hex } from "viem";
import { Rpc, RpcRateLimitExhausted, readTokenSupplies } from "@pools/chain";
import {
  createClient,
  saveTokenSupplies,
  tokenSupplyCoverage,
  unreadTokenSupplies,
} from "@pools/db";
import { errorDetails } from "./errors";
import { RPC_RATE_LIMIT_EXIT_CODE } from "./supervisor";
import { runTokenSupplyRead, tokenSupplyConfig } from "./token-supply";

// Token supplies for FDV (apps/indexer/src/token-supply.ts). Manual, never
// started by service.ts, and it applies no migration:
//   pnpm supply:read status    counts read and unread catalog pools, no network
//   pnpm supply:read run       reads totalSupply() for every unread token
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => stop.abort());
const emit = (event: Record<string, unknown>) =>
  console.log(JSON.stringify(event));
async function main() {
  const mode = process.argv[2];
  if (mode !== "run" && mode !== "status")
    throw Error("Expected run or status");
  const config = tokenSupplyConfig();
  const db = createClient();
  db.on("error", () => {
    stop.abort();
    process.exitCode = 1;
    console.error(
      JSON.stringify({ event: "token_supply_database_disconnected" }),
    );
  });
  await db.connect();
  try {
    emit({
      event: "token_supply_coverage",
      ...(await tokenSupplyCoverage(db)),
    });
    if (mode === "status") return;
    const rpc = new Rpc(config.rpcUrl, {
      timeoutMs: 3_600_000,
      maxRequests: config.maxRequests,
      minIntervalMs: config.minIntervalMs,
      maxBatchSize: 1,
      onRateLimit: (event) =>
        console.error(JSON.stringify({ event: "rpc_rate_limited", ...event })),
    }).withAbortSignal(stop.signal);
    emit({
      event: "token_supply_configured",
      rpcHost: new URL(config.rpcUrl).hostname,
      minIntervalMs: config.minIntervalMs,
      maxRequests: config.maxRequests,
    });
    const summary = await runTokenSupplyRead({
      unread: (after, limit) => unreadTokenSupplies(db, after, limit),
      save: (rows) => saveTokenSupplies(db, rows),
      head: async () => Number(await rpc.call<Hex>("eth_blockNumber", [])),
      read: async (tokens, block) => {
        const r = await readTokenSupplies(rpc, tokens, block);
        return {
          supplies: r.supplies,
          aggregated: r.evidence.some((e) => e.kind === "multicall3"),
        };
      },
      requests: () => rpc.requests,
      log: emit,
      signal: stop.signal,
    });
    emit({ event: "token_supply_summary", ...summary });
    emit({
      event: "token_supply_coverage",
      ...(await tokenSupplyCoverage(db)),
    });
  } finally {
    await db.end();
  }
}
main().catch((e) => {
  console.error(
    JSON.stringify({ event: "token_supply_failed", ...errorDetails(e) }),
  );
  process.exitCode =
    e instanceof RpcRateLimitExhausted ? RPC_RATE_LIMIT_EXIT_CODE : 1;
});
