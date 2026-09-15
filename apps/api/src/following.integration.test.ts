import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createClient,
  migrate,
  ensureDiscovery,
  commitBatch,
  getStream,
  rewind,
} from "../../../packages/db/src/index";
import type { FollowingActivityResponse } from "@pools/core";
import { readData } from "./reader";
import { parseRequest } from "./request";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
test(
  "following SQL uses verified attribution, exact amounts, bounded ordering and canonical source removal",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = `following_${randomUUID().replaceAll("-", "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    t.after(async () => {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    await migrate(db);
    const pool = {
      id: word(1),
      token: address(1),
      name: "Pool",
      symbol: "TEST",
      launchBlock: 10,
      launchTx: word(2),
      launchSender: address(2),
      launchedAt: 100,
    };
    const discovery = await ensureDiscovery(db, 10);
    await commitBatch(db, discovery, {
      from: 10,
      to: 199,
      hash: word(199),
      evidence: {},
      pools: [pool],
    });
    const market = { ...pool, decimals: 6 };
    const snapshot = {
      schemaVersion: 1,
      chainId: 4663,
      toBlock: 199,
      blockHash: word(199),
      toTimestamp: 1000,
      markets: [market],
    };
    await db.query(
      "INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,generated_at,snapshot,source_kind,source_stream,source_batch) VALUES(4663,$1,199,$2,1000,'2026-09-15T00:00:00Z',$3,'indexed','discovery:v1',199)",
      [pool.id, word(199), JSON.stringify(snapshot)],
    );
    await db.query(
      "INSERT INTO analytics_accounting_pools(chain_id,pool_id,projection_version,through_block,through_hash,from_block,from_timestamp,asof_timestamp,generated_at,source_kind,market) VALUES(4663,$1,1,199,$2,10,100,1000,'2026-09-15T00:00:00Z','indexed',$3)",
      [pool.id, word(199), JSON.stringify(market)],
    );
    for (const n of [11, 12, 13])
      await db.query(
        "INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags,quantity_raw,cost_wei,invested_wei,proceeds_wei,realized_wei,buys,sells) VALUES(4663,$1,$2,true,'{}',100,100,100,0,0,1,0)",
        [pool.id, address(n)],
      );
    await db.query(
      "INSERT INTO analytics_accounting_positions(chain_id,pool_id,wallet,supported,flags) VALUES(4663,$1,$2,false,'{unknown_basis}')",
      [pool.id, address(14)],
    );
    const exact = "900719925474099300001";
    async function trade(n: number, wallet: string | null, supported = true) {
      await db.query(
        "INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported) VALUES(4663,$1,$2,$3,$4,$5,'buy',$6,3000000,$7,$8,$9)",
        [
          pool.id,
          word(1000 + n),
          n,
          20 + n,
          200 + n,
          exact,
          wallet,
          wallet
            ? JSON.stringify({
                trade: { trader: wallet, txHash: word(1000 + n) },
                flags: supported ? [] : ["unmatched_transfer"],
              })
            : null,
          supported,
        ],
      );
    }
    for (let n = 0; n < 55; n++) await trade(n, address(n % 2 ? 11 : 12));
    await trade(56, address(11));
    await trade(57, address(12));
    // Equal timestamps/blocks/log indexes still have deterministic hash order.
    await db.query(
      "UPDATE analytics_accounting_trades SET timestamp=254,block_number=74,log_index=56 WHERE transaction_hash=ANY($1::text[])",
      [[word(1056), word(1057)]],
    );
    await trade(60, address(13)); // verified but not followed
    await trade(61, address(14)); // attributed, but position has unknown basis
    await trade(62, address(11), false); // followed wallet, failed execution audit
    await trade(63, null, false); // initiator-only swap: no proven beneficiary
    await db.query(
      "INSERT INTO indexed_events(chain_id,stream_key,batch_end,tx_hash,log_index,block_number,block_hash,timestamp,kind,pool_id,token,transaction_sender,payload) VALUES(4663,'discovery:v1',199,$1,63,83,$2,263,'swap',$3,$4,$5,'{}')",
      [word(1063), word(83), pool.id, pool.token, address(11)],
    );
    let calls = 0;
    const query = async (sql: string, values?: unknown[]) => {
      calls++;
      return db.query(sql, values);
    };
    const read = async (suffix = "") =>
      readData(
        query,
        parseRequest(
          `/v1/following?wallets=${address(11)},${address(12)},${address(14)}${suffix}`,
        ),
      ) as Promise<FollowingActivityResponse>;
    let response = await read("&limit=3");
    assert.equal(calls, 1);
    assert.equal(response.hasMore, true);
    assert.equal(response.items.length, 3);
    assert.deepEqual(
      response.items.map((row) => row.txHash),
      [word(1057), word(1056), word(1054)],
    );
    assert.equal(response.items[0].ethWei, exact);
    assert.equal(response.items[0].tokenRaw, "3000000");
    assert.equal(response.items[0].priceWei, (BigInt(exact) / 3n).toString());
    assert.ok(
      response.items.every(
        (row) =>
          row.supported && [address(11), address(12)].includes(row.wallet),
      ),
    );
    assert.equal(response.coverage.asOf, 1000);
    assert.equal(response.coverage.oldestAsOf, 1000);
    assert.equal(response.coverage.complete, false);
    response = await read();
    assert.equal(response.items.length, 50);
    assert.equal(response.hasMore, true);
    assert.equal(new Set(response.items.map((row) => row.id)).size, 50);
    // A projection that no longer matches its publication is never presented as verified.
    await db.query(
      "UPDATE analytics_pool_snapshots SET generated_at=generated_at+interval '1 second'",
    );
    assert.equal((await read()).items.length, 0);
    await db.query(
      "UPDATE analytics_pool_snapshots SET generated_at=generated_at-interval '1 second'",
    );
    assert.equal((await read("&limit=1")).items.length, 1);
    // Removing the canonical launch batch cascades snapshots, positions and trades.
    await rewind(db, await getStream(db, "discovery:v1"), null);
    response = await read();
    assert.deepEqual(response.items, []);
    assert.equal(response.hasMore, false);
    assert.equal(response.coverage.asOf, null);
  },
);
