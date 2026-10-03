import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type {
  AnalyticsWalletPosition,
  AnalyticsWalletResponse,
  WalletPositionResponse,
} from "@pools/core";
import {
  acquireLedgerWriter,
  applyLedgerBatch,
  commitBatch,
  createClient,
  ensureDiscovery,
  ensureLedgerStream,
  migrate,
  refreshLedgerWindows,
  releaseLedgerWriter,
} from "../../../packages/db/src/index";
import {
  addr,
  base,
  batch,
  blockOf,
  E,
  hash,
  pools,
  Rows,
  sqrtQ,
  tenth,
  ts,
  W,
  wallet,
} from "./ledger-wallet-fixture";
import { createReader } from "./reader";
import { createApi } from "./server";

// The single-position read serves the wallet page's row for one pool with
// the mark, ROI, cycles and trading times beside it, so its fixture is the
// wallet page's: trades applied through the ledger writer, every figure
// below derived by hand from them (`ledger-wallet-fixture.ts`).
test(
  "Postgres HTTP: GET /v1/wallets/:address/positions/:poolId serves one ledger position, the wallet page's row for that pool with the mark, ROI, cycles and trading times beside it, hand-checked, and refuses what the ledger cannot vouch for",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const db = createClient(url);
    await db.connect();
    const schema =
      "api_test_ledgerposition_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    await commitBatch(db, await ensureDiscovery(db, 10), {
      from: 10,
      to: 19,
      hash: hash(19),
      evidence: {},
      pools: [pools.P, pools.Q, pools.R],
    });
    const readers = {
      broad: createReader(url, schema),
      ledger: createReader(url, schema, { marketSource: "ledger" }),
    };
    const bases: Record<string, string> = {};
    const servers: ReturnType<typeof createApi>[] = [];
    for (const [name, reader] of Object.entries(readers)) {
      const api = createApi(reader, { cacheMs: 0, maxPerMinute: 100000 });
      await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
      bases[name] =
        `http://127.0.0.1:${(api.address() as { port: number }).port}`;
      servers.push(api);
    }
    let locked = false;
    t.after(async () => {
      for (const api of servers)
        await new Promise<void>((resolve) => api.close(() => resolve()));
      for (const reader of Object.values(readers)) await reader.close();
      if (locked) await releaseLedgerWriter(db);
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    const get = async (source: "broad" | "ledger", path: string) => {
      const response = await fetch(bases[source] + path);
      return {
        status: response.status,
        data: JSON.parse(await response.text()),
        headers: response.headers,
      };
    };
    const position = (
      source: "broad" | "ledger",
      address: string,
      poolId: string,
      query = "",
    ) => get(source, `/v1/wallets/${address}/positions/${poolId}${query}`);
    const read = async (address: string, poolId: string, window: string) => {
      const { status, data } = await position(
        "ledger",
        address,
        poolId,
        `?window=${window}`,
      );
      assert.equal(
        status,
        200,
        `${address} ${poolId} ${window} ${JSON.stringify(data)}`,
      );
      return data as WalletPositionResponse;
    };
    const pageRow = async (address: string, poolId: string, window: string) => {
      const { status, data } = await get(
        "ledger",
        `/v1/wallets/${address}?window=${window}`,
      );
      assert.equal(status, 200, `${address} ${window} ${JSON.stringify(data)}`);
      return (data as AnalyticsWalletResponse).positions.find(
        (p) => p.poolId === poolId,
      );
    };
    const unavailable = {
      status: 503,
      data: { error: "position_coverage_unavailable" },
    };

    // A read the ledger cannot answer is refused, never served from the
    // frozen accounting tables: with no ledger at all, with a stream but no
    // cursor, and on the broad source whatever the ledger holds.
    for (const source of ["broad", "ledger"] as const)
      assert.deepEqual(
        { ...(await position(source, W[1], pools.P.id)), headers: undefined },
        { ...unavailable, headers: undefined },
        source,
      );
    await ensureLedgerStream(db, "tip");
    assert.equal((await position("ledger", W[1], pools.P.id)).status, 503);
    // The route names the wallet and the pool page's own 32-byte pool id,
    // takes a window and nothing else, and has no singular alias.
    assert.deepEqual((await position("ledger", W[1], "0x12")).data, {
      error: "not_found",
    });
    assert.deepEqual(
      (await get("ledger", `/v1/wallet/${W[1]}/positions/${pools.P.id}`)).data,
      { error: "not_found" },
    );
    assert.deepEqual(
      (await position("ledger", W[1], pools.P.id, "?window=2d")).data,
      { error: "invalid_window" },
    );
    assert.deepEqual(
      (await position("ledger", W[1], pools.P.id, "?limit=5")).data,
      { error: "invalid_parameter" },
    );

    // The ledger writer lock is one per database; a sibling test file may
    // hold it.
    for (let i = 0; i < 600 && !locked; i++) {
      locked = await acquireLedgerWriter(db);
      if (!locked) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(locked, "ledger writer lock unavailable");

    // The cursor sits mid-hour in hour 1078, so the windows are the whole
    // hours 1055-1078 (24h), 911-1078 (7d) and everything since hour 278
    // (All). Amounts in tenths of an ETH.
    const cursor1 = blockOf(1078, 4);
    const rows = new Rows()
      // W1 in P: 10 tokens for 1 ETH in hour 1050, sold for 1.5 ETH in hour
      // 1060: one cycle closed at a 0.5 ETH gain on 1 ETH of disposed cost,
      // held the 90 blocks of 400 s between the two swaps.
      .trade(blockOf(1050, 0), W[1], "buy", E, 10n)
      .trade(blockOf(1060, 0), W[1], "sell", 15n * tenth, 10n)
      // W1 in Q: 40 tokens for 2 ETH in hour 1075, the pool's last swap
      // leaving its price at 2^56 wei per raw unit: an open cycle.
      .trade(blockOf(1075, 0), W[1], "buy", 2n * E, 40n, pools.Q, sqrtQ)
      // W2 in R: 10 tokens for 1 ETH in hour 1000, inside 7d and out of
      // 24h; R's decimals are unknown, so the holding cannot be marked.
      .trade(blockOf(1000, 0), W[2], "buy", E, 10n, pools.R)
      // W3 in R: 10 tokens for 1 ETH in hour 990, sold for 1.2 ETH in hour
      // 995, before W2's buy sets R's price: a flat position in a pool whose
      // decimals are unknown.
      .trade(blockOf(990, 0), W[3], "buy", E, 10n, pools.R)
      .trade(blockOf(995, 0), W[3], "sell", 12n * tenth, 10n, pools.R)
      // W6 sells 7 Q it never bought in hour 1074: the position is excluded
      // (unknown_basis), its 0.9 ETH of proceeds is volume only.
      .trade(blockOf(1074, 1), W[6], "sell", 9n * tenth, 7n, pools.Q);
    const applied = await applyLedgerBatch(db, batch(base, cursor1, rows));
    assert.equal(applied.unattributed, 0);
    // Folded but not yet refreshed into windows: nothing to stand on, said
    // retryably, as the wallet page says it.
    assert.deepEqual((await position("ledger", W[1], pools.P.id)).data, {
      error: "position_refresh_pending",
    });
    assert.ok(await refreshLedgerWindows(db));
    assert.deepEqual(
      { ...(await position("broad", W[1], pools.P.id)), headers: undefined },
      { ...unavailable, headers: undefined },
    );

    // Unknown pool, wallet or position: 404 in the api's usual shape. A
    // wallet the ledger never saw is not an empty position.
    assert.deepEqual((await position("ledger", W[1], hash(0x999))).data, {
      error: "pool_not_indexed",
    });
    assert.deepEqual((await position("ledger", wallet(99), pools.P.id)).data, {
      error: "wallet_not_found",
    });
    assert.deepEqual((await position("ledger", W[1], pools.R.id)).data, {
      error: "position_not_found",
    });
    assert.equal((await position("ledger", W[1], hash(0x999))).status, 404);
    assert.equal(
      (await position("ledger", wallet(99), pools.P.id)).status,
      404,
    );
    assert.equal((await position("ledger", W[1], pools.R.id)).status, 404);
    // A catalog whose recent and indexed rows name a pool differently fails
    // closed, as the pool route does.
    await db.query(
      "INSERT INTO recent_streams(chain_id,stream_key,start_block) VALUES(4663,'discovery',0)",
    );
    await db.query(
      "INSERT INTO recent_batches(chain_id,stream_key,from_block,to_block,block_hash,to_timestamp,content_hash,evidence) VALUES(4663,'discovery',10,19,$1,100,'test','{}')",
      [hash(19)],
    );
    await db.query(
      `INSERT INTO recent_pools(chain_id,pool_id,token,name,symbol,launch_block,launch_tx,launch_sender,launched_at,source_batch)
       SELECT chain_id,pool_id,$2,name,symbol,launch_block,launch_tx,launch_sender,launched_at,19
       FROM indexed_pools WHERE pool_id=$1`,
      [pools.Q.id, addr(0x999)],
    );
    assert.deepEqual(
      await position("ledger", W[1], pools.P.id).then(({ status, data }) => ({
        status,
        data,
      })),
      { status: 503, data: { error: "catalog_identity_conflict" } },
    );
    await db.query(
      "DELETE FROM recent_streams WHERE chain_id=4663 AND stream_key='discovery'",
    );

    // W1 in P, closed: the response's fields, the wallet page's row for the
    // pool, the mark of a flat position, the ledger's ROI on the 1 ETH
    // disposed (the total return equals it: invested is disposed cost on a
    // flat position), its one closed cycle and its two trading hours.
    const p1 = await read(W[1], pools.P.id, "All");
    assert.deepEqual(Object.keys(p1).sort(), [
      "avgEntryPriceWei",
      "coverage",
      "cycles",
      "mark",
      "pool",
      "position",
      "roi",
      "totalRoi",
      "wallet",
      "window",
    ]);
    assert.deepEqual(
      { ...p1.coverage, generatedAt: "-" },
      {
        catalogPools: 3,
        processedPools: 3,
        asOf: ts(cursor1),
        oldestAsOf: ts(cursor1),
        generatedAt: "-",
        complete: false,
        registryExhaustive: false,
        pnlScope: "attributed_positions_all_pools",
      },
    );
    assert.deepEqual([p1.window, p1.wallet], ["All", W[1]]);
    assert.deepEqual(p1.pool, {
      id: pools.P.id,
      token: pools.P.token,
      name: "Pool P",
      symbol: "P",
      launchBlock: 10,
      launchTx: pools.P.launchTx,
      launchSender: pools.P.launchSender,
      launchedAt: 100,
      launchType: "instant",
    });
    const positionP = {
      poolId: pools.P.id,
      token: pools.P.token,
      symbol: "P",
      decimals: 18,
      launchTx: pools.P.launchTx,
      asOf: ts(cursor1),
      throughBlock: cursor1,
      supported: true,
      flags: [],
      realizedWei: (5n * tenth).toString(),
      unrealizedWei: "0",
      netWei: (5n * tenth).toString(),
      volumeWei: (25n * tenth).toString(),
      position: {
        poolId: pools.P.id,
        trader: W[1],
        quantity: "0",
        costWei: "0",
        realizedWei: (5n * tenth).toString(),
        investedWei: E.toString(),
        proceedsWei: (15n * tenth).toString(),
        buys: 1,
        sells: 1,
        boughtRaw: "10",
        soldRaw: "10",
        flags: [],
        realizations: [],
        openedAt: null,
        firstHour: 1050 * 3600,
        lastHour: 1060 * 3600,
      },
    } satisfies AnalyticsWalletPosition;
    assert.deepEqual(p1.position, positionP);
    // P's price state is the sale's: sqrt 1000, 2^192 * 10^18 / 10^6 wei
    // per whole token, and the flat position's units fetch nothing.
    const saleP = blockOf(1060, 0);
    assert.deepEqual(p1.mark, {
      sqrtPriceX96: "1000",
      priceWei: ((2n ** 192n * 10n ** 18n) / 1000000n).toString(),
      block: saleP,
      timestamp: ts(saleP),
      txHash: hash(BigInt(saleP) * 100000n),
      valueWei: "0",
    });
    assert.deepEqual(
      [p1.roi, p1.totalRoi, p1.avgEntryPriceWei],
      [50, 50, null],
    );
    assert.deepEqual(p1.cycles, {
      openedAt: null,
      openHoldSeconds: null,
      closures: 1,
      holdSeconds: 90 * 400,
    });
    // The window scopes the row's own figures only: in the 24h window the
    // sale's 1.5 ETH is the net and the volume, the buy being outside it;
    // the ROI, the cycles and the times are the position's whole history.
    const p1day = await read(W[1], pools.P.id, "24h");
    assert.deepEqual(p1day.position, {
      ...positionP,
      netWei: (15n * tenth).toString(),
      volumeWei: (15n * tenth).toString(),
    });
    assert.deepEqual(
      [
        p1day.window,
        p1day.roi,
        p1day.totalRoi,
        p1day.avgEntryPriceWei,
        p1day.cycles,
      ],
      ["24h", 50, 50, null, p1.cycles],
    );
    assert.deepEqual(p1day.mark, p1.mark);

    // W1 in Q, open: the held units marked at 2^56 wei each, so the mark's
    // value is 40 x 2^56 wei against the 2 ETH cost; nothing disposed, so no
    // ROI, and the total return is that unrealized gain over the 2 ETH
    // invested, 44.1151 percent truncated; an open cycle since the buy.
    const buyQ = blockOf(1075, 0);
    const unrealizedQ = 40n * 2n ** 56n - 2n * E;
    const q1 = await read(W[1], pools.Q.id, "All");
    assert.deepEqual(q1.position, {
      poolId: pools.Q.id,
      token: pools.Q.token,
      symbol: "Q",
      decimals: 18,
      launchTx: pools.Q.launchTx,
      asOf: ts(cursor1),
      throughBlock: cursor1,
      supported: true,
      flags: [],
      realizedWei: "0",
      unrealizedWei: unrealizedQ.toString(),
      netWei: (-2n * E).toString(),
      volumeWei: (2n * E).toString(),
      position: {
        poolId: pools.Q.id,
        trader: W[1],
        quantity: "40",
        costWei: (2n * E).toString(),
        realizedWei: "0",
        investedWei: (2n * E).toString(),
        proceedsWei: "0",
        buys: 1,
        sells: 0,
        boughtRaw: "40",
        soldRaw: "0",
        flags: [],
        realizations: [],
        openedAt: ts(buyQ),
        firstHour: 1075 * 3600,
        lastHour: 1075 * 3600,
      },
    } satisfies AnalyticsWalletPosition);
    assert.deepEqual(q1.mark, {
      sqrtPriceX96: sqrtQ,
      priceWei: (2n ** 56n * 10n ** 18n).toString(),
      block: buyQ,
      timestamp: ts(buyQ),
      txHash: hash(BigInt(buyQ) * 100000n),
      valueWei: (40n * 2n ** 56n).toString(),
    });
    assert.equal(unrealizedQ, 882303761517117440n);
    assert.deepEqual([q1.roi, q1.totalRoi], [null, 44.1151]);
    // The entry price of the held units: 2 ETH over 40 raw units, per whole
    // token of 18 decimals, 5 x 10^34 wei; the open cycle has been held the
    // 31 blocks from the buy to the cursor.
    assert.equal(q1.avgEntryPriceWei, (5n * 10n ** 34n).toString());
    assert.equal(cursor1 - buyQ, 31);
    assert.deepEqual(q1.cycles, {
      openedAt: ts(buyQ),
      openHoldSeconds: 31 * 400,
      closures: 0,
      holdSeconds: 0,
    });

    // W2 in R, held but unmarked: the pool has a price state but no known
    // decimals, so no price per token, no value, no unrealized and no total
    // return; nothing is filled in.
    const buyR = blockOf(1000, 0);
    const r2 = await read(W[2], pools.R.id, "7d");
    assert.deepEqual(r2.position, {
      poolId: pools.R.id,
      token: pools.R.token,
      symbol: "R",
      decimals: null,
      launchTx: pools.R.launchTx,
      asOf: ts(cursor1),
      throughBlock: cursor1,
      supported: true,
      flags: [],
      realizedWei: "0",
      unrealizedWei: null,
      netWei: (-E).toString(),
      volumeWei: E.toString(),
      position: {
        poolId: pools.R.id,
        trader: W[2],
        quantity: "10",
        costWei: E.toString(),
        realizedWei: "0",
        investedWei: E.toString(),
        proceedsWei: "0",
        buys: 1,
        sells: 0,
        boughtRaw: "10",
        soldRaw: "0",
        flags: [],
        realizations: [],
        openedAt: ts(buyR),
        firstHour: 1000 * 3600,
        lastHour: 1000 * 3600,
      },
    } satisfies AnalyticsWalletPosition);
    assert.deepEqual(r2.mark, {
      sqrtPriceX96: "1000",
      priceWei: null,
      block: buyR,
      timestamp: ts(buyR),
      txHash: hash(BigInt(buyR) * 100000n),
      valueWei: null,
    });
    assert.deepEqual(
      [r2.roi, r2.totalRoi, r2.avgEntryPriceWei],
      [null, null, null],
    );
    assert.deepEqual(r2.cycles, {
      openedAt: ts(buyR),
      openHoldSeconds: ts(cursor1) - ts(buyR),
      closures: 0,
      holdSeconds: 0,
    });

    // W3 in R, flat in a pool with unknown decimals: the page's zero mark,
    // which needs no price, so the value and the total return are served,
    // while nothing is priced per whole token.
    const r3 = await read(W[3], pools.R.id, "All");
    assert.equal(r3.position.unrealizedWei, "0");
    assert.deepEqual(r3.mark, { ...r2.mark, valueWei: "0" });
    assert.deepEqual(
      [r3.roi, r3.totalRoi, r3.avgEntryPriceWei],
      [20, 20, null],
    );

    // W6 in Q, excluded: the flag and the volume, null for every finance and
    // for the fold's state, as the page serves it; the pool's price state is
    // the pool's and stays, but the excluded position's value, returns and
    // cycles are not served.
    const q6 = await read(W[6], pools.Q.id, "All");
    assert.deepEqual(q6.position, {
      poolId: pools.Q.id,
      token: pools.Q.token,
      symbol: "Q",
      decimals: 18,
      launchTx: pools.Q.launchTx,
      asOf: ts(cursor1),
      throughBlock: cursor1,
      supported: false,
      flags: ["unknown_basis"],
      realizedWei: null,
      unrealizedWei: null,
      netWei: null,
      volumeWei: (9n * tenth).toString(),
      position: null,
    } satisfies AnalyticsWalletPosition);
    assert.deepEqual(q6.mark, { ...q1.mark, valueWei: null });
    assert.deepEqual(
      [q6.roi, q6.totalRoi, q6.avgEntryPriceWei, q6.cycles],
      [null, null, null, null],
    );

    // Field parity: `position` is the wallet page's row for the pool, byte
    // for byte, on every window, so a consumer of the page reuses its type.
    for (const [address, poolId] of [
      [W[1], pools.P.id],
      [W[1], pools.Q.id],
      [W[2], pools.R.id],
      [W[3], pools.R.id],
      [W[6], pools.Q.id],
    ] as const)
      for (const window of ["1h", "6h", "24h", "7d", "30d", "All"])
        assert.deepEqual(
          (await read(address, poolId, window)).position,
          await pageRow(address, poolId, window),
          `${address} ${poolId} ${window}`,
        );

    await db.query(
      `INSERT INTO analytics_pool_snapshots(chain_id,pool_id,through_block,through_hash,asof_timestamp,snapshot,source_kind)
       VALUES(4663,$1,$2,$3,$4,$5,'rpc_capture')`,
      [
        pools.Q.id,
        cursor1,
        hash(cursor1),
        ts(cursor1),
        {
          schemaVersion: 1,
          chainId: 4663,
          toBlock: cursor1,
          blockHash: hash(cursor1),
          toTimestamp: ts(cursor1),
          markets: [{ id: pools.Q.id, decimals: 6 }],
        },
      ],
    );
    // A verified snapshot inside the cut that disagrees with the indexed
    // decimals withholds only the figures per whole token: the wei mark does
    // not depend on the decimals, so the row stays the page's, and the value
    // and the total return follow it.
    const conflicted = await read(W[1], pools.Q.id, "All");
    assert.deepEqual(conflicted.position, q1.position);
    assert.deepEqual(
      conflicted.position,
      await pageRow(W[1], pools.Q.id, "All"),
    );
    assert.deepEqual(conflicted.mark, { ...q1.mark, priceWei: null });
    assert.deepEqual(
      [conflicted.roi, conflicted.totalRoi, conflicted.avgEntryPriceWei],
      [null, 44.1151, null],
    );
    await db.query(
      "DELETE FROM analytics_pool_snapshots WHERE chain_id=4663 AND pool_id=$1",
      [pools.Q.id],
    );

    // Caching is the wallet page's: never stored by a shared cache, served
    // through the in-process cache.
    const response = await fetch(
      `${bases.ledger}/v1/wallets/${W[1]}/positions/${pools.P.id}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-data-cache"), "MISS");
    await response.text();

    // One more batch moves the cursor into hour 1079: the cut follows it on
    // the position and on the coverage, and the row still equals the page's.
    const cursor2 = cursor1 + 9;
    await applyLedgerBatch(db, batch(cursor1 + 1, cursor2, new Rows()));
    assert.ok(await refreshLedgerWindows(db, { minIntervalMs: 0 }));
    const later = await read(W[1], pools.P.id, "24h");
    assert.deepEqual(
      [
        later.coverage.asOf,
        later.position.asOf,
        later.position.throughBlock,
        later.roi,
        later.cycles,
      ],
      [ts(cursor2), ts(cursor2), cursor2, 50, p1.cycles],
    );
    assert.deepEqual(later.position, await pageRow(W[1], pools.P.id, "24h"));
    const laterQ = await read(W[1], pools.Q.id, "All");
    assert.deepEqual(
      [
        laterQ.cycles!.openedAt,
        laterQ.cycles!.openHoldSeconds,
        laterQ.avgEntryPriceWei,
      ],
      [ts(buyQ), 40 * 400, q1.avgEntryPriceWei],
    );
    await db.query(
      `UPDATE agg_positions SET cycle_opened_at=$1
       WHERE chain_id=4663 AND pool_ref=(SELECT pool_ref FROM indexed_pools WHERE pool_id=$2)
       AND wallet_ref=(SELECT wallet_ref FROM agg_wallets WHERE address=decode($3,'hex'))`,
      [ts(cursor2) + 10, pools.Q.id, W[1].slice(2)],
    );
    const backwards = await read(W[1], pools.Q.id, "All");
    assert.equal(backwards.cycles?.openHoldSeconds, 0);
  },
);
