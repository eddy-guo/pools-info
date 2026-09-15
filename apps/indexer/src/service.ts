import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

// One Railway container runs independent collection and analytics processes.
// Each owns its own DB connection and advisory lock. If any exits, drain
// its siblings and let Railway restart the unit rather than silently going stale.
const children = new Set<ChildProcess>();
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  const timeout = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 20000);
  timeout.unref();
}
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => stop(0));
function start(file: string, args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL(file, import.meta.url)), ...args],
    {
      stdio: "inherit",
      env: process.env,
    },
  );
  children.add(child);
  child.once("error", () => stop(1));
  child.once("exit", () => {
    children.delete(child);
    if (!stopping) stop(1);
  });
  return child;
}
if (process.env.RECENT_ENABLED === "1") start("./recent-main.ts", ["run"]);
start("./main.ts", ["run"]);
start("./analytics-main.ts", ["run"]);
