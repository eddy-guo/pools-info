import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { superviseWorkers, type WorkerSpec } from "./supervisor";

// One Railway container runs independent collection and analytics processes.
// Each owns its own DB connection and advisory lock. Ordinary failures restart
// the unit; a sustained RPC rate-limit pause exits cleanly without auto-restart.
const workers: WorkerSpec[] = [];
if (process.env.RECENT_ENABLED === "1")
  workers.push({ name: "recent", file: "./recent-main.ts", args: ["run"] });
workers.push(
  { name: "indexer", file: "./main.ts", args: ["run"] },
  { name: "analytics", file: "./analytics-main.ts", args: ["run"] },
);
const supervisor = superviseWorkers(workers, {
  spawn: ({ file, args }) =>
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL(file, import.meta.url)),
        ...args,
      ],
      { stdio: "inherit", env: process.env },
    ),
  exitCode: (code) => {
    process.exitCode = code;
  },
  log: (event) => console.log(JSON.stringify(event)),
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, supervisor.stop);
