// The leaderboard windows of the aggregate ledger (docs/AGGREGATE-LEDGER.md
// phase 3, design report section 7.3): agg_wallet_windows holds one row per
// wallet per window, summed from the whole UTC hours ending with the ledger
// cursor's hour, with the rank of the top of the board. A full rebuild over
// three million hour rows takes seconds, so after the first build a refresh
// recomputes only the wallets the batches since the last refresh journaled,
// and subtracts the hours that left a window from the rows of the others. A
// walk-back removes the refresh state with its batch, which forces a rebuild.
import { ledgerHour, windows, type LiveWindow } from "@pools/core";
import type { Client } from "./index";
import { assertLedgerWriter, ledgerStream } from "./ledger";

export const ledgerWindowPolicy = Object.freeze({
  windows: ["1h", "6h", "24h", "7d", "30d", "All"] as const,
  /** Eligible for a rank: at least this many supported trades in the window
   * on a supported position (the leaderboard's minTrades). Migration 020's
   * partial index carries the same predicate. */
  minTrades: 10,
  /** Ranks are kept for the top of the board only: the leaderboard serves the
   * top 100 per window and no rank beyond it (captain, 17 Sep 2026). */
  rankedWallets: 100,
  /** A refresh runs at most this often, and whenever the cursor's hour moved. */
  minIntervalMs: 60000,
});
export interface LedgerWindowRefresh {
  window: LiveWindow;
  mode: "rebuilt" | "incremental" | "unchanged";
  windowStart: number;
  /** Rows in the window after the refresh. */
  wallets: number;
  /** Wallets whose row was recomputed, and of those the ones that only had
   * hours leave the window subtracted. */
  recomputed: number;
  subtracted: number;
  ranked: number;
  elapsedMs: number;
}
export interface LedgerWindowsRefreshed {
  throughBlock: number;
  throughTimestamp: number;
  elapsedMs: number;
  windows: LedgerWindowRefresh[];
}
interface RefreshState {
  window: LiveWindow;
  throughBlock: number;
  throughTimestamp: number;
  windowStart: number;
  wallets: number;
  ranked: number;
  ageMs: number;
}

/** The first hour a window sums; All sums every hour. agg_window_refreshes
 * holds each window's current start; a row keeps the start it was last
 * computed at, and its sums are the current window's too, since a wallet with
 * an hour between the two starts is recomputed. */
export function ledgerWindowStart(window: LiveWindow, cursorTimestamp: number) {
  const seconds = windows[window];
  if (seconds === Infinity) return 0;
  return Math.max(0, ledgerHour(cursorTimestamp) - seconds / 3600 + 1);
}

// A window's hour sums per wallet. Its flash closures are unknown while any
// closure in it sits in an hour row written before hold times were folded.
const hourSums = `sum(realized_wei) AS realized,sum(proceeds_wei)-sum(spent_wei) AS net,sum(volume_wei) AS volume,
  sum(disposed_cost_wei) AS disposed,sum(buys+sells)::int AS trades,sum(supported_trades)::int AS supported_trades,
  sum(wins)::int AS wins,sum(losses)::int AS losses,sum(closures)::int AS closures,sum(hold_seconds)::bigint AS hold_seconds,
  coalesce(sum(flash_closures),0)::int AS flash,bool_or(flash_closures IS NULL AND closures>0) AS untimed,max(best_wei) AS best`;
// The wallet's position counts and last activity: the same in every window.
const positionStats = (filter: string, lastAs = "bigint") =>
  `SELECT wallet_ref,count(*) FILTER (WHERE supported AND buys+sells>0)::int AS supported,
     count(*) FILTER (WHERE NOT supported)::int AS excluded,
     (max(last_timestamp) FILTER (WHERE buys+sells>0))::${lastAs} AS last_timestamp
   FROM agg_positions WHERE chain_id=4663${filter} GROUP BY wallet_ref`;
/** Window rows from the hour rows: every wallet (a rebuild), or the wallets
 * in $3 with their position figures given as arrays in $4 to $7. */
const windowRows = (given: boolean) => `
  INSERT INTO agg_wallet_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,trades,supported_trades,wins,losses,closures,hold_seconds,flash_closures,best_wei,last_timestamp,supported_positions,excluded_positions,rank,window_start,refreshed_at)
  SELECT 4663,$1,h.wallet_ref,h.realized,h.net,h.volume,h.disposed,h.trades,h.supported_trades,h.wins,h.losses,h.closures,h.hold_seconds,
    CASE WHEN h.untimed THEN NULL ELSE h.flash END,h.best,p.last_timestamp,coalesce(p.supported,0),coalesce(p.excluded,0),NULL,$2,clock_timestamp()
  FROM (
    SELECT wallet_ref,${hourSums}
    FROM agg_wallet_hours WHERE chain_id=4663 AND hour>=$2${given ? " AND wallet_ref=ANY($3::int[])" : ""}
    GROUP BY wallet_ref
  ) h
  LEFT JOIN ${
    given
      ? "unnest($4::int[],$5::int[],$6::int[],$7::bigint[]) AS p(wallet_ref,supported,excluded,last_timestamp)"
      : `(${positionStats("")}) p`
  } USING (wallet_ref)`;

