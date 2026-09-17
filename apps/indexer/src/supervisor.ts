import type { ChildProcess } from "node:child_process";

/** Reserved for a worker that has exhausted its sustained RPC-429 allowance. */
export const RPC_RATE_LIMIT_EXIT_CODE = 75;
/** An indivisible broad range needs operator inspection, not automatic retries. */
export const BROAD_CAPACITY_EXIT_CODE = 76;
/** A HyperSync token Envio rejected cannot recover by restarting either. */
export const HYPERSYNC_UNAUTHORIZED_EXIT_CODE = 77;
export interface WorkerSpec {
  name: "recent" | "indexer" | "analytics";
  file: string;
  args: string[];
}
interface SupervisorRuntime {
  spawn: (worker: WorkerSpec) => ChildProcess;
  exitCode: (code: 0 | 1) => void;
  log: (event: {
    event:
      | "service_paused_rpc_rate_limit"
      | "service_paused_broad_capacity"
      | "service_paused_hypersync_unauthorized";
    worker: WorkerSpec["name"];
  }) => void;
}

/** Launch once. A capacity or rate-limit pause drains the unit successfully,
 * so Railway's ON_FAILURE policy cannot restart another round of RPC requests. */
export function superviseWorkers(
  workers: readonly WorkerSpec[],
  runtime: SupervisorRuntime,
) {
  const children = new Set<ChildProcess>();
  let stopping = false;
  let paused = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function cleanedUp(child: ChildProcess) {
    children.delete(child);
    if (!children.size && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  }
  function stop(code: 0 | 1) {
    if (stopping) return;
    stopping = true;
    runtime.exitCode(code);
    if (children.size) {
      timer = setTimeout(() => {
        timer = undefined;
        for (const child of children) child.kill("SIGKILL");
      }, 20000);
      timer.unref();
      for (const child of [...children]) child.kill("SIGTERM");
    }
  }
  for (const worker of workers) {
    if (stopping) break;
    let child: ChildProcess;
    try {
      child = runtime.spawn(worker);
    } catch {
      stop(1);
      break;
    }
    children.add(child);
    child.once("error", () => stop(1));
    child.once("close", () => cleanedUp(child));
    child.once("exit", (code) => {
      cleanedUp(child);
      if (
        code === RPC_RATE_LIMIT_EXIT_CODE ||
        code === BROAD_CAPACITY_EXIT_CODE ||
        code === HYPERSYNC_UNAUTHORIZED_EXIT_CODE
      ) {
        if (!paused) {
          paused = true;
          runtime.log({
            event:
              code === RPC_RATE_LIMIT_EXIT_CODE
                ? "service_paused_rpc_rate_limit"
                : code === BROAD_CAPACITY_EXIT_CODE
                  ? "service_paused_broad_capacity"
                  : "service_paused_hypersync_unauthorized",
            worker: worker.name,
          });
          // A sibling may have failed while another was already reporting 429s.
          // A confirmed pause must still prevent an ON_FAILURE restart.
          runtime.exitCode(0);
        }
        stop(0);
      } else if (!stopping) stop(1);
    });
  }
  return { stop: () => stop(0) };
}
