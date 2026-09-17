import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import pg from "pg";
import sharp from "sharp";
import { TokenImageError } from "@pools/token-image";
import { createReader } from "./reader";
import { applyTestMigrations } from "./test-migrations";
import { parseRequest } from "./request";
import { createApi } from "./server";
import {
  createTokenImageService,
  createTokenImageStore,
  defaultTokenImageSettings,
} from "./token-image-store";

const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");

test(
  "Postgres token image store: first view encodes and stores, later views serve bytes, ETag, negative cache, re-encode and single flight",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const schema = "api_test_images_" + randomBytes(8).toString("hex");
    const db = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await applyTestMigrations(db);
    const reader = createReader(process.env.TEST_DATABASE_URL, schema);
    const store = createTokenImageStore(process.env.TEST_DATABASE_URL, schema);
    let clock = Date.parse("2026-09-16T02:17:00Z");
    const encodes: { source: string; signal: AbortSignal }[] = [];
    let fail: TokenImageError | null = null;
    const images = createTokenImageService(store, {
      now: () => clock,
      settings: { ...defaultTokenImageSettings, concurrency: 2 },
      transform: async (source, signal) => {
        encodes.push({ source, signal });
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (fail) throw fail;
        // Real WebP bytes, so the row satisfies the same limits production writes.
        return sharp({
          create: {
            width: 128,
            height: 128,
            channels: 3,
            background: source.endsWith("two.png") ? "blue" : "red",
          },
        })
          .webp({ quality: 80 })
          .toBuffer();
      },
    });
    const server = createApi(reader, { images });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([reader.close(), images.close()]);
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    });
    const port = (server.address() as { port: number }).port;
    const get = (pool: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${port}/v1/pools/${pool}/image`, init);
    const row = async (pool: string) =>
      (
        await db.query(
          "SELECT source_url,webp,content_hash,byte_size,encoded_at,rejection,attempts,retry_after FROM token_images WHERE pool_id=$1",
          [pool],
        )
      ).rows[0];

    await db.query(
      "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block,cursor_block,cursor_hash) VALUES(4663,'discovery:v1','discovery',1,99,$1)",
      [word(99)],
    );
    await db.query(
      "INSERT INTO indexer_batches VALUES(4663,'discovery:v1',1,99,$1,'test','{}')",
      [word(99)],
    );
    for (const [id, image] of [
      [1, "https://pools.trade/one.png"],
      [2, "https://not-on-the-allowlist.example/two.png"],
      [3, null],
    ] as const)
      await db.query(
        `INSERT INTO indexed_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,
          launch_sender,launched_at,source_stream,source_batch,image_url)
        VALUES(4663,$1,$2,'Token','T',99,$3,$4,1000,'discovery:v1',99,$5)`,
        [word(id), address(id), word(id + 10), address(90), image],
      );
    // A recent-only launch is part of the blended catalog too.
    await db.query(
      "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',100)",
    );
    await db.query(
      `INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence)
      VALUES(4663,'discovery',100,199,$1,1000,'checksum','{}')`,
      [word(199)],
    );
    await db.query(
      `INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch,image_url)
      VALUES(4663,$1,$2,'Recent','R',150,$3,$4,1000,199,'https://pools.trade/recent.png')`,
      [word(4), address(4), word(14), address(90)],
    );

    await t.test("readiness requires the image table", async () => {
      assert.deepEqual(await reader.read(parseRequest("/ready")), {
        ready: true,
      });
      await db.query("ALTER TABLE token_images RENAME TO token_images_gone");
      await assert.rejects(reader.read(parseRequest("/ready")));
      await db.query("ALTER TABLE token_images_gone RENAME TO token_images");
    });

    await t.test(
      "a burst of first views encodes once and every later view is served from the store",
      async () => {
        const burst = await Promise.all(
          Array.from({ length: 8 }, () => get(word(1))),
        );
        assert.equal(encodes.length, 1);
        assert.equal(encodes[0].source, "https://pools.trade/one.png");
        const bodies = await Promise.all(
          burst.map(async (r) => ({
            status: r.status,
            etag: r.headers.get("etag"),
            bytes: Buffer.from(await r.arrayBuffer()),
          })),
        );
        assert.ok(bodies.every((b) => b.status === 200));
        const stored = await row(word(1));
        assert.equal(stored.byte_size, bodies[0].bytes.length);
        assert.deepEqual(stored.webp, bodies[0].bytes);
        assert.equal(
          stored.content_hash,
          createHash("sha256").update(bodies[0].bytes).digest("hex"),
        );
        assert.ok(bodies.every((b) => b.etag === `"${stored.content_hash}"`));
        assert.equal(stored.rejection, null);
        assert.equal(stored.retry_after, null);
        assert.equal(stored.encoded_at.getTime(), clock);
        assert.equal((await sharp(stored.webp).metadata()).format, "webp");
        const again = await get(word(1));
        assert.equal(again.status, 200);
        assert.equal(
          again.headers.get("cache-control"),
          "public, max-age=86400, s-maxage=2592000, stale-while-revalidate=604800",
        );
        assert.deepEqual(Buffer.from(await again.arrayBuffer()), stored.webp);
        const revalidated = await get(word(1), {
          headers: { "If-None-Match": `"${stored.content_hash}"` },
        });
        assert.equal(revalidated.status, 304);
        assert.equal(await revalidated.text(), "");
        const head = await get(word(1), { method: "HEAD" });
        assert.equal(head.status, 200);
        assert.equal(
          head.headers.get("content-length"),
          String(stored.byte_size),
        );
        assert.equal(
          encodes.length,
          1,
          "served from the store, not re-encoded",
        );
        const recent = await get(word(4));
        assert.equal(recent.status, 200);
        assert.equal(encodes.length, 2);
      },
    );

    await t.test(
      "rejections keep a reason and retry time; policy rejections never fetch",
      async () => {
        const rejected = await get(word(2));
        assert.equal(rejected.status, 404);
        assert.deepEqual(await rejected.json(), {
          error: "image_unavailable",
          reason: "source_rejected",
        });
        assert.equal(
          rejected.headers.get("cache-control"),
          "public, max-age=86400, s-maxage=86400",
        );
        const stored = await row(word(2));
        assert.equal(stored.webp, null);
        assert.equal(stored.rejection, "source_rejected");
        assert.equal(stored.retry_after.getTime(), clock + 86400_000);
        assert.equal(encodes.length, 2);
        const none = await get(word(3));
        assert.equal(none.status, 404);
        assert.deepEqual(await none.json(), {
          error: "image_unavailable",
          reason: "no_source",
        });
        assert.equal(await row(word(3)), undefined);
        const unknown = await get(word(5));
        assert.equal(unknown.status, 404);
        assert.deepEqual(await unknown.json(), { error: "pool_not_indexed" });
      },
    );

    await t.test(
      "a changed catalog image_url re-encodes; transient failures back off until retry_after",
      async () => {
        await db.query(
          "UPDATE indexed_pools SET image_url='https://pools.trade/two.png' WHERE pool_id=$1",
          [word(1)],
        );
        const before = await row(word(1));
        const changed = await get(word(1));
        assert.equal(changed.status, 200);
        assert.equal(encodes.length, 3);
        assert.equal(encodes[2].source, "https://pools.trade/two.png");
        const after = await row(word(1));
        assert.equal(after.source_url, "https://pools.trade/two.png");
        assert.notEqual(after.content_hash, before.content_hash);
        assert.equal(changed.headers.get("etag"), `"${after.content_hash}"`);

        await db.query(
          "UPDATE indexed_pools SET image_url='https://pools.trade/three.png' WHERE pool_id=$1",
          [word(1)],
        );
        fail = new TokenImageError("fetch_rejected");
        const failed = await get(word(1));
        assert.equal(failed.status, 404);
        assert.equal(
          failed.headers.get("cache-control"),
          "public, max-age=300, s-maxage=300",
        );
        assert.deepEqual(await failed.json(), {
          error: "image_unavailable",
          reason: "fetch_rejected",
        });
        let stored = await row(word(1));
        assert.equal(stored.source_url, "https://pools.trade/three.png");
        assert.equal(stored.webp, null);
        assert.equal(stored.attempts, 1);
        assert.equal(stored.retry_after.getTime(), clock + 300_000);
        clock += 120_000;
        const cached = await get(word(1));
        assert.equal(cached.status, 404);
        assert.equal(
          cached.headers.get("cache-control"),
          "public, max-age=180, s-maxage=180",
        );
        assert.equal(encodes.length, 4, "not due: no fetch");
        clock += 180_000;
        const retried = await get(word(1));
        assert.equal(retried.status, 404);
        assert.equal(
          retried.headers.get("cache-control"),
          "public, max-age=600, s-maxage=600",
        );
        stored = await row(word(1));
        assert.equal(stored.attempts, 2);
        assert.equal(encodes.length, 5);
        fail = null;
        clock += 600_000;
        const healed = await get(word(1));
        assert.equal(healed.status, 200);
        stored = await row(word(1));
        assert.equal(stored.rejection, null);
        assert.ok(stored.webp.length > 0);
        assert.equal(encodes.length, 6);
      },
    );

    await t.test(
      "the table only accepts a complete image or a complete rejection",
      async () => {
        for (const values of [
          // bytes with a rejection
          [Buffer.from("x"), "a".repeat(64), 1, "timeout", new Date()],
          // rejection without a retry time
          [null, null, null, "timeout", null],
          // bytes without a hash
          [Buffer.from("x"), null, 1, null, null],
        ])
          await assert.rejects(
            db.query(
              `INSERT INTO token_images(chain_id,pool_id,source_url,webp,content_hash,byte_size,encoded_at,rejection,attempts,retry_after)
            VALUES(4663,$1,'https://pools.trade/x.png',$2,$3,$4,now(),$5,1,$6)`,
              [word(9), ...values],
            ),
            /check constraint/,
          );
      },
    );
  },
);
