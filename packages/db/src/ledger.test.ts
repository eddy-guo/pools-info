import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  instantDeployments,
  instantRegistryVerifiedAtBlock,
} from "@pools/chain";
import type { LedgerSwap, LedgerTransfer } from "@pools/core";
import {
  acquireLedgerWriter,
  applyLedgerBatch,
  commitBatch,
  createClient,
  ensureDiscovery,
  ensureLedgerStream,
  getStream,
  ledgerCheckpoints,
  ledgerContentHash,
  ledgerRules,
  ledgerStream,
  migrate,
  migrateLedgerTransferProvenance,
  observeLedgerHead,
  parseLedgerCounterpartyManifest,
  pruneLedgerLiveTrades,
  readLedgerStream,
  registerLedgerTransferCounterparties,
  releaseLedgerWriter,
  walkBackLedger,
  type Client,
  type LedgerBatch,
} from "./index";

const url = process.env.TEST_DATABASE_URL;
/** The ledger writer lock is one per database; a sibling test file (the
 * pass) may hold it for a moment, so acquisition waits instead of failing. */
async function writer(db: Client) {
  for (let i = 0; i < 600; i++) {
    if (await acquireLedgerWriter(db)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("ledger writer lock unavailable");
}
if (!url)
  throw Error(
    "Set TEST_DATABASE_URL to a dedicated test Postgres instance; DATABASE_URL is never used by these tests",
  );
const E = 10n ** 18n;
const originalProvenanceMigrationSha256 =
  "bf7d472eac07ae1f75017911eb2f9b7f0bee3146cec81bb076474f1c134d2dac";

test("counterparty registration CLI starts under the repository module mode", () => {
  const result = spawnSync("pnpm", ["ledger:counterparties:register"], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /ledger_counterparty_manifest_required/);
  assert.doesNotMatch(result.stderr, /Top-level await/);
});

const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const base = ledgerStream.start;
const ts = (block: number) => 1_000_000 + (block - base) * 400;
const pool = {
  id: hash(0x100),
  token: addr(0x200),
  name: "Pool",
  symbol: "P",
  launchBlock: 10,
  launchTx: hash(101),
  launchSender: addr(0x201),
  launchedAt: 100,
};
const other = {
  ...pool,
  id: hash(0x110),
  token: addr(0x210),
  launchTx: hash(111),
};
const W = addr(0x300),
  V = addr(0x301);
const counterpartyManifest = (
  entries: Array<{
    address: string;
    class: "wrapper" | "farm";
    label: string;
    validFromBlock: number;
    validThroughBlock: number | null;
  }>,
) =>
  JSON.stringify({
    version: 1,
    chainId: 4663,
    entries: entries.map((entry) => ({
      ...entry,
      evidence: {
        kind: "protocol_registry",
        authority: "Fixture protocol",
        source: `https://protocol.invalid/registry/${entry.address}`,
        sha256: "c".repeat(64),
      },
    })),
  });

function swap(
  block: number,
  logIndex: number,
  fields: {
    side: "buy" | "sell";
    eth: bigint;
    tokens: bigint;
    initiator?: string;
    txTo?: string | null;
    txHash?: string;
    poolId?: string;
    token?: string;
    price?: bigint;
  },
): LedgerSwap {
  return {
    txHash: fields.txHash ?? hash(block * 1000 + logIndex),
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    poolId: fields.poolId ?? pool.id,
    token: fields.token ?? pool.token,
    initiator: fields.initiator ?? W,
    txTo: fields.txTo === undefined ? ledgerRules.router : fields.txTo,
    side: fields.side,
    ethWei: fields.eth.toString(),
    tokenRaw: fields.tokens.toString(),
    sqrtPriceX96: (fields.price ?? 1000n).toString(),
    liquidity: "5",
    tick: 1,
  };
}
function transfer(
  block: number,
  logIndex: number,
  from: string,
  to: string,
  value: bigint,
  txHash: string,
  token = pool.token,
): LedgerTransfer {
  return {
    txHash,
    logIndex,
    block,
    blockHash: hash(block),
    timestamp: ts(block),
    token,
    from,
    to,
    value: value.toString(),
  };
}
/** A wallet's own swap: the swap log and the matching manager transfer. */
function trade(
  block: number,
  side: "buy" | "sell",
  eth: bigint,
  tokens: bigint,
  wallet = W,
  extra: Partial<Parameters<typeof swap>[2]> = {},
) {
  const txHash = hash(block * 1000 + 7);
  const s = swap(block, 10, {
    side,
    eth,
    tokens,
    initiator: wallet,
    txHash,
    ...extra,
  });
  const t =
    side === "buy"
      ? transfer(block, 11, ledgerRules.manager, wallet, tokens, txHash)
      : transfer(block, 11, wallet, ledgerRules.manager, tokens, txHash);
  return { swaps: [s], transfers: [t] };
}
function batch(
  from: number,
  to: number,
  rows: { swaps?: LedgerSwap[]; transfers?: LedgerTransfer[] }[],
  fields: Partial<LedgerBatch> = {},
): LedgerBatch {
  return {
    from,
    to,
    parentHash: hash(from - 1),
    hash: hash(to),
    timestamp: ts(to),
    archiveHeight: to + ledgerStream.confirmations,
    registryPools: 2,
    query: { fixture: [from, to] },
    pages: [],
    requests: 1,
    bytes: 0,
    launches: [],
    swaps: rows.flatMap((r) => r.swaps ?? []),
    transfers: rows.flatMap((r) => r.transfers ?? []),
    ...fields,
  };
}
async function setup(t: test.TestContext) {
  const db = createClient(url);
  await db.connect();
  const schema = "ledger_" + randomUUID().replaceAll("-", "");
  await db.query(`CREATE SCHEMA "${schema}"`);
  await db.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await db.query(`DROP SCHEMA "${schema}" CASCADE`);
    await db.end();
  });
  await migrate(db);
  const discovery = await ensureDiscovery(db, 10);
  await commitBatch(db, discovery, {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool, other],
  });
  await ensureLedgerStream(db, "pass");
  return db;
}
/** Every ledger table with surrogates resolved, volatile columns dropped, in a
 * stable order: equal snapshots mean equal ledgers. */
