import { setTimeout as sleep } from "node:timers/promises";
import { collectCatalog, collectPoolEvents, Rpc } from "@pools/chain";
import {
  acquireWriter,
  checkpoints,
  commitBatch,
  createClient,
  ensureDiscovery,
  getStream,
  markAttempt,
  migrate,
  nextPool,
  rewind,
  status,
  type Client,
  type Stream,
} from "@pools/db";

function integer(name: string, fallback: number, min: number, max: number) {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw Error(`Invalid ${name}`);
  return n;
}
function rpc() {
  return new Rpc(undefined, {
    timeoutMs: 120000,
    maxRequests: 300,
    // Pace provider work by RPC calls, not just HTTP requests. A large JSON-RPC
    // batch can exceed the free provider's throughput even over one connection.
    minIntervalMs: 1000,
    maxBatchSize: 5,
  });
}
const hex = (n: number) => `0x${n.toString(16)}`;
type Header = { number: string; hash: string; parentHash: string };
async function header(client: Rpc, n: number) {
  const b = await client.call<Header>("eth_getBlockByNumber", [hex(n), false]);
  if (!b || Number(b.number) !== n || !/^0x[0-9a-f]{64}$/i.test(b.hash))
    throw Error("Missing canonical header");
  return b;
}
async function reconcile(db: Client, s: Stream, client: Rpc): Promise<Stream> {
  if (s.cursor === null) return s;
  if ((await header(client, s.cursor)).hash === s.hash) return s;
  let ancestor: number | null = null;
  for (const batch of await checkpoints(db, s.key)) {
    if ((await header(client, batch.to)).hash === batch.hash) {
      ancestor = batch.to;
      break;
    }
  }
  await rewind(db, s, ancestor);
  console.log(
    JSON.stringify({
      event: "rewind",
      stream: s.key,
      from: s.cursor,
      to: ancestor,
    }),
  );
  return getStream(db, s.key);
}
async function runBatch(
  db: Client,
  initial: Stream,
  batchSize: number,
  token?: string,
) {
  const client = rpc();
  if (Number(await client.call<string>("eth_chainId", [])) !== 4663)
    throw Error("Wrong chain");
  const s = await reconcile(db, initial, client);
  const head = Number(await client.call<string>("eth_blockNumber", []));
  if (!Number.isSafeInteger(head) || head < 128)
    throw Error("Invalid chain head");
  const from = s.cursor === null ? s.start : s.cursor + 1;
  const to = Math.min(head - 128, from + batchSize - 1);
  if (from > to) return;
  await markAttempt(db, s.key);
  // Pin both boundaries before collecting, including the link to saved history.
  const first = await header(client, from);
  if (s.hash && first.parentHash !== s.hash)
    throw Error("Checkpoint parent changed");
  if (s.kind === "discovery") {
    const result = await collectCatalog(undefined, client, {
      fromBlock: from,
      toBlock: to,
    });
    if (
      (await header(client, from)).hash !== first.hash ||
      (await header(client, to)).hash !== result.catalog.blockHash
    )
      throw Error("Discovery boundary changed");
    await commitBatch(db, s, {
      from,
      to,
      hash: result.catalog.blockHash,
      evidence: result.evidence,
      pools: result.catalog.pools,
    });
    console.log(
      JSON.stringify({
        event: "discovered",
        from,
        to,
        pools: result.catalog.pools.length,
        httpRequests: client.requests,
        rpcCalls: client.calls,
      }),
    );
  } else {
    if (!token || !s.poolId) throw Error("Missing pool identity");
    const result = await collectPoolEvents(
      { poolId: s.poolId, token, fromBlock: from, toBlock: to },
      client,
    );
    if (
      result.fromBlockParentHash !== first.parentHash ||
      (await header(client, from)).hash !== first.hash ||
      (await header(client, to)).hash !== result.blockHash
    )
      throw Error("Pool boundary changed");
    await commitBatch(db, s, {
      from,
      to,
      hash: result.blockHash,
      token,
      evidence: result.evidence,
      events: [
        ...result.swaps.map((e) => ({
          ...e,
          kind: "swap" as const,
          payload: e,
        })),
        ...result.transfers.map((e) => ({
          ...e,
          kind: "transfer" as const,
          payload: e,
        })),
      ],
    });
    console.log(
      JSON.stringify({
        event: "indexed",
        pool: s.poolId,
        from,
        to,
        swaps: result.swaps.length,
        transfers: result.transfers.length,
        httpRequests: client.requests,
        rpcCalls: client.calls,
      }),
    );
  }
}
let stopping = false;
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true;
    stop.abort();
  });
