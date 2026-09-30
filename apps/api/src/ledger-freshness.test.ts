import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createApi } from "./server";
import { createReader } from "./reader";
import {
  ledgerFreshness,
  ledgerFreshnessDefaults,
  ledgerStaleSetting,
} from "./ledger-freshness";

// node-postgres hands the stream row back with bigint columns as strings
// and timestamptz columns as Dates; age_seconds is the database's own
// clock against updated_at, cast to text.
const row = (age: number, head: string | null = "75736543") => ({
  cursor_block: "75736415",
  cursor_timestamp: "1790693005",
  head_block: head,
  head_timestamp: head === null ? null : "1790693018",
  checked_at: new Date("2026-09-29T14:43:25.881Z"),
  updated_at: new Date("2026-09-29T14:43:08.068Z"),
  age_seconds: String(age),
});

test("the stream row becomes the freshness object: numbers for chain figures, ISO times, lag against the head, stale strictly past the threshold", () => {
  assert.deepEqual(ledgerFreshness(row(17), 600000), {
    cursorBlock: 75736415,
    cursorTimestamp: 1790693005,
    headBlock: 75736543,
    headTimestamp: 1790693018,
    lagBlocks: 128,
    lagSeconds: 13,
    indexedAt: "2026-09-29T14:43:08.068Z",
    checkedAt: "2026-09-29T14:43:25.881Z",
    ageSeconds: 17,
    staleAfterSeconds: 600,
    stale: false,
  });
  assert.equal(ledgerFreshness(row(600), 600000)!.stale, false);
  assert.equal(ledgerFreshness(row(601), 600000)!.stale, true);
  assert.equal(ledgerFreshness(row(601), 660000)!.stale, false);
  // Before the collector's first head observation the lag is unknown, not
  // zero; a head below the cursor (a lagging archive) reads as no lag.
  const unobserved = ledgerFreshness(
    { ...row(5, null), checked_at: null },
    600000,
  )!;
  assert.deepEqual(
    [
      unobserved.headBlock,
      unobserved.lagBlocks,
      unobserved.lagSeconds,
      unobserved.checkedAt,
    ],
    [null, null, null, null],
  );
  const behind = ledgerFreshness(
    { ...row(5), head_block: "75736000", head_timestamp: "1790692000" },
    600000,
  )!;
  assert.deepEqual([behind.lagBlocks, behind.lagSeconds], [0, 0]);
  // No row, or a stream the pass has not started, is no freshness at all.
  assert.equal(ledgerFreshness(undefined, 600000), null);
  assert.equal(
    ledgerFreshness({ ...row(5), cursor_block: null }, 600000),
    null,
  );
  assert.throws(
    () => ledgerFreshness({ ...row(5), cursor_block: "-1" }, 600000),
    /chain_evidence_invalid/,
  );
});

test("LEDGER_STALE_MS defaults to ten minutes and is bounded", () => {
  assert.equal(ledgerStaleSetting({}), ledgerFreshnessDefaults.staleMs);
  assert.equal(ledgerStaleSetting({}), 600000);
  assert.equal(ledgerStaleSetting({ LEDGER_STALE_MS: "120000" }), 120000);
  for (const value of ["59999", "86400001", "", "soon", "600000.5"])
    assert.throws(
      () => ledgerStaleSetting({ LEDGER_STALE_MS: value }),
      /Invalid LEDGER_STALE_MS/,
      value,
    );
});

test("broad-source health stays available when its database is unreachable", async (t) => {
  const reader = createReader("postgresql://test@127.0.0.1:1/test", undefined, {
    marketSource: "broad",
  });
  const server = createApi(reader);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
    await reader.close();
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as { port: number }).port}/health`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ledger: null });
});
