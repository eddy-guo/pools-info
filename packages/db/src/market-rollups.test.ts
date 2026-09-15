import assert from "node:assert/strict";
import test from "node:test";
import { rebuildBroadMarket } from "./index";
import { broadExploreCut } from "../../../apps/api/src/broad-explore";
import {
  marketDatabase,
  marketFirst as first,
} from "../../../tests/support/broad-market-db";

test(
  "historical market rebuild cannot skip a gap or partially commit a bounded group",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const fixture = await marketDatabase(),
      { db } = fixture;
    t.after(() => fixture.close());
    const cut = () => broadExploreCut((sql, values) => db.query(sql, values));
    await assert.rejects(
      rebuildBroadMarket(db, 101),
      /Invalid market rebuild limit/,
    );
    await db.query("SELECT project_broad_market($1)", [first + 21000]);
    assert.equal(await cut(), null); // A completed newer suffix is not a historical cursor.
    await db.query(
      `CREATE FUNCTION fail_rebuild_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.batch_end=${first + 17999} THEN RAISE EXCEPTION 'rebuild interrupted'; END IF; RETURN NEW; END; $$`,
    );
    await db.query(
      "CREATE TRIGGER fail_rebuild_marker BEFORE INSERT ON broad_market_batches FOR EACH ROW EXECUTE FUNCTION fail_rebuild_marker()",
    );
    await assert.rejects(rebuildBroadMarket(db, 2), /rebuild interrupted/);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::integer AS count FROM broad_market_batches",
        )
      ).rows[0].count,
      1,
    );
    assert.equal(await cut(), null);
    await db.query("DROP TRIGGER fail_rebuild_marker ON broad_market_batches");
    assert.deepEqual(await rebuildBroadMarket(db, 1), {
      rebuilt: 1,
      remaining: 1,
    });
    assert.equal((await cut())?.block, first + 8999);
    assert.deepEqual(await rebuildBroadMarket(db, 1), {
      rebuilt: 1,
      remaining: 0,
    });
    assert.equal((await cut())?.block, first + 21000);
    const expected = (
      await db.query(
        "SELECT * FROM broad_market_summaries ORDER BY batch_end,pool_id",
      )
    ).rows;
    const evidence = (
      await db.query(
        "SELECT serialized_group FROM broad_batches ORDER BY batch_end",
      )
    ).rows;
    await db.query("DELETE FROM broad_market_batches");
    assert.equal(await cut(), null);
    assert.deepEqual(await rebuildBroadMarket(db, 100), {
      rebuilt: 3,
      remaining: 0,
    });
    assert.deepEqual(
      (
        await db.query(
          "SELECT * FROM broad_market_summaries ORDER BY batch_end,pool_id",
        )
      ).rows,
      expected,
    );
    assert.deepEqual(
      (
        await db.query(
          "SELECT serialized_group FROM broad_batches ORDER BY batch_end",
        )
      ).rows,
      evidence,
    );
    assert.deepEqual(await rebuildBroadMarket(db, 10), {
      rebuilt: 0,
      remaining: 0,
    });
  },
);
