import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual main gives discovery catch-up priority and resumes deep work after catch-up or disable", () => {
  for (const state of [
    "behind",
    "caught-up",
    "disabled",
    "failed",
    "catchup-run",
  ] as const) {
    const script = `
      import {createClient} from "./packages/db/src/index.ts";
      import {DiscoveryScheduler} from "./apps/indexer/src/discovery-worker.ts";
      const state=${JSON.stringify(state)};
      process.env.DATABASE_URL="postgresql://test@127.0.0.1/test";
      process.env.ROBINHOOD_RPC_URL="http://127.0.0.1:1/private_key";
      delete process.env.INDEXER_LOG_RPC_URL;
      delete process.env.INDEXER_BROAD_V1_ENABLED;
      process.env.INDEXER_DISCOVERY_V2_ENABLED=state==="disabled"?"0":"1";
      process.env.INDEXER_DISCOVERY_BATCH_BLOCKS="10000";
      process.env.INDEXER_LOG_RANGE_BLOCKS="1000";
      process.env.RPC_MIN_INTERVAL_MS="250";
      process.env.RPC_MAX_BATCH_SIZE="10";
      const proto=Object.getPrototypeOf(createClient());
      proto.connect=async()=>{};
      proto.query=async(sql)=>{
        if(sql.includes("pg_try_advisory_lock"))return {rows:[{acquired:true}]};
        if(sql.includes("WITH seed AS")){
          console.log(JSON.stringify({event:"deep_selection"}));
          if(state==="catchup-run")process.emit("SIGTERM");
        }
        return {rows:[]};
      };
      proto.end=async()=>console.log(JSON.stringify({event:"db_closed"}));
      let cycles=0;
      DiscoveryScheduler.prototype.run=async function(){
        cycles++;
        console.log(JSON.stringify({event:"discovery_attempt",cycles}));
        if(!this.enabled)return null;
        if(state==="failed")throw Error("test_discovery_failure");
        return {advanced:10000,behind:state==="behind"||(state==="catchup-run"&&cycles===1),from:22754669,to:22764668,pools:0,poolsWithImages:0,httpRequests:5,rpcCalls:14};
      };
      globalThis.fetch=async()=>{throw Error("Unexpected external request")};
      process.argv[2]=state==="catchup-run"?"run":"once";
      await import("./apps/indexer/src/main.ts");
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
    assert.equal(result.status, state === "failed" ? 1 : 0, result.stderr);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.filter((e) => e.event === "deep_selection").length,
      state === "caught-up" || state === "disabled" || state === "catchup-run"
        ? 1
        : 0,
      state,
    );
    assert.equal(
      events.filter((e) => e.event === "discovery_attempt").length,
      state === "catchup-run" ? 2 : 1,
    );
    assert.equal(events.filter((e) => e.event === "db_closed").length, 1);
    const config = events.find((e) => e.event === "worker_rpc_configuration");
    assert.equal(config.logRangeBlocks, 1000);
    assert.equal(config.maxBatchSize, 10);
    assert.equal(config.minIntervalMs, 250);
    assert.doesNotMatch(result.stdout + result.stderr, /private_key/);
  }
});