async function snapshot(db: Client) {
  const q = async (sql: string) => (await db.query(sql)).rows;
  return {
    wallets: await q(
      "SELECT encode(address,'hex') AS address,first_block::int AS first_block FROM agg_wallets ORDER BY address",
    ),
    positions: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,to_jsonb(x)-'pool_ref'-'wallet_ref' AS row FROM agg_positions x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2",
    ),
    walletHours: await q(
      "SELECT p.pool_id,encode(w.address,'hex') AS wallet,x.hour,to_jsonb(x)-'pool_ref'-'wallet_ref' AS row FROM agg_wallet_hours x JOIN indexed_pools p USING(pool_ref) JOIN agg_wallets w USING(wallet_ref) ORDER BY 1,2,3",
    ),
    poolHours: await q(
      "SELECT p.pool_id,x.hour,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_hours x JOIN indexed_pools p USING(pool_ref) ORDER BY 1,2",
    ),
    poolState: await q(
      "SELECT p.pool_id,to_jsonb(x)-'pool_ref' AS row FROM agg_pool_state x JOIN indexed_pools p USING(pool_ref) ORDER BY 1",
    ),
    liveTrades: await q(
      "SELECT encode(x.tx_hash,'hex') AS tx,x.log_index,p.pool_id,encode(w.address,'hex') AS wallet,x.attribution,x.side,x.eth_wei,x.batch_end::int AS batch_end FROM agg_live_trades x JOIN indexed_pools p USING(pool_ref) LEFT JOIN agg_wallets w USING(wallet_ref) ORDER BY x.block_number,x.log_index",
    ),
    batches: await q(
      "SELECT to_block::int AS to_block,from_block::int AS from_block,encode(content_hash,'hex') AS content_hash,swaps,transfers,launches,attributed,unattributed,unregistered_swaps FROM agg_batches ORDER BY to_block",
    ),
    // Surrogates are replaced by addresses: a wallet created twice (after a
    // walk-back) gets a new ref, and the ledger is still the same ledger.
    journal: await q(
      `SELECT j.batch_end::int AS batch_end,j."table",
         (j.key-'wallet_ref')||CASE WHEN j.key ? 'wallet_ref' THEN jsonb_build_object('wallet',encode(w.address,'hex')) ELSE '{}'::jsonb END AS key,
         CASE WHEN j.before IS NULL THEN NULL ELSE (j.before-'wallet_ref')||CASE WHEN j.before ? 'wallet_ref' THEN jsonb_build_object('wallet',encode(w.address,'hex')) ELSE '{}'::jsonb END END AS before
       FROM agg_journal j LEFT JOIN agg_wallets w ON j.key ? 'wallet_ref' AND w.wallet_ref=(j.key->>'wallet_ref')::int ORDER BY 1,2,3`,
    ),
    stream: await readLedgerStream(db),
  };
}
const count = async (db: Client, table: string) =>
  Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count);

test("attended provenance activation preserves old ledger bytes; writes are exact, atomic, idempotent and reorg-bound", async (t) => {
  const db = await setup(t);
  const first = batch(base, base + 9, [trade(base + 5, "buy", E + 123n, 100n)]);
  await assert.rejects(
    migrateLedgerTransferProvenance(db, "a".repeat(64), {
      block: String(base + 9),
      hash: hash(base + 9),
    }),
    /ledger_writer_required/,
  );
  await writer(db);
  await applyLedgerBatch(db, first);
  const before = await snapshot(db);
  await migrate(db); // Normal automatic migrations never activate this feature.
  assert.equal(
    (await db.query("SELECT to_regclass('agg_transfer_provenance') AS table"))
      .rows[0].table,
    null,
  );
  await assert.rejects(
    registerLedgerTransferCounterparties(
      db,
      counterpartyManifest([
        {
          address: V,
          class: "farm",
          label: "Fixture farm",
          validFromBlock: base,
          validThroughBlock: null,
        },
      ]),
    ),
    /ledger_counterparty_registry_not_active/,
  );
  await assert.rejects(
    migrateLedgerTransferProvenance(db, "", null),
    /ledger_provenance_archive_required/,
  );
  await assert.rejects(
    migrateLedgerTransferProvenance(db, "a".repeat(64), null),
    /ledger_provenance_archive_cursor_changed/,
  );
  assert.equal(
    await migrateLedgerTransferProvenance(db, "a".repeat(64), {
      block: String(base + 9),
      hash: hash(base + 9),
    }),
    true,
  );
  assert.equal(
    await migrateLedgerTransferProvenance(db, "b".repeat(64), null),
    false,
  );
  assert.equal(await count(db, "agg_transfer_counterparty_registry"), 0);
  assert.deepEqual(await snapshot(db), before);
  const comment = JSON.parse(
    (
      await db.query(
        "SELECT obj_description('agg_transfer_provenance'::regclass) AS comment",
      )
    ).rows[0].comment,
  );
  assert.equal(comment.archiveSha256, "a".repeat(64));
  assert.equal(comment.cursor.block, String(base + 9));
  assert.equal(
    (await db.query("SELECT transfer_provenance_rows FROM agg_batches")).rows[0]
      .transfer_provenance_rows,
    null,
  );
  // Replaying an old hash must not claim retroactive evidence coverage.
  assert.equal((await applyLedgerBatch(db, first)).changed, false);
  assert.equal(
    (await db.query("SELECT transfer_provenance_rows FROM agg_batches")).rows[0]
      .transfer_provenance_rows,
    null,
  );
  const big = 900719925474099312345n;
  const next = batch(base + 10, base + 19, [
    {
      transfers: [
        transfer(base + 11, 1, pool.launchSender, W, big, hash(999)),
        transfer(base + 12, 2, W, V, 20n, hash(1000)),
      ],
    },
  ]);
  // A provenance write failure rolls back positions, hours, journal and cursor.
  await db.query(
    "ALTER TABLE agg_transfer_provenance ADD CONSTRAINT test_failure CHECK (token_raw=0)",
  );
  await assert.rejects(applyLedgerBatch(db, next), /test_failure/);
  assert.deepEqual(await snapshot(db), before);
  assert.equal(await count(db, "agg_transfer_provenance"), 0);
  await db.query(
    "ALTER TABLE agg_transfer_provenance DROP CONSTRAINT test_failure",
  );
  await applyLedgerBatch(db, next);
  const stored = async () =>
    (
      await db.query(
        "SELECT encode(from_address,'hex') AS source,encode(to_address,'hex') AS recipient,token_raw::text,from_class,to_class,context FROM agg_transfer_provenance ORDER BY block_number,log_index",
      )
    ).rows;
  const evidence = await stored();
  assert.deepEqual(evidence, [
    {
      source: pool.launchSender.slice(2),
      recipient: W.slice(2),
      token_raw: big.toString(),
      from_class: "unregistered",
      to_class: "unregistered",
      context: "residual",
    },
    {
      source: W.slice(2),
      recipient: V.slice(2),
      token_raw: "20",
      from_class: "unregistered",
      to_class: "unregistered",
      context: "residual",
    },
  ]);
  assert.equal((await applyLedgerBatch(db, next)).changed, false);
  assert.deepEqual(await stored(), evidence);
  const changedSource = {
    ...next,
    transfers: next.transfers.map((r, i) => (i ? r : { ...r, from: V })),
  };
  await assert.rejects(
    applyLedgerBatch(db, changedSource),
    /ledger_batch_conflict/,
  );
  assert.deepEqual(await stored(), evidence);
  const after = await snapshot(db);
  await walkBackLedger(db, base + 9);
  assert.deepEqual(await snapshot(db), before);
  assert.equal(await count(db, "agg_transfer_provenance"), 0);
  await applyLedgerBatch(db, next);
  assert.deepEqual(await stored(), evidence);
  assert.deepEqual(await snapshot(db), after);
  const exact = (
    await db.query(
      "SELECT invested_wei::text,realized_wei=proceeds_wei-disposed_cost_wei AS realized_identity, invested_wei=cost_wei+disposed_cost_wei+outflow_cost_wei AS basis_identity,supported,flags FROM agg_positions p JOIN agg_wallets w USING(wallet_ref) WHERE w.address=decode($1,'hex')",
      [W.slice(2)],
    )
  ).rows[0];
  assert.equal(exact.invested_wei, (E + 123n).toString());
  assert.equal(exact.realized_identity, true);
  assert.equal(exact.basis_identity, true);
  assert.equal(exact.supported, false);
  assert.ok(exact.flags.includes("zero_cost_inflow"));
  assert.ok(exact.flags.includes("unattributed_outflow"));
  const explained = batch(base + 20, base + 29, [
    trade(base + 21, "buy", E, 100n, V),
  ]);
  await applyLedgerBatch(db, explained);
  assert.deepEqual(
    (
      await db.query(
        "SELECT transfer_provenance_rows FROM agg_batches ORDER BY to_block",
      )
    ).rows.map((r) => r.transfer_provenance_rows),
    [null, 2, 0],
  );
});

