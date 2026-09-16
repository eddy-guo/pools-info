import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("actual main preserves discovery priority, bounds broad catch-up and stops capacity/throttle failures", () => {
  for (const state of [
    "discovery-behind",
    "discovery-failed",
    "discovery-disabled",
    "broad-behind",
    "broad-failed",
    "broad-capacity",
    "broad-throttled",
    "broad-caught-up",
    "broad-catchup-run",
    "broad-split-run",
  ]) {
    const script = `
      import {createClient} from "./packages/db/src/index.ts";
      import {DiscoveryScheduler} from "./apps/indexer/src/discovery-worker.ts";
      import {BroadScheduler} from "./apps/indexer/src/broad-worker.ts";
      import {BroadSingleBlockOverflow} from "./apps/indexer/src/broad-budget.ts";
      import {RpcRateLimitExhausted} from "./packages/chain/src/index.ts";
      const state=${JSON.stringify(state)};
      process.env.DATABASE_URL="postgresql://test@127.0.0.1/test";
      process.env.ROBINHOOD_RPC_URL="http://127.0.0.1:1/private_key";
      delete process.env.INDEXER_LOG_RPC_URL;
      process.env.INDEXER_DISCOVERY_V2_ENABLED=state==="discovery-disabled"?"0":"1";
      process.env.INDEXER_DISCOVERY_BATCH_BLOCKS="10000";
      process.env.INDEXER_BROAD_V1_ENABLED="1";
      process.env.INDEXER_BROAD_BATCH_BLOCKS="1000";
      process.env.INDEXER_LOG_RANGE_BLOCKS="10000";
      process.env.RPC_MIN_INTERVAL_MS="250";
      process.env.RPC_MAX_BATCH_SIZE="10";
      let locked=false,cycles=0;
      const proto=Object.getPrototypeOf(createClient());
      proto.connect=async()=>{};
      proto.query=async(sql)=>{
        if(sql.includes("pg_try_advisory_lock")){locked=true;return {rows:[{acquired:true}]};}
        if(sql.includes("seed AS (")){
          console.log(JSON.stringify({event:"deep_selection"}));
          if(state==="broad-catchup-run"||state==="broad-split-run")process.emit("SIGTERM");
        }
        return {rows:[]};
      };
      proto.end=async()=>console.log(JSON.stringify({event:"db_closed"}));
      DiscoveryScheduler.prototype.run=async function(){
        cycles++;console.log(JSON.stringify({event:"discovery_attempt",cycles}));
        if(!locked)throw Error("discovery ran before lock");
        if(!this.enabled)return null;
        if(state==="discovery-failed")throw Error("discovery failure");
        return {advanced:state==="discovery-behind"?10000:0,behind:state==="discovery-behind",from:22754669,to:22764668,pools:0,poolsWithImages:0,httpRequests:0,rpcCalls:0};
      };
      BroadScheduler.prototype.run=async function(db,createRpc){
        if(!locked)throw Error("broad ran before lock");
        const rpc=createRpc();
        console.log(JSON.stringify({event:"broad_attempt",cycles,logRange:rpc.logRange,metered:!!rpc.methodCounts,timeoutMs:rpc.limits.timeoutMs,maxRequests:rpc.limits.maxRequests}));
        if(state==="broad-failed")throw Error("broad failure");
        if(state==="broad-capacity")throw new BroadSingleBlockOverflow(22754669);
        if(state==="broad-throttled")throw new RpcRateLimitExhausted();
        if(state==="broad-split-run"&&cycles===1)return {deferred:true,advanced:0,behind:true,from:null,to:null};
        return {advanced:3,behind:state==="broad-behind"||(state==="broad-catchup-run"&&cycles===1),from:22754669,to:22754671};
      };
      globalThis.fetch=async()=>{throw Error("Unexpected external request");};
      process.argv[2]=state==="broad-catchup-run"||state==="broad-split-run"?"run":"once";
      await import("./apps/indexer/src/main.ts");
    `;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        encoding: "utf8",
        // Bounds a hung child only; a loaded host spawns tsx in several seconds.
        timeout: 60000,
      },
    );
    assert.equal(result.error, undefined, state);
    const expectedExit =
      state === "broad-capacity"
        ? 76
        : state === "broad-throttled"
          ? 75
          : state.endsWith("failed")
            ? 1
            : 0;
    assert.equal(result.status, expectedExit, `${state}: ${result.stderr}`);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s));
    const broad = events.filter((e) => e.event === "broad_attempt");
    assert.equal(
      broad.length,
      state.startsWith("discovery-")
        ? 0
        : state === "broad-catchup-run" || state === "broad-split-run"
          ? 2
          : 1,
      state,
    );
    assert.ok(
      broad.every(
        (e) =>
          e.logRange === 1000 &&
          e.metered &&
          e.timeoutMs === 30000 &&
          e.maxRequests === 100,
      ),
    );
    assert.equal(
      events.filter((e) => e.event === "deep_selection").length,
      [
        "discovery-disabled",
        "broad-caught-up",
        "broad-catchup-run",
        "broad-split-run",
      ].includes(state)
        ? 1
        : 0,
      state,
    );
    assert.equal(events.filter((e) => e.event === "db_closed").length, 1);
    if (state === "broad-catchup-run" || state === "broad-split-run")
      assert.deepEqual(
        events
          .filter((e) =>
            ["discovery_attempt", "broad_attempt", "deep_selection"].includes(
              e.event,
            ),
          )
          .map((e) => e.event),
        [
          "discovery_attempt",
          "broad_attempt",
          "discovery_attempt",
          "broad_attempt",
          "deep_selection",
        ],
      );
    assert.doesNotMatch(result.stdout + result.stderr, /private_key/);
  }
});
