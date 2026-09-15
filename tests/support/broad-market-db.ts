import { randomUUID } from "node:crypto";
import {
  createClient,
  migrate,
  type Client,
} from "../../packages/db/src/index";
export const marketFirst = 22754669;
export const marketWord = (n: number) =>
  "0x" + n.toString(16).padStart(64, "0");
export const marketAddress = (n: number) =>
  "0x" + n.toString(16).padStart(40, "0");
export const marketAmount = "900719925474099300003";
/** Local canonical database fixture, not a live chain claim or HTTP stub. */
export async function marketDatabase() {
  if (!process.env.TEST_DATABASE_URL) throw Error("TEST_DATABASE_URL required");
  const db = createClient(process.env.TEST_DATABASE_URL);
  await db.connect();
  const schema = "api_test_market_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  await migrate(db);
  const f = marketFirst,
    end = f + 29999;
  await db.query(
    `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash)
    VALUES(4663,'discovery:v2','discovery',$1,$2,$3)`,
    [f, end, marketWord(end)],
  );
  await db.query(
    `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
    VALUES(4663,'discovery:v2',$1,$2,$3,$4,'{}')`,
    [f, end, marketWord(end), "a".repeat(64)],
  );
  for (let i = 1; i <= 31; i++)
    await db.query(
      `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_stream,source_batch)
    VALUES(4663,$1,$2,$3,$4,$5,$6,$7,100000,'discovery:v2',$8)`,
      [
        marketWord(i),
        marketAddress(i),
        i === 1 ? "Canonical market" : `Launch ${i}`,
        `M${i}`,
        i === 31 ? end : f,
        marketWord(100 + i),
        marketAddress(99),
        end,
      ],
    );
  await db.query(
    `INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,registry_revision,registry_source_revision)
    VALUES(4663,'swaps:broad:v1','broad',$1,'robinhood-instant-v2','2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f')`,
    [f],
  );
  for (const [lo, hi] of [
    [0, 8999],
    [9000, 17999],
    [18000, 21000],
  ]) {
    const to = f + hi,
      time = hi === 21000 ? 200000 : 113600 + hi;
    await db.query(
      `INSERT INTO indexer_batches(chain_id,stream_key,from_block,to_block,block_hash,content_hash,evidence)
      VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,'{}')`,
      [f + lo, to, marketWord(to), "b".repeat(64)],
    );
    await db.query(
      `INSERT INTO broad_batches VALUES(4663,'swaps:broad:v1',$1,$2,$3,$4,'discovery:v2',$5,$6,$7,1,'{}',$8,0,0)`,
      [
        to,
        f + lo,
        marketWord(f + lo - 1),
        time,
        end,
        marketWord(end),
        "a".repeat(64),
        hi - lo + 1,
      ],
    );
    await db.query(
      `INSERT INTO broad_registry_members VALUES(4663,'swaps:broad:v1',$1,$2,'{}')`,
      [to, marketWord(1)],
    );
    await db.query(
      `INSERT INTO broad_swaps
      SELECT 4663,'swaps:broad:v1',$1,$2,$3,'0x'||lpad(to_hex(i+1000),64,'0'),0,$4+i,'0x'||lpad(to_hex($4+i),64,'0'),
        CASE WHEN i=0 THEN 113599 WHEN i=21000 THEN 200000 ELSE 113600+i END,$5,$5,-$6::numeric,10,
        CASE WHEN i=21000 THEN 39614081257132168796771975168::numeric ELSE 79228162514264337593543950336::numeric END,
        100,0,2500,'buy',$6::numeric,10,false,ARRAY['missing_transfer_history'] FROM generate_series($7::integer,$8::integer)i`,
      [
        to,
        marketWord(1),
        marketAddress(1),
        f,
        marketAddress(99),
        marketAmount,
        lo,
        hi,
      ],
    );
  }
  await db.query(
    `UPDATE indexer_streams SET cursor_block=$1,cursor_hash=$2 WHERE stream_key='swaps:broad:v1'`,
    [f + 21000, marketWord(f + 21000)],
  );
  return {
    db,
    schema,
    async close() {
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    },
  };
}
export async function marketUnits(
  db: Client,
  decimals = 18,
  batchEnd = marketFirst + 21000,
  token = marketAddress(1),
) {
  const time = (
    await db.query("SELECT timestamp FROM broad_batches WHERE batch_end=$1", [
      batchEnd,
    ])
  ).rows[0].timestamp;
  await db.query(
    `INSERT INTO broad_token_units VALUES(4663,'swaps:broad:v1',$1,$2,$1,$3,$4,$5,100,$6,$7)`,
    [
      batchEnd,
      token,
      marketWord(batchEnd),
      time,
      decimals,
      "0x" + decimals.toString(16).padStart(64, "0"),
      "0x" + "64".padStart(64, "0"),
    ],
  );
}