test("counterparty registry upgrades an existing provenance schema without guessing unknowns", async (t) => {
  const db = await setup(t);
  await writer(db);
  const originalSql = await readFile(
    new URL(
      "../attended-migrations/001_transfer_provenance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(originalSql).digest("hex"),
    originalProvenanceMigrationSha256,
  );
  await db.query("BEGIN");
  await db.query(originalSql);
  await db.query(
    "INSERT INTO pools_schema_migrations(name,checksum) VALUES ($1,$2)",
    ["attended/001_transfer_provenance.sql", originalProvenanceMigrationSha256],
  );
  await db.query("COMMIT");
  assert.equal(
    (
      await db.query(
        "SELECT to_regclass('agg_transfer_counterparty_registry') AS table",
      )
    ).rows[0].table,
    null,
  );
  assert.equal(
    await migrateLedgerTransferProvenance(db, "a".repeat(64), null),
    true,
  );
  assert.equal(
    await migrateLedgerTransferProvenance(db, "b".repeat(64), null),
    false,
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT name FROM pools_schema_migrations WHERE name LIKE 'attended/%transfer_%' ORDER BY name",
      )
    ).rows.map((row) => row.name),
    [
      "attended/001_transfer_provenance.sql",
      "attended/002_transfer_counterparty_registry.sql",
    ],
  );
  const wrapper = addr(0x410);
  await registerLedgerTransferCounterparties(
    db,
    counterpartyManifest([
      {
        address: wrapper,
        class: "wrapper",
        label: "Fixture wrapper",
        validFromBlock: base,
        validThroughBlock: null,
      },
    ]),
  );
  const txHash = hash(0x410);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [
      {
        transfers: [
          transfer(base + 1, 1, wrapper, W, 11n, txHash),
          transfer(base + 1, 2, V, W, 7n, txHash),
        ],
      },
    ]),
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT encode(from_address,'hex') AS address,from_class,classification_version FROM agg_transfer_provenance ORDER BY log_index",
      )
    ).rows,
    [
      {
        address: wrapper.slice(2),
        from_class: "wrapper",
        classification_version: 2,
      },
      {
        address: V.slice(2),
        from_class: "unregistered",
        classification_version: 2,
      },
    ],
  );
});

test("persisted provenance uses the recorded protocol roles in both directions and preserves their activation boundary", async (t) => {
  const db = await setup(t);
  await writer(db);
  await migrateLedgerTransferProvenance(db, "a".repeat(64), null);
  const activation = instantRegistryVerifiedAtBlock;
  const wrapper = addr(0x400),
    farm = addr(0x401);
  const manifest = counterpartyManifest([
    {
      address: wrapper,
      class: "wrapper",
      label: "Fixture wrapper",
      validFromBlock: activation,
      validThroughBlock: null,
    },
    {
      address: farm,
      class: "farm",
      label: "Fixture farm",
      validFromBlock: activation,
      validThroughBlock: activation,
    },
  ]);
  assert.throws(
    () =>
      parseLedgerCounterpartyManifest(
        JSON.stringify({
          version: 1,
          chainId: 4663,
          entries: [
            {
              address: addr(0x402),
              class: "farm",
              label: "Guessed from transfers",
              validFromBlock: activation,
              validThroughBlock: null,
              evidence: {
                kind: "activity_pattern",
                authority: "Heuristic",
                source: "transfer direction",
                sha256: "c".repeat(64),
              },
            },
          ],
        }),
      ),
    /ledger_counterparty_manifest_invalid/,
  );
  assert.throws(
    () =>
      parseLedgerCounterpartyManifest(
        counterpartyManifest([
          {
            address: ledgerRules.router,
            class: "farm",
            label: "Conflicting protocol role",
            validFromBlock: activation,
            validThroughBlock: null,
          },
        ]),
      ),
    /ledger_counterparty_manifest_invalid/,
  );
  assert.deepEqual(await registerLedgerTransferCounterparties(db, manifest), {
    inserted: 2,
    manifestSha256: parseLedgerCounterpartyManifest(manifest).sha256,
  });
  assert.equal(
    (await registerLedgerTransferCounterparties(db, manifest)).inserted,
    0,
  );
  await assert.rejects(
    registerLedgerTransferCounterparties(
      db,
      counterpartyManifest([
        {
          address: wrapper,
          class: "farm",
          label: "Conflicting farm",
          validFromBlock: activation,
          validThroughBlock: null,
        },
      ]),
    ),
    /ledger_counterparty_registry_conflict/,
  );
  await assert.rejects(
    db.query(
      "UPDATE agg_transfer_counterparty_registry SET label='changed' WHERE address=decode($1,'hex')",
      [wrapper.slice(2)],
    ),
    /append-only/,
  );
  const endpoints = [
    { address: instantDeployments[0].launcher, role: "launcher" },
    { address: instantDeployments[0].strategy, role: "protocol" },
    { address: instantDeployments[0].feeSplitter, role: "protocol" },
    { address: ledgerRules.manager, role: "protocol" },
    { address: ledgerRules.router, role: "wrapper_or_router" },
    { address: wrapper, role: "wrapper" },
    { address: farm, role: "farm" },
  ];
  const transfers = endpoints.flatMap(({ address }, i) => [
    transfer(activation, i * 2, address, W, 11n, hash(activation)),
    transfer(activation, i * 2 + 1, W, address, 3n, hash(activation)),
  ]);
  await applyLedgerBatch(
    db,
    batch(base, activation, [
      {
        transfers: [
          transfer(
            activation - 1,
            0,
            ledgerRules.router,
            V,
            1n,
            hash(activation - 1),
          ),
          ...transfers,
        ],
      },
    ]),
  );
  const saved = (
    await db.query(
      "SELECT block_number::int,from_class,to_class,from_evidence,to_evidence,classification_version FROM agg_transfer_provenance ORDER BY block_number,log_index",
    )
  ).rows;
  assert.equal(saved[0].from_class, "unregistered");
  assert.equal(saved[0].from_evidence, "registry:unregistered");
  for (const [i, { role }] of endpoints.entries()) {
    const incoming = saved[1 + i * 2],
      outgoing = saved[2 + i * 2];
    assert.equal(incoming.from_class, role);
    assert.equal(outgoing.to_class, role);
    assert.equal(incoming.to_class, "unregistered");
    assert.equal(outgoing.from_class, "unregistered");
    assert.equal(incoming.from_evidence, outgoing.to_evidence);
    assert.notEqual(incoming.from_evidence, "registry:unregistered");
    assert.equal(incoming.classification_version, 2);
    assert.equal(outgoing.classification_version, 2);
  }
  await migrate(db); // An attended entry must not break later ordinary startup.
});