async function main() {
  const mode = process.argv[2] ?? "run";
  if (!["run", "once", "migrate", "status"].includes(mode))
    throw Error("Expected run, once, migrate or status");
  const db = createClient();
  db.on("error", () => {
    console.error(JSON.stringify({ event: "database_disconnected" }));
    stopping = true;
    stop.abort();
    process.exitCode = 1;
  });
  await db.connect();
  try {
    if (mode === "migrate") {
      await migrate(db);
      console.log("Database migrations applied");
      return;
    }
    if (mode === "status") {
      console.log(JSON.stringify(await status(db), null, 2));
      return;
    }
    if (!process.env.ROBINHOOD_RPC_URL)
      throw Error("ROBINHOOD_RPC_URL is required for the persistent worker");
    const start = integer(
      "INDEXER_START_BLOCK",
      -1,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const batch = integer("INDEXER_BATCH_BLOCKS", 1000, 1, 2000);
    const interval = integer("INDEXER_POLL_MS", 15000, 1000, 300000);
    const poolsPerCycle = integer("INDEXER_POOLS_PER_CYCLE", 2, 1, 20);
    const locked = await acquireWriter(db);
    if (!locked) throw Error("Another worker holds the writer lock");
    // Production migrations are an explicit command, not hidden in the worker.
    await ensureDiscovery(db, start);
    let failures = 0;
    while (!stopping) {
      let cycleError: unknown;
      let failed = false;
      try {
        await runBatch(db, await getStream(db, "discovery:v1"), batch);
      } catch (e) {
        failed = true;
        cycleError = e;
        console.error(
          JSON.stringify({
            event: "discovery_batch_failed",
            error: safeError(e),
          }),
        );
      }
      // Discovery and each pool are independent retry units. A broken launch
      // cannot prevent already-known pools from making progress in this cycle.
      for (let i = 0; i < poolsPerCycle && !stopping; i++) {
        let pool: (Stream & { token: string }) | null = null;
        let rotated = false;
        try {
          pool = await nextPool(db);
          if (!pool) break;
          // Rotate before attempting, including caught-up or failing streams.
          await markAttempt(db, pool.key);
          rotated = true;
          if (stopping) break;
          await runBatch(db, pool, batch, pool.token);
        } catch (e) {
          failed = true;
          cycleError ??= e;
          console.error(
            JSON.stringify({
              event: "pool_batch_failed",
              pool: pool?.poolId ?? null,
              error: safeError(e),
            }),
          );
          // Failed pool selection or rotation cannot safely select another pool.
          if (!rotated) break;
        }
      }
      failures = failed ? failures + 1 : 0;
      if (failed)
        console.error(
          JSON.stringify({
            event: "cycle_failed",
            error: safeError(cycleError),
            consecutiveFailures: failures,
          }),
        );
      // Finish the in-flight operation on termination, without another attempt
      // or a final poll. A failed one-shot still tries all independent streams.
      if (stopping) break;
      if (failed && (mode === "once" || failures >= 5)) throw cycleError;
      if (mode === "once") break;
      await sleep(Math.min(300000, interval * 2 ** failures), undefined, {
        signal: stop.signal,
      }).catch((e) => {
        if (e.name !== "AbortError") throw e;
      });
    }
  } finally {
    await db.end();
  }
}
function safeError(e: unknown) {
  // Return our own descriptions, never arbitrary provider, SQL or fetch text.
  const message = e instanceof Error ? e.message : "";
  if (
    /^Invalid INDEXER_(START_BLOCK|BATCH_BLOCKS|POLL_MS|POOLS_PER_CYCLE)$/.test(
      message,
    )
  )
    return `configuration_invalid: ${message}`;
  const categories: [RegExp, string][] = [
    [
      /^DATABASE_URL is required$/,
      "database_configuration_missing: set DATABASE_URL",
    ],
    [
      /^ROBINHOOD_RPC_URL is required for the persistent worker$/,
      "rpc_configuration_missing: set ROBINHOOD_RPC_URL",
    ],
    [
      /^INDEXER_START_BLOCK differs from saved start;/,
      "start_block_changed: restore the original INDEXER_START_BLOCK",
    ],
    [
      /^Another worker holds the writer lock$/,
      "writer_busy: keep one indexer replica",
    ],
    [/^Wrong chain$/, "wrong_chain: configure Robinhood chain 4663 RPC"],
    [
      /^(Invalid chain head|Missing canonical header|Missing or invalid event header|Missing header)$/,
      "invalid_header: check the RPC endpoint and retry",
    ],
    [
      /^(Checkpoint parent changed|Discovery boundary changed|Pool boundary changed|Cutoff changed during (event )?collection)$/,
      "chain_changed: retry and reconcile the saved checkpoint",
    ],
    [
      /^Collection budget exceeded after [0-9]+ HTTP requests and [0-9]+ RPC calls$/,
      "rpc_budget_exceeded: reduce INDEXER_BATCH_BLOCKS or check RPC capacity",
    ],
    [
      /^(Event batch exceeds 10000 logs;|Catalog batch exceeds 250 launches;)/,
      "batch_too_large: reduce INDEXER_BATCH_BLOCKS",
    ],
    [
      /^(RPC HTTP (429|5[0-9]{2})|RPC returned an error or missing result)$/,
      "rpc_unavailable: check provider capacity and retry",
    ],
    [
      /^(Unexpected event source or range|Unexpected launch source|Unsupported or inconsistent PoolKey|Unverified catalog launch|Inconsistent event receipt or canonical block|Missing or invalid event receipt|Duplicate event evidence)$/,
      "evidence_rejected: inspect contract registry and RPC evidence before resuming",
    ],
    [
      /^(Conflicting replay|Stale checkpoint or noncontiguous batch|Stale rewind|Unknown ancestor)$/,
      "checkpoint_conflict: stop duplicate writers and inspect saved coverage",
    ],
    [
      /^Applied migration changed;/,
      "migration_changed: restore the applied migration and add a new one",
    ],
  ];
  for (const [pattern, description] of categories)
    if (pattern.test(message)) return description;
  if (e && typeof e === "object" && "code" in e) {
    if (e.code === "42P01") return "schema_missing: run indexer migrations";
    if (e.code === "28P01")
      return "database_authentication_failed: check DATABASE_URL credentials";
    if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND")
      return "connection_failed: check database and RPC connectivity";
  }
  return "operation_failed: saved checkpoint preserved; inspect configuration and retry";
}
main().catch((e) => {
  console.error(
    JSON.stringify({ event: "worker_stopped", error: safeError(e) }),
  );
  process.exitCode = 1;
});
