import { setTimeout as sleep } from "node:timers/promises";
import { withLogRpc } from "./log-rpc";
import { safeError, errorDetails } from "./errors";
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
  waitForWriter,
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
  const limits = {
    timeoutMs: 120000,
    maxRequests: 300,
    // Pace provider work by RPC calls, not just HTTP requests. A large JSON-RPC
    // batch can exceed the free provider's throughput even over one connection.
    minIntervalMs: 1000,
    // Three supervised workers share the provider account.
    maxBatchSize: 2,
    // The current provider plan permits ten blocks per eth_getLogs request.
    // Start at that known limit instead of issuing a rejected probe every batch.
    logRangeBlocks: integer("INDEXER_LOG_RANGE_BLOCKS", 10, 1, 10000),
  };
  const state = new Rpc(undefined, limits);
  return process.env.INDEXER_LOG_RPC_URL
    ? withLogRpc(
        state,
        new Rpc(process.env.INDEXER_LOG_RPC_URL, {
          ...limits,
          logRangeBlocks: integer("INDEXER_LOG_RANGE_BLOCKS", 1000, 1, 10000),
        }),
      )
    : state;
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
  let stage = "chain_check";
  try {
    if (Number(await client.call<string>("eth_chainId", [])) !== 4663)
      throw Error("Wrong chain");
    stage = "checkpoint_reconcile";
    const s = await reconcile(db, initial, client);
    stage = "head_read";
    const head = Number(await client.call<string>("eth_blockNumber", []));
    if (!Number.isSafeInteger(head) || head < 128)
      throw Error("Invalid chain head");
    const from = s.cursor === null ? s.start : s.cursor + 1;
    const to = Math.min(head - 128, from + batchSize - 1);
    if (from > to) return;
    stage = "mark_attempt";
    await markAttempt(db, s.key);
    // Pin both boundaries before collecting, including the link to saved history.
    stage = "boundary_pin";
    const first = await header(client, from);
    if (s.hash && first.parentHash !== s.hash)
      throw Error("Checkpoint parent changed");
    if (s.kind === "discovery") {
      stage = "discovery_collect";
      const result = await collectCatalog(undefined, client, {
        fromBlock: from,
        toBlock: to,
      });
      stage = "discovery_boundary_check";
      if (
        (await header(client, from)).hash !== first.hash ||
        (await header(client, to)).hash !== result.catalog.blockHash
      )
        throw Error("Discovery boundary changed");
      stage = "discovery_commit";
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
      stage = "pool_collect";
      const result = await collectPoolEvents(
        { poolId: s.poolId, token, fromBlock: from, toBlock: to },
        client,
      );
      stage = "pool_boundary_check";
      if (
        result.fromBlockParentHash !== first.parentHash ||
        (await header(client, from)).hash !== first.hash ||
        (await header(client, to)).hash !== result.blockHash
      )
        throw Error("Pool boundary changed");
      stage = "pool_commit";
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
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "batch_operation_failed",
        stream: initial.key,
        stage,
        httpRequests: client.requests,
        rpcCalls: client.calls,
        error: safeError(e),
        ...errorDetails(e),
      }),
    );
    throw e;
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
    // Railway briefly overlaps old and new containers during a rolling deploy.
    // Stay alive while the old worker drains, without permitting two writers.
    if (mode === "run")
      console.log(JSON.stringify({ event: "waiting_for_writer" }));
    const locked =
      mode === "run"
        ? await waitForWriter(db, { signal: stop.signal })
        : await acquireWriter(db);
    if (stopping) return;
    if (!locked) throw Error("Another worker holds the writer lock");
    console.log(JSON.stringify({ event: "writer_acquired" }));
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

main().catch((e) => {
  console.error(
    JSON.stringify({ event: "worker_stopped", error: safeError(e) }),
  );
  process.exitCode = 1;
});