test("applyLedgerBatch needs the writer lock, applies once per content hash, refuses a differing hash or a gap, and advances the cursor with the rows", async (t) => {
  const db = await setup(t);
  const first = batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]);
  await assert.rejects(applyLedgerBatch(db, first), /ledger_writer_required/);
  await writer(db);
  const applied = await applyLedgerBatch(db, first);
  assert.deepEqual(applied, {
    changed: true,
    contentHash: ledgerContentHash(first),
    swaps: 1,
    transfers: 1,
    launches: 0,
    attributed: 1,
    unattributed: 0,
    unregisteredSwaps: 0,
    positions: 1,
    newWallets: 1,
  });
  const stream = await readLedgerStream(db);
  assert.deepEqual(
    [stream.cursor, stream.hash, stream.timestamp, stream.mode],
    [base + 9, hash(base + 9), ts(base + 9), "pass"],
  );
  assert.deepEqual(await ledgerCheckpoints(db), [
    { to: base + 9, hash: hash(base + 9) },
  ]);
  const position = (
    await db.query(
      "SELECT quantity_raw,cost_wei,invested_wei,realized_wei,supported,flags,cycle_opened_at::int AS opened FROM agg_positions",
    )
  ).rows;
  assert.deepEqual(position, [
    {
      quantity_raw: "100",
      cost_wei: E.toString(),
      invested_wei: E.toString(),
      realized_wei: "0",
      supported: true,
      flags: [],
      opened: ts(base + 5),
    },
  ]);
  assert.equal(
    (await db.query("SELECT holders FROM agg_pool_state")).rows[0].holders,
    1,
  );
  // The journal holds one null pre-image per created row.
  assert.deepEqual(
    (await db.query('SELECT "table",before FROM agg_journal ORDER BY "table"'))
      .rows,
    [
      "agg_pool_hours",
      "agg_pool_state",
      "agg_positions",
      "agg_wallet_hours",
      "agg_wallets",
    ].map((table) => ({ table, before: null })),
  );
  // Replay: the same rows are a no-op; different rows for the same range are refused.
  const before = await snapshot(db);
  assert.equal((await applyLedgerBatch(db, first)).changed, false);
  assert.deepEqual(await snapshot(db), before);
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base, base + 9, [trade(base + 5, "buy", E * 2n, 100n)]),
    ),
    /ledger_batch_conflict/,
  );
  await assert.rejects(
    applyLedgerBatch(db, { ...first, hash: hash(999) }),
    /ledger_batch_conflict/,
  );
  // Contiguity: the next range starts at cursor + 1 and names the cursor's hash.
  await assert.rejects(
    applyLedgerBatch(db, batch(base + 11, base + 19, [])),
    /ledger_noncontiguous_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], { parentHash: hash(4242) }),
    ),
    /ledger_noncontiguous_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], { archiveHeight: base + 19 + 127 }),
    ),
    /ledger_invalid_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [trade(base + 25, "buy", E, 1n)]),
    ),
    /ledger_row_outside_batch/,
  );
  await assert.rejects(
    applyLedgerBatch(
      db,
      batch(base + 10, base + 19, [], {
        launches: [
          {
            poolId: hash(0x999),
            token: pool.token,
            block: base + 12,
            blockHash: hash(base + 12),
            txHash: hash(5),
            logIndex: 0,
          },
        ],
      }),
    ),
    /ledger_unregistered_launch/,
  );
  assert.deepEqual(
    await snapshot(db),
    before,
    "a refused batch changes nothing",
  );
  // An unregistered pool's swap is counted, not applied; an unregistered
  // token's transfer is dropped; a registered launch is counted.
  const second = batch(
    base + 10,
    base + 19,
    [
      trade(base + 12, "sell", (E * 6n) / 10n, 40n),
      {
        swaps: [
          swap(base + 13, 3, {
            side: "buy",
            eth: E,
            tokens: 5n,
            poolId: hash(0x999),
            token: addr(0x999),
          }),
        ],
      },
      {
        transfers: [
          transfer(
            base + 14,
            1,
            ledgerRules.manager,
            V,
            9n,
            hash(77),
            addr(0x999),
          ),
        ],
      },
    ],
    {
      launches: [
        {
          poolId: other.id,
          token: other.token,
          block: base + 11,
          blockHash: hash(base + 11),
          txHash: hash(6),
          logIndex: 0,
        },
      ],
    },
  );
  const next = await applyLedgerBatch(db, second);
  assert.deepEqual(
    [
      next.changed,
      next.attributed,
      next.unregisteredSwaps,
      next.launches,
      next.newWallets,
    ],
    [true, 1, 1, 1, 0],
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT swaps,transfers,launches,attributed,unattributed,unregistered_swaps FROM agg_batches WHERE to_block=$1",
        [base + 19],
      )
    ).rows,
    [
      {
        swaps: 2,
        transfers: 2,
        launches: 1,
        attributed: 1,
        unattributed: 0,
        unregistered_swaps: 1,
      },
    ],
  );
  assert.equal(await count(db, "agg_live_trades"), 2);
  assert.equal(await count(db, "agg_wallets"), 1);
  const after = (
    await db.query(
      "SELECT quantity_raw,cost_wei,realized_wei,disposed_cost_wei,proceeds_wei FROM agg_positions",
    )
  ).rows[0];
  assert.deepEqual(after, {
    quantity_raw: "60",
    cost_wei: ((E * 6n) / 10n).toString(),
    realized_wei: (E / 5n).toString(),
    disposed_cost_wei: ((E * 4n) / 10n).toString(),
    proceeds_wei: ((E * 6n) / 10n).toString(),
  });
  // The second batch journaled the first batch's rows as its pre-images.
  const preimages = (
    await db.query(
      'SELECT "table",before FROM agg_journal WHERE batch_end=$1 ORDER BY "table"',
      [base + 19],
    )
  ).rows;
  assert.deepEqual(
    preimages.map((r) => [r.table, r.before === null ? null : typeof r.before]),
    [
      ["agg_pool_hours", null],
      ["agg_pool_state", "object"],
      ["agg_positions", "object"],
      ["agg_wallet_hours", null],
    ],
  );
  assert.equal(preimages[2].before.quantity_raw, 100);
  await releaseLedgerWriter(db);
  await assert.rejects(
    applyLedgerBatch(db, batch(base + 20, base + 29, [])),
    /ledger_writer_required/,
  );
});

