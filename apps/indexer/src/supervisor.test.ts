import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  superviseWorkers,
  RPC_RATE_LIMIT_EXIT_CODE,
  type WorkerSpec,
} from "./supervisor";

const workers: WorkerSpec[] = [
  { name: "recent", file: "recent-main.ts", args: ["run"] },
  { name: "indexer", file: "main.ts", args: ["run"] },
  { name: "analytics", file: "analytics-main.ts", args: ["run"] },
];
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const children: (ChildProcess & { signals: NodeJS.Signals[] })[] = [];
  const logs: unknown[] = [];
  let exitCode: number | undefined;
  const supervisor = superviseWorkers(workers, {
    spawn: () => {
      const child = new EventEmitter() as ChildProcess & {
        signals: NodeJS.Signals[];
      };
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal as NodeJS.Signals);
        return true;
      };
      children.push(child);
      return child;
    },
    exitCode: (code) => {
      exitCode = code;
    },
    log: (event) => {
      logs.push(event);
    },
  });
  return { supervisor, children, logs, exitCode: () => exitCode };
}

test("a worker's reserved rate-limit exit drains siblings and pauses without restarting", (t) => {
  const f = fixture(t);
  f.children[0].emit("exit", RPC_RATE_LIMIT_EXIT_CODE, null);
  assert.equal(f.exitCode(), 0);
  assert.deepEqual(f.logs, [
    { event: "service_paused_rpc_rate_limit", worker: "recent" },
  ]);
  assert.deepEqual(
    f.children.map((c) => c.signals),
    [[], ["SIGTERM"], ["SIGTERM"]],
  );
  // One sibling drains normally. Only the remaining process needs SIGKILL.
  f.children[1].emit("exit", 0, null);
  t.mock.timers.tick(19999);
  assert.deepEqual(f.children[2].signals, ["SIGTERM"]);
  t.mock.timers.tick(1);
  assert.deepEqual(f.children[2].signals, ["SIGTERM", "SIGKILL"]);
  f.children[2].emit("exit", null, "SIGKILL");
  t.mock.timers.tick(60000);
  assert.equal(f.children.length, 3);
  assert.equal(f.exitCode(), 0);
});

test("generic exits, signals and spawn errors remain failures", async (t) => {
  for (const event of ["success", "failure", "signal", "error"] as const)
    await t.test(event, (sub) => {
      const f = fixture(sub);
      if (event === "error")
        f.children[0].emit("error", Error("sensitive details"));
      else
        f.children[0].emit(
          "exit",
          event === "success" ? 0 : event === "failure" ? 1 : null,
          event === "signal" ? "SIGKILL" : null,
        );
      assert.equal(f.exitCode(), 1);
      assert.deepEqual(f.logs, []);
      assert.deepEqual(f.children[1].signals, ["SIGTERM"]);
      assert.deepEqual(f.children[2].signals, ["SIGTERM"]);
      for (const child of f.children) child.emit("close", 0, null);
      sub.mock.timers.tick(60000);
      assert.equal(f.children.length, 3);
    });
});

test("external shutdown drains all three workers successfully and cancels the escalation timer", (t) => {
  const f = fixture(t);
  f.supervisor.stop();
  assert.equal(f.exitCode(), 0);
  assert.deepEqual(
    f.children.map((c) => c.signals),
    [["SIGTERM"], ["SIGTERM"], ["SIGTERM"]],
  );
  for (const child of f.children) child.emit("exit", 1, null);
  t.mock.timers.tick(20000);
  assert.deepEqual(
    f.children.map((c) => c.signals),
    [["SIGTERM"], ["SIGTERM"], ["SIGTERM"]],
  );
  assert.equal(f.exitCode(), 0);
  assert.deepEqual(f.logs, []);
});

test("a confirmed rate-limit pause overrides a concurrent generic failure without duplicate pause logs", (t) => {
  const f = fixture(t);
  f.children[0].emit("exit", 1, null);
  assert.equal(f.exitCode(), 1);
  f.children[1].emit("exit", RPC_RATE_LIMIT_EXIT_CODE, null);
  f.children[2].emit("exit", RPC_RATE_LIMIT_EXIT_CODE, null);
  assert.equal(f.exitCode(), 0);
  assert.equal(f.logs.length, 1);
  t.mock.timers.tick(20000);
  assert.equal(f.children.length, 3);
});

test("synchronous spawn failure stops startup without creating replacement workers", () => {
  let spawns = 0,
    code: number | undefined;
  superviseWorkers(workers, {
    spawn: () => {
      spawns++;
      throw Error("spawn failed");
    },
    exitCode: (value) => {
      code = value;
    },
    log: () => assert.fail("unexpected log"),
  });
  assert.equal(spawns, 1);
  assert.equal(code, 1);
});

test("actual service entry maps exit75 to process exit0 and ordinary exits to exit1", () => {
  const service = fileURLToPath(new URL("./service.ts", import.meta.url));
  for (const childCode of [75, 1]) {
    const script = `
      import cp from "node:child_process";
      import {syncBuiltinESMExports} from "node:module";
      import {EventEmitter} from "node:events";
      const workers=[];
      cp.spawn=()=>{const c=new EventEmitter();c.signals=[];c.kill=(s)=>{c.signals.push(s);queueMicrotask(()=>c.emit("exit",null,s));return true};workers.push(c);return c};
      syncBuiltinESMExports();
      process.env.RECENT_ENABLED="1";
      await import(${JSON.stringify(service)});
      workers[0].emit("exit",${childCode},null);
      await new Promise(resolve=>setImmediate(resolve));
      console.log(JSON.stringify({workerCount:workers.length,exitCode:process.exitCode,signals:workers.map(c=>c.signals)}));
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, childCode === 75 ? 0 : 1);
    const lines = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const final = lines.at(-1);
    assert.equal(final.workerCount, 3);
    assert.deepEqual(final.signals, [[], ["SIGTERM"], ["SIGTERM"]]);
    assert.equal(
      lines.filter((line) => line.event === "service_paused_rpc_rate_limit")
        .length,
      childCode === 75 ? 1 : 0,
    );
  }
});
