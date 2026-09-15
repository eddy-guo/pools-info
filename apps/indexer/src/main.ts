import { rpcPacing } from "./rpc-pacing";
import {
  canonicalHeader as header,
  reconcileStream as reconcile,
} from "./checkpoints";
import { alignedPoolEnd, runPoolGroup } from "./pool-group-worker";
import { PoolBatchBudget } from "./pool-budget";
import { setTimeout as sleep } from "node:timers/promises";
import { withLogRpc } from "./log-rpc";
import { safeError, errorDetails } from "./errors";
import { collectCatalog, collectPoolEvents, Rpc } from "@pools/chain";
import {
  acquireWriter,
  commitBatch,
  createClient,
  ensureDiscovery,
  getStream,
  markAttempt,
  migrate,
  nextPoolGroup,
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
    ...rpcPacing(),
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
    const to =
      s.kind === "pool"
        ? alignedPoolEnd(from, batchSize, head - 128)
        : Math.min(head - 128, from + batchSize - 1);
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
    const poolBudget = new PoolBatchBudget(batch);
    const budgetOptions = (keys: string[]) => ({
      signal: stop.signal,
      onReduce: (previousBatchBlocks: number, nextBatchBlocks: number) =>
        console.log(
          JSON.stringify({
            event: "pool_batch_reduced",
            streams: keys,
            previousBatchBlocks,
            nextBatchBlocks,
          }),
        ),
    });
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
      let attempted = 0;
      while (attempted < poolsPerCycle && !stopping) {
        let group: (Stream & { token: string })[];
        try {
          group = await nextPoolGroup(db, poolsPerCycle - attempted);
          if (!group.length) break;
          for (const pool of group) await markAttempt(db, pool.key);
          attempted += group.length;
        } catch (error) {
          failed = true;
          cycleError ??= error;
          console.error(
            JSON.stringify({
              event: "pool_selection_failed",
              error: safeError(error),
            }),
          );
          break;
        }
        if (stopping) break;
        if (group.length > 1) {
          try {
            const keys = group.map((p) => p.key);
            await poolBudget.run(
              keys,
              async (size) => {
                const current = await Promise.all(
                  group.map(async (p) => ({
                    ...(await getStream(db, p.key)),
                    token: p.token,
                  })),
                );
                return runPoolGroup(db, current, rpc(), size, stop.signal);
              },
              budgetOptions(keys),
            );
            continue;
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "pool_group_fallback",
                pools: group.length,
                error: safeError(error),
              }),
            );
          }
        }
        // Re-read after reconciliation or a failed group. A bad member must not
        // indefinitely prevent its healthy peers from advancing independently.
        for (const pool of group) {
          if (stopping) break;
          try {
            await poolBudget.run(
              [pool.key],
              async (size) =>
                runBatch(db, await getStream(db, pool.key), size, pool.token),
              budgetOptions([pool.key]),
            );
          } catch (error) {
            failed = true;
            cycleError ??= error;
            console.error(
              JSON.stringify({
                event: "pool_batch_failed",
                pool: pool.poolId,
                error: safeError(error),
              }),
            );
          }
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