test("the database refuses forged identities, wrong scales, other chains and an unproven lag", async (t) => {
  const db = await setup(t);
  await writer(db);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [
      trade(base + 5, "buy", E, 100n),
      trade(base + 6, "sell", E / 2n, 50n),
    ]),
  );
  const refused = async (
    sql: string,
    pattern: RegExp = /violates check constraint/,
  ) => {
    await db.query("SAVEPOINT forged");
    await assert.rejects(db.query(sql), pattern);
    await db.query("ROLLBACK TO SAVEPOINT forged");
  };
  await db.query("BEGIN");
  await refused("UPDATE agg_positions SET realized_wei=realized_wei+1");
  await refused(
    "UPDATE agg_positions SET disposed_cost_wei=disposed_cost_wei+1",
  );
  await refused("UPDATE agg_positions SET cost_wei=cost_wei+1");
  await refused("UPDATE agg_positions SET quantity_raw=1.5");
  await refused("UPDATE agg_positions SET quantity_raw=-1");
  await refused("UPDATE agg_positions SET flags=ARRAY['unknown_basis']");
  await refused("UPDATE agg_positions SET supported=false");
  // zero_cost_inflow excludes (migration 022): a supported position cannot
  // carry it, and an excluded one cannot carry it without an inflow.
  await refused(
    "UPDATE agg_positions SET supported=false,flags=ARRAY['zero_cost_inflow']",
  );
  await refused(
    "UPDATE agg_positions SET inflow_raw=5,flags=ARRAY['zero_cost_inflow']",
  );
  await refused("UPDATE agg_positions SET inflow_raw=5");
  await refused("UPDATE agg_positions SET flags=ARRAY['wrapper_route']");
  await refused("UPDATE agg_positions SET cycle_opened_at=NULL");
  await refused("UPDATE agg_positions SET closed_cycles=NULL");
  await refused("UPDATE agg_positions SET flash_cycles=closed_cycles+1");
  await refused("UPDATE agg_positions SET shortest_cycle_seconds=5");
  await refused("UPDATE agg_wallet_hours SET flash_closures=closures+1");
  await refused("UPDATE agg_batches SET journal_rows=-1");
  await refused("UPDATE agg_positions SET chain_id=1");
  await refused("UPDATE agg_wallet_hours SET realized_wei=realized_wei+1");
  await refused(
    "UPDATE agg_wallet_hours SET supported_trades=supported_trades+1",
  );
  await refused("UPDATE agg_wallet_hours SET wins=wins+1");
  await refused(
    "UPDATE agg_pool_hours SET low_sqrt_price_x96=high_sqrt_price_x96+1",
  );
  await refused("UPDATE agg_pool_hours SET buyers=buys+1");
  await refused("UPDATE agg_pool_hours SET unattributed=trades+1");
  await refused("UPDATE agg_pool_state SET holders=-1");
  await refused("UPDATE agg_batches SET archive_height=to_block+127");
  await refused("UPDATE agg_batches SET attributed=attributed+1");
  await refused("UPDATE agg_batches SET content_hash='\\x00'");
  await refused("UPDATE agg_streams SET start_block=1");
  await refused("UPDATE agg_streams SET cursor_hash=NULL");
  await refused("UPDATE agg_live_trades SET wallet_ref=NULL");
  await refused("UPDATE agg_live_trades SET attribution='unattributed'");
  await refused("UPDATE agg_wallets SET address='\\x00'");
  await refused(
    "INSERT INTO agg_journal(chain_id,stream_key,batch_end,\"table\",key,before) VALUES (4663,'ledger:agg:v1',$1,'agg_positions','1','{}')".replace(
      "$1",
      String(base + 9),
    ),
  );
  // A journal row cannot exist without its batch.
  await refused(
    `INSERT INTO agg_journal(chain_id,stream_key,batch_end,"table",key,before) VALUES (4663,'ledger:agg:v1',${base + 99},'agg_positions','{}','{}')`,
    /foreign key/,
  );
  await db.query("ROLLBACK");
});

/** The reorg replay from the recent stream (PR 35): batches beyond a fork are
 * walked back to the newest surviving checkpoint, the replaced range is
 * recollected, and the ledger equals a fresh build of the same history. */