/** Rank the top of a window: eligible wallets by realized, address breaking
 * ties, kept for the first `rankedWallets` rows and cleared elsewhere. The
 * candidates come off the partial index in one read, and only rows whose rank
 * changes are written, each found by its key, so no plan walks the window. */
async function rankWindow(db: Client, window: LiveWindow) {
  const n = ledgerWindowPolicy.rankedWallets;
  // A literal, so the planner matches migration 020's partial index.
  const eligible = (x: string) =>
    `${x}supported_trades>=${ledgerWindowPolicy.minTrades} AND ${x}supported_positions>0`;
  const top = await db.query(
    `SELECT x.wallet_ref FROM agg_wallet_windows x JOIN agg_wallets w USING (wallet_ref)
     WHERE x.chain_id=4663 AND x."window"=$1 AND ${eligible("x.")}
       AND x.realized_wei>=coalesce((SELECT realized_wei FROM agg_wallet_windows
         WHERE chain_id=4663 AND "window"=$1 AND ${eligible("")} ORDER BY realized_wei DESC OFFSET $2 LIMIT 1),'-Infinity')
     ORDER BY x.realized_wei DESC,w.address LIMIT $3`,
    [window, n - 1, n],
  );
  const refs = top.rows.map((r) => r.wallet_ref as number);
  const ranks = refs.map((_, i) => i + 1);
  await db.query(
    `UPDATE agg_wallet_windows SET rank=NULL
     WHERE chain_id=4663 AND "window"=$1 AND rank IS NOT NULL AND NOT (wallet_ref=ANY($2::int[]))`,
    [window, refs],
  );
  if (refs.length)
    await db.query(
      `UPDATE agg_wallet_windows SET rank=($3::int[])[array_position($2::int[],wallet_ref)]
       WHERE chain_id=4663 AND "window"=$1 AND wallet_ref=ANY($2::int[])
         AND rank IS DISTINCT FROM ($3::int[])[array_position($2::int[],wallet_ref)]`,
      [window, refs, ranks],
    );
  return refs.length;
}

/** Refresh every window to the ledger cursor, under the writer lock and in
 * one transaction, so all six reflect the same cursor. Returns null when
 * nothing is due: the windows already reflect the cursor, or the last refresh
 * is younger than `minIntervalMs` and the cursor's hour has not moved.
 * `force` refreshes whenever the cursor moved; `rebuild` recomputes every
 * window from the hour rows. */
