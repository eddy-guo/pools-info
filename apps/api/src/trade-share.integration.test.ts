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
import type { TradeShareResponse } from "@pools/core";
import { readData } from "./reader";
import { parseRequest } from "./request";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
test(
  "trade share SQL uses verified attribution, exact amounts and canonical source removal",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = `trade_share_${randomUUID().replaceAll("-", "")}`;
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
    await trade(61, address(14)); // attributed, but position has unknown basis
    await trade(62, address(11), false); // attributed wallet, failed execution audit
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
    // A share card reads the stored realization by event, independently of the
    // bounded profile trade list. Both profit and loss stay exact.
    const cost = "1801439850948198600004";
    await trade(70, address(11));
    await trade(71, address(12));
    await db.query(
      "UPDATE analytics_accounting_trades SET side='sell',disposed_cost_wei=$1,realized_wei=eth_wei-$1::numeric WHERE transaction_hash=ANY($2::text[])",
      [cost, [word(1070), word(1071)]],
    );
    await db.query(
      "UPDATE analytics_accounting_trades SET disposed_cost_wei=0,realized_wei=eth_wei WHERE transaction_hash=$1",
      [word(1071)],
    );
    // Populate more than the profile's 500-row display cap with newer activity.
    // The older sale must still be individually shareable by its exact key.
    await db.query(
      `INSERT INTO analytics_accounting_trades(chain_id,pool_id,transaction_hash,log_index,block_number,timestamp,side,eth_wei,token_raw,wallet,execution,execution_supported)
       SELECT 4663,$1,'0x'||lpad(to_hex(4000+n),64,'0'),10000+n,110,300,'buy',1,1,$2,
         jsonb_build_object('trade',jsonb_build_object('trader',$2::text),'flags','[]'::jsonb),true
       FROM generate_series(1,501) AS n`,
      [pool.id, address(11)],
    );
    const share = (n: number, wallet = address(11)) =>
      readData(
        query,
        parseRequest(
          `/v1/trades/${pool.id}/${word(1000 + n)}/${n}?wallet=${wallet}`,
        ),
      ) as Promise<TradeShareResponse>;
    const priorCalls = calls;
    const sale = await share(70);
    assert.equal(calls, priorCalls + 1);
    assert.equal(sale.trade.wallet, address(11));
    assert.equal(sale.trade.ethWei, exact);
    assert.equal(sale.trade.disposedCostWei, cost);
    assert.equal(
      sale.trade.realizedWei,
      (BigInt(exact) - BigInt(cost)).toString(),
    );
    assert.equal(sale.trade.asOf, 1000);
    assert.equal(sale.trade.throughBlock, 199);
    assert.equal(sale.scope, "saved_verified_sale");
    assert.equal(sale.coverage.complete, false);
    assert.equal((await share(71, address(12))).trade.realizedWei, exact);
    assert.equal((await share(71, address(12))).trade.disposedCostWei, "0");
    const unavailable = { status: 404, code: "trade_share_unavailable" };
    await assert.rejects(share(70, address(12)), unavailable); // wrong beneficiary
    await assert.rejects(share(71), unavailable); // another wallet's sale
    await assert.rejects(share(0, address(12)), unavailable); // purchase, not realization
    await assert.rejects(share(61, address(14)), unavailable); // unsupported position
    await assert.rejects(share(62), unavailable); // unsupported execution
    await assert.rejects(share(63), unavailable); // transaction sender is not beneficiary
    await assert.rejects(share(99), unavailable); // absent event
    // Position and execution qualification remain required even for a stored sale.
    await db.query(
      "UPDATE analytics_accounting_positions SET supported=false,flags='{unknown_basis}',quantity_raw=NULL,cost_wei=NULL,invested_wei=NULL,proceeds_wei=NULL,realized_wei=NULL,unrealized_wei=NULL,buys=NULL,sells=NULL WHERE wallet=$1",
      [address(11)],
    );
    await assert.rejects(share(70), unavailable);
    await db.query(
      "UPDATE analytics_accounting_positions SET supported=true,flags='{}',quantity_raw=100,cost_wei=100,invested_wei=100,proceeds_wei=0,realized_wei=0,buys=1,sells=0 WHERE wallet=$1",
      [address(11)],
    );
    await db.query(
      "UPDATE analytics_accounting_trades SET execution_supported=false WHERE transaction_hash=$1",
      [word(1070)],
    );
    await assert.rejects(share(70), unavailable);
    await db.query(
      "UPDATE analytics_accounting_trades SET execution_supported=true WHERE transaction_hash=$1",
      [word(1070)],
    );
    await db.query("UPDATE indexed_pools SET token=$1 WHERE pool_id=$2", [
      address(99),
      pool.id,
    ]);
    await assert.rejects(share(70), unavailable);
    await db.query("UPDATE indexed_pools SET token=$1 WHERE pool_id=$2", [
      pool.token,
      pool.id,
    ]);
    // A projection that no longer matches its publication is never presented as verified.
    await db.query(
      "UPDATE analytics_pool_snapshots SET generated_at=generated_at+interval '1 second'",
    );
    await assert.rejects(share(70), unavailable);
    await db.query(
      "UPDATE analytics_pool_snapshots SET generated_at=generated_at-interval '1 second'",
    );
    assert.equal((await share(70)).trade.realizedWei, sale.trade.realizedWei);
    // Removing the canonical launch batch cascades snapshots, positions and trades.
    await rewind(db, await getStream(db, "discovery:v1"), null);
    await assert.rejects(share(70), unavailable);
  },
);