test("walk-back restores every pre-image in reverse order and a replaced range rebuilds to a fresh build", async (t) => {
  const db = await setup(t);
  await writer(db);
  const fresh = createClient(url);
  await fresh.connect();
  const schema = "ledger_fresh_" + randomUUID().replaceAll("-", "");
  await fresh.query(`CREATE SCHEMA "${schema}"`);
  await fresh.query(`SET search_path TO "${schema}"`);
  t.after(async () => {
    await fresh.query(`DROP SCHEMA "${schema}" CASCADE`);
    await fresh.end();
  });
  await migrate(fresh);
  await commitBatch(fresh, await ensureDiscovery(fresh, 10), {
    from: 10,
    to: 19,
    hash: hash(19),
    evidence: {},
    pools: [pool, other],
  });
  await ensureLedgerStream(fresh, "pass");

  // A: W buys. B: W sells part, V buys through a wrapper, W gives X tokens
  // (X is excluded on arrival, W on departure with a proportional basis
  // gone). C: V sells more than the ledger holds (excluded, zeroing V's hour
  // in B), a new wallet U appears, and a loop leaves an unattributed swap.
  const U = addr(0x302),
    X = addr(0x303);
  const A = batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]);
  const B = batch(base + 10, base + 19, [
    trade(base + 12, "sell", (E * 6n) / 10n, 40n),
    trade(base + 14, "buy", E, 30n, V, { txTo: addr(0x400) }),
    { transfers: [transfer(base + 16, 2, W, X, 10n, hash(4444))] },
  ]);
  const loop = hash(5555);
  const C = batch(base + 20, base + 29, [
    trade(base + 22, "sell", E * 2n, 41n, V),
    trade(base + 24, "buy", E, 7n, U),
    {
      swaps: [
        swap(base + 26, 1, {
          side: "buy",
          eth: E,
          tokens: 5n,
          initiator: U,
          txHash: loop,
        }),
        swap(base + 26, 5, {
          side: "sell",
          eth: E,
          tokens: 3n,
          initiator: U,
          txHash: loop,
        }),
      ],
      transfers: [
        transfer(base + 26, 2, ledgerRules.manager, U, 5n, loop),
        transfer(base + 26, 6, U, ledgerRules.manager, 3n, loop),
      ],
    },
  ]);
  const snapshots = [];
  for (const b of [A, B, C]) {
    await applyLedgerBatch(db, b);
    snapshots.push(await snapshot(db));
  }
  const [afterA, afterB, afterC] = snapshots;
  // C excluded V: V's B-hour finances are zero now, and were journaled by C.
  const vHour = afterC.walletHours.find(
    (h) =>
      h.wallet === V.slice(2) && h.hour === Math.floor(ts(base + 14) / 3600),
  )!.row;
  assert.deepEqual(
    [vHour.spent_wei, vHour.supported_trades, vHour.buys, vHour.volume_wei],
    [0, 0, 1, Number(E)],
  );
  const journaledV = afterC.journal.find(
    (j) =>
      j.batch_end === base + 29 &&
      j.table === "agg_wallet_hours" &&
      j.key.wallet === V.slice(2) &&
      j.before?.spent_wei === Number(E),
  );
  assert.ok(journaledV, "the zeroed hour row was journaled with its pre-image");
  assert.equal(
    afterC.positions.find((p) => p.wallet === V.slice(2))!.row.supported,
    false,
  );
  assert.equal(
    afterC.positions.find((p) => p.wallet === U.slice(2))!.row.flags[0],
    "unattributed_swap_activity",
  );
  assert.equal(afterC.batches.at(-1)!.unattributed, 2);
  // Walk back C: the ledger is exactly as B left it, cursor included.
  assert.deepEqual(await walkBackLedger(db, base + 19), {
    removed: [base + 29],
  });
  assert.deepEqual(await snapshot(db), afterB);
  // Walk back B as well, then everything.
  assert.deepEqual(await walkBackLedger(db, base + 9), {
    removed: [base + 19],
  });
  assert.deepEqual(await snapshot(db), afterA);
  await assert.rejects(
    walkBackLedger(db, base + 19),
    /ledger_unknown_ancestor/,
  );
  assert.deepEqual(await walkBackLedger(db, null), { removed: [base + 9] });
  const empty = await snapshot(db);
  assert.deepEqual(
    [
      empty.wallets,
      empty.positions,
      empty.walletHours,
      empty.poolHours,
      empty.poolState,
      empty.liveTrades,
      empty.batches,
      empty.journal,
    ],
    [[], [], [], [], [], [], [], []],
  );
  assert.deepEqual(
    [empty.stream.cursor, empty.stream.hash, empty.stream.timestamp],
    [null, null, null],
  );
  // Rebuild A and B, then a fork replaces C's transactions (different block
  // hashes, a different sale) and the ledger must equal a fresh build.
  for (const b of [A, B]) await applyLedgerBatch(db, b);
  assert.deepEqual(await snapshot(db), afterB);
  await applyLedgerBatch(db, C);
  assert.deepEqual(await snapshot(db), afterC);
  const replaced = batch(
    base + 20,
    base + 29,
    [
      trade(base + 22, "sell", E * 3n, 20n, V),
      trade(base + 27, "buy", E, 3n, U),
    ],
    { hash: hash(424242) },
  );
  const forkedRows = {
    ...replaced,
    swaps: replaced.swaps.map((s) => ({
      ...s,
      blockHash: s.block === base + 29 ? hash(424242) : hash(s.block + 900000),
    })),
    transfers: replaced.transfers.map((x) => ({
      ...x,
      blockHash: hash(x.block + 900000),
    })),
  };
  await assert.rejects(
    applyLedgerBatch(db, forkedRows),
    /ledger_batch_conflict/,
  );
  assert.deepEqual(await walkBackLedger(db, base + 19), {
    removed: [base + 29],
  });
  await applyLedgerBatch(db, forkedRows);
  await assert.rejects(
    walkBackLedger(db, base + 30),
    /ledger_unknown_ancestor/,
  );
  await assert.rejects(
    walkBackLedger(db, base + 15),
    /ledger_unknown_ancestor/,
  );
  // One writer per database: the fresh build takes the lock after this one.
  await releaseLedgerWriter(db);
  await writer(fresh);
  for (const b of [A, B, forkedRows]) await applyLedgerBatch(fresh, b);
  await releaseLedgerWriter(fresh);
  const rebuilt = await snapshot(db),
    built = await snapshot(fresh);
  assert.deepEqual(rebuilt.stream, built.stream);
  assert.deepEqual(
    [rebuilt.stream.cursor, rebuilt.stream.hash],
    [base + 29, hash(424242)],
  );
  for (const table of [
    "wallets",
    "positions",
    "walletHours",
    "poolHours",
    "poolState",
    "liveTrades",
    "batches",
  ] as const)
    assert.deepEqual(rebuilt[table], built[table], table);
  assert.deepEqual(rebuilt.journal, built.journal);
  assert.equal(
    rebuilt.positions.find((p) => p.wallet === V.slice(2))!.row.supported,
    true,
  );
});

test("the live ring keeps 24 hours of trades and a batch's rows leave with it", async (t) => {
  const db = await setup(t);
  await writer(db);
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]),
  );
  // 400 seconds per block: block base + 300 is more than 24 hours later.
  await applyLedgerBatch(
    db,
    batch(base + 10, base + 300, [trade(base + 299, "sell", E, 10n)]),
  );
  assert.deepEqual(
    (
      await db.query(
        "SELECT block_number::int AS block,batch_end::int AS batch_end FROM agg_live_trades ORDER BY block_number",
      )
    ).rows,
    [{ block: base + 299, batch_end: base + 300 }],
  );
  await walkBackLedger(db, base + 9);
  assert.equal(await count(db, "agg_live_trades"), 0);
  assert.equal(await count(db, "agg_journal"), 5);
  const s = await getStream(db, "discovery:v1");
  assert.equal(s.cursor, 19, "the catalog streams are untouched by the ledger");
});

