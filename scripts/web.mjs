import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (mode !== "dev" && mode !== "preview") {
  console.error("Usage: node scripts/web.mjs dev|preview");
  process.exit(1);
}

try {
  process.loadEnvFile(fileURLToPath(new URL("../.env.local", import.meta.url)));
} catch (error) {
  if (error.code !== "ENOENT") {
    console.error("Unable to load the root .env.local file.");
    process.exit(1);
  }
}

const webRoot = new URL("../apps/web/", import.meta.url);
const require = createRequire(new URL("package.json", webRoot));
const grouped = process.platform !== "win32";
// Load environment values above, rather than passing env-file flags that Next
// would copy into NODE_OPTIONS when it starts its development server child.
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    mode === "dev" ? "dev" : "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3100",
  ],
  {
    cwd: webRoot,
    env: process.env,
    stdio: "inherit",
    detached: grouped,
  },
);

let stopping;
let killTimer;
function signalChild(signal) {
  if (!child.pid) return;
  try {
    if (grouped) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      console.error("Unable to signal the web server process.");
      process.exitCode = 1;
    }
  }
}
const handlers = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (stopping) {
      signalChild("SIGKILL");
      return;
    }
    stopping = signal;
    signalChild(signal);
    killTimer = setTimeout(() => signalChild("SIGKILL"), 10000);
    killTimer.unref();
  };
  handlers.set(signal, handler);
  process.on(signal, handler);
}

child.on("error", () => {
  console.error("Unable to start the web server.");
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  clearTimeout(killTimer);
  for (const [name, handler] of handlers) process.off(name, handler);
  const terminalSignal = signal ?? stopping;
  process.exitCode = terminalSignal
    ? 128 + (constants.signals[terminalSignal] ?? 1)
    : (code ?? 1);
});