export async function refreshLedgerWindows(
  db: Client,
  options: { minIntervalMs?: number; force?: boolean; rebuild?: boolean } = {},
): Promise<LedgerWindowsRefreshed | null> {
  const minIntervalMs =
    options.minIntervalMs ?? ledgerWindowPolicy.minIntervalMs;
  if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0)
    throw Error("ledger_invalid_window_refresh");
  const started = performance.now();
  await db.query("BEGIN");
  try {
    await assertLedgerWriter(db);
    const locked = await db.query(
      "SELECT cursor_block,cursor_timestamp FROM agg_streams WHERE chain_id=4663 AND stream_key=$1 FOR UPDATE",
      [ledgerStream.key],
    );
    if (!locked.rowCount) throw Error("ledger_stream_missing");
    if (locked.rows[0].cursor_block === null) {
      await db.query("COMMIT");
      return null;
    }
    const cursor = Number(locked.rows[0].cursor_block),
      cursorTimestamp = Number(locked.rows[0].cursor_timestamp);
    const saved = await db.query(
      `SELECT "window",through_block,through_timestamp,window_start,wallets,ranked,
         (extract(epoch FROM clock_timestamp()-refreshed_at)*1000)::bigint AS age_ms
       FROM agg_window_refreshes WHERE chain_id=4663`,
    );
    const states = new Map<LiveWindow, RefreshState>(
      saved.rows.map((r) => [
        r.window,
        {
          window: r.window,
          throughBlock: Number(r.through_block),
          throughTimestamp: Number(r.through_timestamp),
          windowStart: r.window_start,
          wallets: r.wallets,
          ranked: r.ranked,
          ageMs: Number(r.age_ms),
        },
      ]),
    );
    const complete = ledgerWindowPolicy.windows.every((w) => states.has(w));
    const current = [...states.values()].every(
      (s) => s.throughBlock === cursor,
    );
    const hourMoved = [...states.values()].some(
      (s) => ledgerHour(s.throughTimestamp) !== ledgerHour(cursorTimestamp),
    );
    const youngest = Math.min(...[...states.values()].map((s) => s.ageMs));
    if (
      !options.rebuild &&
      complete &&
      (current || (!options.force && youngest < minIntervalMs && !hourMoved))
    ) {
      await db.query("COMMIT");
      return null;
    }
    // The journal names every wallet the batches since a refresh changed; it
    // is whole for them while they are among the newest journalDepth batches.
    const journals = new Map<number, { batches: number; unknown: number }>();
    const journalSince = async (through: number) => {
      if (!journals.has(through)) {
        const r = await db.query(
          "SELECT count(*)::int AS batches,count(*) FILTER (WHERE journal_rows IS NULL)::int AS unknown FROM agg_batches WHERE chain_id=4663 AND stream_key=$1 AND to_block>$2",
          [ledgerStream.key, through],
        );
        journals.set(through, r.rows[0]);
      }
      return journals.get(through)!;
    };
    // The wallets those batches changed, with their position figures read
    // once for every window.
    const touched = new Map<
      number,
      {
        refs: number[];
        stats: {
          wallet_ref: number;
          supported: number;
          excluded: number;
          last_timestamp: string | null;
        }[];
      }
    >();
    const touchedSince = async (through: number) => {
      if (!touched.has(through)) {
        const r = await db.query(
          `SELECT DISTINCT (key->>'wallet_ref')::int AS wallet_ref FROM agg_journal
           WHERE chain_id=4663 AND stream_key=$1 AND batch_end>$2 AND batch_end<=$3 AND "table" IN ('agg_positions','agg_wallet_hours')`,
          [ledgerStream.key, through, cursor],
        );
        const refs = r.rows
          .map((row) => row.wallet_ref as number)
          .sort((a, b) => a - b);
        const stats = refs.length
          ? (
              await db.query(
                positionStats(" AND wallet_ref=ANY($1::int[])", "text"),
                [refs],
              )
            ).rows
          : [];
        touched.set(through, { refs, stats });
      }
      return touched.get(through)!;
    };
    // First every window's rows, then the ranks: a rebuild's statistics
    // are refreshed in between, or the planner would rank a window of
    // hundreds of thousands of rows as if it held none.
    const refreshed: LedgerWindowRefresh[] = [];
    for (const window of ledgerWindowPolicy.windows) {
      const windowStarted = performance.now();
      const windowStart = ledgerWindowStart(window, cursorTimestamp);
      const state = states.get(window);
      let mode: LedgerWindowRefresh["mode"];
      let wallets: number,
        recomputed: number,
        subtracted = 0;
      const journal = state && (await journalSince(state.throughBlock));
      if (
        !options.rebuild &&
        state &&
        state.throughBlock === cursor &&
        state.windowStart === windowStart
      ) {
        mode = "unchanged";
        wallets = state.wallets;
        recomputed = 0;
      } else if (
        !options.rebuild &&
        state &&
        journal &&
        journal.unknown === 0 &&
        journal.batches <= ledgerStream.journalDepth &&
        windowStart >= state.windowStart
      ) {
        mode = "incremental";
        wallets = state.wallets;
        const since = await touchedSince(state.throughBlock);
        recomputed = since.refs.length;
        if (windowStart > state.windowStart) {
          // Hours left the window. A wallet the batches did not touch keeps
          // its rows, so the leaving hours' sums come off its window row;
          // only a wallet whose best sale or whose last unfolded closure sat
          // in them is summed again, and one with no hour left goes.
          const leaving = await db.query(
            `SELECT DISTINCT wallet_ref FROM agg_wallet_hours
             WHERE chain_id=4663 AND hour>=$1 AND hour<$2 AND NOT (wallet_ref=ANY($3::int[]))`,
            [state.windowStart, windowStart, since.refs],
          );
          const left = leaving.rows.map((r) => r.wallet_ref as number);
          const taken = await db.query(
            `WITH gone AS (
               SELECT wallet_ref,${hourSums} FROM agg_wallet_hours
               WHERE chain_id=4663 AND hour>=$2 AND hour<$3 AND wallet_ref=ANY($4::int[]) GROUP BY wallet_ref
             )
             UPDATE agg_wallet_windows x SET realized_wei=x.realized_wei-g.realized,net_wei=x.net_wei-g.net,
               volume_wei=x.volume_wei-g.volume,disposed_cost_wei=x.disposed_cost_wei-g.disposed,trades=x.trades-g.trades,
               supported_trades=x.supported_trades-g.supported_trades,wins=x.wins-g.wins,losses=x.losses-g.losses,
               closures=x.closures-g.closures,hold_seconds=x.hold_seconds-g.hold_seconds,flash_closures=x.flash_closures-g.flash,
               window_start=$3,refreshed_at=clock_timestamp()
             FROM gone g
             WHERE x.chain_id=4663 AND x."window"=$1 AND x.wallet_ref=g.wallet_ref
               AND (g.best IS NULL OR g.best<x.best_wei) AND NOT (x.flash_closures IS NULL AND g.untimed)
             RETURNING x.wallet_ref`,
            [window, state.windowStart, windowStart, left],
          );
          const done = new Set(taken.rows.map((r) => r.wallet_ref));
          subtracted = done.size;
          const summed = left.filter((w) => !done.has(w));
          if (summed.length)
            await db.query(
              `WITH h AS (
                 SELECT wallet_ref,${hourSums} FROM agg_wallet_hours
                 WHERE chain_id=4663 AND hour>=$2 AND wallet_ref=ANY($3::int[]) GROUP BY wallet_ref
               )
               UPDATE agg_wallet_windows x SET realized_wei=h.realized,net_wei=h.net,volume_wei=h.volume,
                 disposed_cost_wei=h.disposed,trades=h.trades,supported_trades=h.supported_trades,wins=h.wins,
                 losses=h.losses,closures=h.closures,hold_seconds=h.hold_seconds,
                 flash_closures=CASE WHEN h.untimed THEN NULL ELSE h.flash END,best_wei=h.best,
                 window_start=$2,refreshed_at=clock_timestamp()
               FROM h WHERE x.chain_id=4663 AND x."window"=$1 AND x.wallet_ref=h.wallet_ref`,
              [window, windowStart, summed],
            );
          const emptied = await db.query(
            `DELETE FROM agg_wallet_windows x
             WHERE x.chain_id=4663 AND x."window"=$1 AND x.wallet_ref=ANY($2::int[])
               AND (x.trades=0 OR (x.wallet_ref=ANY($3::int[]) AND NOT EXISTS (
                 SELECT 1 FROM agg_wallet_hours h WHERE h.chain_id=4663 AND h.wallet_ref=x.wallet_ref AND h.hour>=$4)))`,
            [window, left, summed, windowStart],
          );
          wallets -= emptied.rowCount ?? 0;
          recomputed += left.length;
        }
        if (since.refs.length) {
          const removed = await db.query(
            `DELETE FROM agg_wallet_windows WHERE chain_id=4663 AND "window"=$1 AND wallet_ref=ANY($2::int[])`,
            [window, since.refs],
          );
          const inserted = await db.query(windowRows(true), [
            window,
            windowStart,
            since.refs,
            since.stats.map((p) => p.wallet_ref),
            since.stats.map((p) => p.supported),
            since.stats.map((p) => p.excluded),
            since.stats.map((p) => p.last_timestamp),
          ]);
          wallets += (inserted.rowCount ?? 0) - (removed.rowCount ?? 0);
        }
      } else {
        mode = "rebuilt";
        await db.query("SET LOCAL work_mem='256MB'");
        await db.query(
          `DELETE FROM agg_wallet_windows WHERE chain_id=4663 AND "window"=$1`,
          [window],
        );
        const inserted = await db.query(windowRows(false), [
          window,
          windowStart,
        ]);
        wallets = inserted.rowCount ?? 0;
        recomputed = wallets;
      }
      refreshed.push({
        window,
        mode,
        windowStart,
        wallets,
        recomputed,
        subtracted,
        ranked: state?.ranked ?? 0,
        elapsedMs: Math.round(performance.now() - windowStarted),
      });
    }
    if (refreshed.some((w) => w.mode === "rebuilt"))
      await db.query("ANALYZE agg_wallet_windows");
    for (const w of refreshed) {
      if (w.mode === "unchanged") continue;
      const ranking = performance.now();
      w.ranked = await rankWindow(db, w.window);
      w.elapsedMs += Math.round(performance.now() - ranking);
      await db.query(
        `INSERT INTO agg_window_refreshes(chain_id,stream_key,"window",through_block,through_timestamp,window_start,wallets,ranked,refreshed_at)
         VALUES (4663,$1,$2,$3,$4,$5,$6,$7,clock_timestamp())
         ON CONFLICT (chain_id,"window") DO UPDATE SET stream_key=EXCLUDED.stream_key,through_block=EXCLUDED.through_block,
           through_timestamp=EXCLUDED.through_timestamp,window_start=EXCLUDED.window_start,wallets=EXCLUDED.wallets,
           ranked=EXCLUDED.ranked,refreshed_at=EXCLUDED.refreshed_at`,
        [
          ledgerStream.key,
          w.window,
          cursor,
          cursorTimestamp,
          w.windowStart,
          w.wallets,
          w.ranked,
        ],
      );
    }
    await db.query("COMMIT");
    return {
      throughBlock: cursor,
      throughTimestamp: cursorTimestamp,
      elapsedMs: Math.round(performance.now() - started),
      windows: refreshed,
    };
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
}