test("the live ring's bound: the 24 hours ending at the cursor, then the newest rows up to a cap sized from the measured peak day", async (t) => {
  const db = await setup(t);
  await writer(db);
  // The cap sits above the busiest rolling 24 hours the history pass measured
  // (1,026,761 swaps on 5 to 6 Aug 2026), so a whole day stays in the ring.
  assert.equal(ledgerStream.liveTradeSeconds, 86400);
  assert.ok(ledgerStream.liveTradeRows >= 1_026_761);
  assert.ok(ledgerStream.liveTradeRows <= 1_300_000);
  // Six trades across three batches, 400 seconds per block.
  const trades = [
    trade(base + 1, "buy", E, 100n),
    trade(base + 2, "buy", E, 100n, V),
    trade(base + 3, "sell", E / 2n, 10n),
  ];
  await applyLedgerBatch(db, batch(base, base + 9, trades));
  await applyLedgerBatch(
    db,
    batch(base + 10, base + 19, [
      trade(base + 12, "sell", E / 2n, 10n, V),
      trade(base + 15, "buy", E, 5n),
    ]),
  );
  await applyLedgerBatch(
    db,
    batch(base + 20, base + 29, [trade(base + 25, "sell", E, 20n)]),
  );
  const ring = async () =>
    (
      await db.query(
        "SELECT block_number::int AS block,batch_end::int AS batch_end FROM agg_live_trades ORDER BY block_number,log_index",
      )
    ).rows.map((r) => r.block);
  assert.deepEqual(await ring(), [
    base + 1,
    base + 2,
    base + 3,
    base + 12,
    base + 15,
    base + 25,
  ]);
  // The count bound keeps the newest rows.
  assert.deepEqual(
    await pruneLedgerLiveTrades(db, { through: ts(base + 29), maxRows: 4 }),
    { aged: 0, counted: 2 },
  );
  assert.deepEqual(await ring(), [base + 3, base + 12, base + 15, base + 25]);
  // The age bound keeps the window ending at the cursor, its start included.
  assert.deepEqual(
    await pruneLedgerLiveTrades(db, {
      through: ts(base + 29),
      seconds: ts(base + 29) - ts(base + 12),
    }),
    { aged: 1, counted: 0 },
  );
  assert.deepEqual(await ring(), [base + 12, base + 15, base + 25]);
  await assert.rejects(
    pruneLedgerLiveTrades(db, { through: ts(base + 29), maxRows: 0 }),
    /ledger_invalid_ring_bound/,
  );
  // Every batch prunes: a batch a day later leaves only its own day.
  const dayLater = base + 30 + Math.ceil(86400 / 400);
  await applyLedgerBatch(
    db,
    batch(base + 30, dayLater, [trade(dayLater - 1, "buy", E, 1n, V)]),
  );
  const bounds = (
    await db.query(
      "SELECT count(*)::int AS rows,min(timestamp)::int AS oldest FROM agg_live_trades",
    )
  ).rows[0];
  assert.ok(bounds.oldest >= ts(dayLater) - ledgerStream.liveTradeSeconds);
  assert.equal(bounds.rows, 1);
});

test("walk-back refuses a batch whose journal is not whole and leaves the ledger as it was", async (t) => {
  const db = await setup(t);
  await writer(db);
  const A = batch(base, base + 9, [trade(base + 5, "buy", E, 100n)]);
  const B = batch(base + 10, base + 19, [
    trade(base + 12, "sell", E / 2n, 40n),
    trade(base + 14, "buy", E, 30n, V),
  ]);
  await applyLedgerBatch(db, A);
  await applyLedgerBatch(db, B);
  const journal = await db.query(
    "SELECT to_block::int AS to_block,journal_rows FROM agg_batches ORDER BY to_block",
  );
  assert.deepEqual(
    journal.rows,
    [
      { to_block: base + 9, journal_rows: 5 },
      { to_block: base + 19, journal_rows: 7 },
    ],
    "each batch records the journal rows it wrote",
  );
  const before = await snapshot(db);
  // A dump restored without agg_journal: the batch's pre-images are gone.
  await db.query("BEGIN");
  await db.query("DELETE FROM agg_journal WHERE batch_end=$1", [base + 19]);
  await db.query("COMMIT");
  const kept = await snapshot(db);
  await assert.rejects(
    walkBackLedger(db, base + 9),
    /ledger_walkback_unavailable/,
  );
  assert.deepEqual(await snapshot(db), kept);
  assert.deepEqual(kept.positions, before.positions);
  // A batch committed before journal sizes were kept is refused as well.
  await db.query("UPDATE agg_batches SET journal_rows=NULL WHERE to_block=$1", [
    base + 9,
  ]);
  await assert.rejects(walkBackLedger(db, null), /ledger_walkback_unavailable/);
  assert.equal((await readLedgerStream(db)).cursor, base + 19);
});

