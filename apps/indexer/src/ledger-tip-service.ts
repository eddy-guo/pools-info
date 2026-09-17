import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { superviseWorkers } from "./supervisor";

// The ledger tip loop's Railway service (docs/AGGREGATE-LEDGER.md phase 3): one
// worker, HyperSync and the public RPC only. It never starts the old indexer's
// discovery, analytics or recent workers, which read Alchemy. An ordinary
// failure exits 1 for a restart from the saved cursor; a reserved stop
// (throttled, capacity, unauthorized, inspection) exits 0 so ON_FAILURE does
// not restart it.
const supervisor = superviseWorkers(
  [{ name: "ledger-tip", file: "./ledger-tip-main.ts", args: ["run"] }],
  {
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
  },
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, supervisor.stop);