test("closed-cycle hold time persists, stays null on rows from before the fold, and walks back to exactly that", async (t) => {
  const db = await setup(t);
  await writer(db);
  // W buys and sells in one block (held 0 s: a flash cycle); V buys, and
  // closes a block later (400 s).
  const flash = (block: number, wallet: string, tokens: bigint, n: number) => {
    const buy = hash(block * 1000 + n),
      sell = hash(block * 1000 + n + 1);
    return {
      swaps: [
        swap(block, n, {
          side: "buy",
          eth: E,
          tokens,
          initiator: wallet,
          txHash: buy,
        }),
        swap(block, n + 2, {
          side: "sell",
          eth: E * 2n,
          tokens,
          initiator: wallet,
          txHash: sell,
        }),
      ],
      transfers: [
        transfer(block, n + 1, ledgerRules.manager, wallet, tokens, buy),
        transfer(block, n + 3, wallet, ledgerRules.manager, tokens, sell),
      ],
    };
  };
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [
      flash(base + 3, W, 100n, 10),
      trade(base + 4, "buy", E, 50n, V),
      trade(base + 5, "sell", E, 50n, V),
    ]),
  );
  const cycles = async () =>
    (
      await db.query(
        `SELECT encode(w.address,'hex') AS wallet,closed_cycles,flash_cycles,shortest_cycle_seconds::int AS shortest
         FROM agg_positions p JOIN agg_wallets w USING (wallet_ref) ORDER BY w.address`,
      )
    ).rows.map((r) => [
      "0x" + r.wallet,
      r.closed_cycles,
      r.flash_cycles,
      r.shortest,
    ]);
  const hours = async () =>
    (
      await db.query(
        `SELECT encode(w.address,'hex') AS wallet,hour,closures,flash_closures FROM agg_wallet_hours h JOIN agg_wallets w USING (wallet_ref) ORDER BY w.address,hour`,
      )
    ).rows.map((r) => ["0x" + r.wallet, r.hour, r.closures, r.flash_closures]);
  assert.deepEqual(await cycles(), [
    [W, 1, 1, 0],
    [V, 1, 0, 400],
  ]);
  const hourOf = (block: number) => Math.floor(ts(block) / 3600);
  const first = hourOf(base + 3);
  assert.equal(hourOf(base + 5), first);
  assert.deepEqual(await hours(), [
    [W, first, 1, 1],
    [V, first, 1, 0],
  ]);
  // The rows a dump taken before migration 020 restores: nothing folded.
  await db.query(
    "UPDATE agg_positions SET closed_cycles=NULL,flash_cycles=NULL,shortest_cycle_seconds=NULL",
  );
  await db.query("UPDATE agg_wallet_hours SET flash_closures=NULL");
  const legacy = await snapshot(db);
  // W closes another flash cycle in the same hour; a new hour row counts.
  const later = base + 20;
  await applyLedgerBatch(
    db,
    batch(base + 10, later + 9, [
      flash(base + 10, W, 70n, 20),
      flash(later, V, 30n, 30),
    ]),
  );
  assert.deepEqual(await cycles(), [
    [W, null, null, null],
    [V, null, null, null],
  ]);
  // base + 10 shares the first hour; base + 20 is two hours on.
  assert.deepEqual([hourOf(base + 10), hourOf(later)], [first, first + 2]);
  assert.deepEqual(await hours(), [
    [W, first, 2, null],
    [V, first, 1, null],
    [V, first + 2, 1, 1],
  ]);
  // Walking back restores the nulls, including from a pre-image journaled
  // before the columns existed.
  await db.query(
    "UPDATE agg_journal SET before=before-'closed_cycles'-'flash_cycles'-'shortest_cycle_seconds'-'flash_closures' WHERE before IS NOT NULL",
  );
  await walkBackLedger(db, base + 9);
  assert.deepEqual(await snapshot(db), legacy);
});

test("the tip loop's head observation needs the writer lock and keeps block and timestamp together", async (t) => {
  const db = await setup(t);
  await assert.rejects(
    observeLedgerHead(db, base + 500, ts(base + 500)),
    /ledger_writer_required/,
  );
  await writer(db);
  await observeLedgerHead(db, base + 500, ts(base + 500));
  const row = (
    await db.query(
      "SELECT head_block::int AS head,head_timestamp::int AS at,checked_at IS NOT NULL AS checked FROM agg_streams",
    )
  ).rows[0];
  assert.deepEqual(row, {
    head: base + 500,
    at: ts(base + 500),
    checked: true,
  });
  await assert.rejects(observeLedgerHead(db, -1, 0), /ledger_invalid_head/);
});

test("a launch's total supply is stored with the block it was read at, and a later reading replaces an earlier one, never the reverse", async (t) => {
  const db = await setup(t);
  const launched = {
    ...pool,
    id: hash(0x120),
    token: addr(0x220),
    launchTx: hash(121),
    launchBlock: 25,
    totalSupplyRaw: (10n ** 27n).toString(),
    supplyBlock: 900,
  };
  const observe = async (
    key: string,
    fields: { totalSupplyRaw: string | null; supplyBlock: number | null },
  ) => {
    await db.query(
      "INSERT INTO indexer_streams(chain_id,stream_key,kind,start_block) VALUES (4663,$1,'discovery',20) ON CONFLICT DO NOTHING",
      [key],
    );
    await commitBatch(db, await getStream(db, key), {
      from: 20,
      to: 29,
      hash: hash(29),
      evidence: { key },
      pools: [{ ...launched, ...fields }],
    });
  };
  const supply = async () =>
    (
      await db.query(
        "SELECT token_total_supply_raw::text AS raw,token_supply_block::int AS block FROM indexed_pools WHERE pool_id=$1",
        [launched.id],
      )
    ).rows[0];
  await observe("discovery:supply-first", launched);
  assert.deepEqual(await supply(), {
    raw: (10n ** 27n).toString(),
    block: 900,
  });
  await observe("discovery:supply-earlier", {
    totalSupplyRaw: "5",
    supplyBlock: 800,
  });
  await observe("discovery:supply-unread", {
    totalSupplyRaw: null,
    supplyBlock: null,
  });
  assert.deepEqual(await supply(), {
    raw: (10n ** 27n).toString(),
    block: 900,
  });
  await observe("discovery:supply-later", {
    totalSupplyRaw: (10n ** 27n - 1n).toString(),
    supplyBlock: 1000,
  });
  assert.deepEqual(await supply(), {
    raw: (10n ** 27n - 1n).toString(),
    block: 1000,
  });
  for (const forged of [
    { totalSupplyRaw: "1", supplyBlock: null },
    { totalSupplyRaw: null, supplyBlock: 5 },
    { totalSupplyRaw: "-1", supplyBlock: 5 },
    { totalSupplyRaw: (1n << 256n).toString(), supplyBlock: 5 },
  ])
    await assert.rejects(
      observe("discovery:supply-forged", forged),
      /Invalid launch supply/,
    );
});

test("walk-back restores amounts beyond double precision to the wei", async (t) => {
  const db = await setup(t);
  await writer(db);
  // 1 ETH and 3 wei, 7 tokens and a remainder: none of it survives a float.
  const odd = E + 3n;
  await applyLedgerBatch(
    db,
    batch(base, base + 9, [trade(base + 5, "buy", odd, 10n ** 21n + 7n)]),
  );
  const exact = async () =>
    (
      await db.query(
        `SELECT p.cost_wei::text AS cost,p.quantity_raw::text AS quantity,h.volume_wei::text AS volume,
           s.volume_wei::text AS pool_volume,h.spent_wei::text AS spent
         FROM agg_positions p JOIN agg_wallet_hours h USING (wallet_ref,pool_ref) JOIN agg_pool_state s USING (pool_ref)`,
      )
    ).rows;
  const before = await exact();
  assert.deepEqual(before, [
    {
      cost: odd.toString(),
      quantity: (10n ** 21n + 7n).toString(),
      volume: odd.toString(),
      pool_volume: odd.toString(),
      spent: odd.toString(),
    },
  ]);
  await applyLedgerBatch(
    db,
    batch(base + 10, base + 19, [
      trade(base + 12, "sell", E + 11n, 3n),
      trade(base + 13, "buy", E + 13n, 5n),
    ]),
  );
  assert.notDeepEqual(await exact(), before);
  await walkBackLedger(db, base + 9);
  assert.deepEqual(await exact(), before);
});
