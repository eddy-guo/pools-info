import pg from "pg";
import { BlockscoutError } from "./blockscout-error";

/** The readers of the explorer key, each with its own daily allocation. */
export type CreditConsumer = "history" | "following" | "census";
export interface CreditAdmission {
  consumer: CreditConsumer;
  /** Share of the day's shared budget this call leaves for other readers:
   * past it the call is refused without reaching the explorer. */
  reserveShare?: number;
}
export const creditBudgetPolicy = Object.freeze({
  /** The credential's name in the budget table: the row is keyed by it,
   * never by the key's value, so a rotated key inherits the day's spend. */
  name: "blockscout",
  /** Never spend the key's account under this stated balance: the census's
   * floor, now held by every reader. `BLOCKSCOUT_CREDIT_FLOOR` overrides. */
  creditFloor: 30000,
  /** The most each consumer may spend of the day's shared budget. The public
   * history route, which any caller can drive, gets half; Following and the
   * census keep their four fifths (each also leaves the last fifth to the
   * others through its own reserve share). */
  consumerShare: Object.freeze({
    history: 0.5,
    following: 0.8,
    census: 0.8,
  }) as Readonly<Record<CreditConsumer, number>>,
});

export interface CreditBudgetRow {
  /** Credits of every attempted call so far, failures included. */
  spent: number;
  /** Credits of calls admitted and not yet settled. */
  reserved: number;
  consumers: Record<string, { spent: number; reserved: number }>;
  /** The key's balance as the explorer last stated it, lowered by every
   * attempt since; null before any answer carried it today. */
  accountRemaining: number | null;
  /** Epoch milliseconds of that answer. */
  accountObservedAt: number | null;
}
/** Where the budget rows live. `update` applies `change` to the day's row
 * under a lock that serializes every process sharing the store, creating the
 * row on first use, and answers the row as it stands afterwards; a `change`
 * returning null writes nothing. */
export interface CreditBudgetStore {
  update(
    name: string,
    day: string,
    change: (row: CreditBudgetRow) => CreditBudgetRow | null,
  ): Promise<CreditBudgetRow>;
  close(): Promise<void>;
}
const emptyRow = (): CreditBudgetRow => ({
  spent: 0,
  reserved: 0,
  consumers: {},
  accountRemaining: null,
  accountObservedAt: null,
});

/** One process's own rows: tests, and never a deployment, since a restart
 * forgets them. */
export function createMemoryCreditBudgetStore(): CreditBudgetStore {
  const rows = new Map<string, CreditBudgetRow>();
  return {
    async update(name, day, change) {
      const key = `${name}\n${day}`;
      const row = rows.get(key) ?? emptyRow();
      const next = change(structuredClone(row));
      if (next) rows.set(key, next);
      return structuredClone(next ?? row);
    },
    async close() {},
  };
}

/** The rows in Postgres (`explorer_credit_budget`, migration 027), read and
 * written on the budget's own small pool, never on the api's READ ONLY
 * reader connections. One statement each to ensure, lock, and write the
 * day's row, in one short transaction. */
export function createCreditBudgetStore(
  url = process.env.DATABASE_URL,
  testSchema?: string,
): CreditBudgetStore {
  if (!url) throw Error("DATABASE_URL is required");
  if (testSchema && !/^api_test_[a-z0-9_]+$/.test(testSchema))
    throw Error("Invalid test schema");
  const pool = new pg.Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    query_timeout: 4000,
    application_name: "pools-read-api-budget",
    ...(testSchema ? { options: `-c search_path=${testSchema}` } : {}),
  });
  pool.on("error", () =>
    process.stderr.write('{"event":"idle_database_connection_error"}\n'),
  );
  return {
    async update(name, day, change) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO explorer_credit_budget(name,day) VALUES ($1,$2::date) ON CONFLICT (name,day) DO NOTHING",
          [name, day],
        );
        const { rows } = await client.query(
          `SELECT spent,reserved,consumers,account_remaining,
             (extract(epoch FROM account_observed_at)*1000)::bigint AS observed_at
           FROM explorer_credit_budget WHERE name=$1 AND day=$2::date FOR UPDATE`,
          [name, day],
        );
        const row: CreditBudgetRow = {
          spent: rows[0].spent,
          reserved: rows[0].reserved,
          consumers: rows[0].consumers,
          accountRemaining: rows[0].account_remaining,
          accountObservedAt:
            rows[0].observed_at === null ? null : Number(rows[0].observed_at),
        };
        const next = change(structuredClone(row));
        if (next)
          await client.query(
            `UPDATE explorer_credit_budget SET spent=$3,reserved=$4,consumers=$5::jsonb,
               account_remaining=$6,account_observed_at=to_timestamp($7::double precision/1000),updated_at=now()
             WHERE name=$1 AND day=$2::date`,
            [
              name,
              day,
              next.spent,
              next.reserved,
              JSON.stringify(next.consumers),
              next.accountRemaining,
              next.accountObservedAt,
            ],
          );
        await client.query("COMMIT");
        return next ?? row;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
export function secondsToUtcMidnight(t: number): number {
  return Math.max(1, Math.ceil((86400000 - (t % 86400000)) / 1000));
}

export interface CreditReservation {
  /** The call was attempted, whatever it answered: its cost is spent, and
   * the balance the answer stated, if any, becomes the shared account view
   * unless a newer answer already did. */
  settle(observed: { remaining: number | null; at: number }): Promise<void>;
  /** The call was never attempted: the reservation is given back. */
  release(): Promise<void>;
}
export interface CreditBudget {
  /** Admits one call of `cost` credits or throws `budget_exhausted` (the
   * shared cap, the consumer's allocation or the account floor, until UTC
   * midnight) or `budget_unavailable` (the store did not answer; nothing is
   * spent without a reservation). */
  reserve(cost: number, admission: CreditAdmission): Promise<CreditReservation>;
  /** The day's row as this process last saw it: another process's spend
   * shows once this one next reserves or settles. */
  snapshot(): {
    day: string;
    spent: number;
    reserved: number;
    dailyCap: number;
    remaining: number | null;
    consumers: CreditBudgetRow["consumers"];
  };
}

/** The credential's daily credit budget: every attempted call reserves its
 * cost on the day's shared row before it is made, so two processes holding
 * the key (a rolling deploy, a one-off job) count against one cap and a
 * restart forgets nothing. The row also carries the explorer's own stated
 * balance, lowered by every attempt since it was stated: below the floor no
 * reader spends, from any process, and an answer without the header only
 * ever lowers the view. */
export function createCreditBudget({
  dailyCap,
  store = createMemoryCreditBudgetStore(),
  name = creditBudgetPolicy.name,
  creditFloor = creditBudgetPolicy.creditFloor,
  consumerShare = creditBudgetPolicy.consumerShare,
  now = Date.now,
  log = (event) => process.stderr.write(JSON.stringify(event) + "\n"),
}: {
  dailyCap: number;
  store?: CreditBudgetStore;
  name?: string;
  creditFloor?: number;
  consumerShare?: Readonly<Record<CreditConsumer, number>>;
  now?: () => number;
  log?: (event: Record<string, unknown>) => void;
}): CreditBudget {
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1)
    throw Error("Invalid daily credit cap");
  if (!Number.isSafeInteger(creditFloor) || creditFloor < 0)
    throw Error("Invalid credit floor");
  let last: { day: string; row: CreditBudgetRow } | null = null;
  const consumerOf = (row: CreditBudgetRow, consumer: string) =>
    row.consumers[consumer] ?? { spent: 0, reserved: 0 };
  const code = (error: unknown) =>
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : null;
  async function write(
    event: string,
    day: string,
    change: (row: CreditBudgetRow) => CreditBudgetRow | null,
  ) {
    try {
      last = { day, row: await store.update(name, day, change) };
    } catch (error) {
      // A settle or release that fails leaves the reservation counted for
      // the day, which refuses more and never spends more.
      log({ event, code: code(error) });
    }
  }
  return {
    async reserve(cost, { consumer, reserveShare = 0 }) {
      if (!Number.isSafeInteger(cost) || cost < 1) throw Error("Invalid cost");
      if (!(reserveShare >= 0 && reserveShare <= 1))
        throw Error("Invalid reserve share");
      const share = consumerShare[consumer];
      if (!(share >= 0 && share <= 1)) throw Error("Unknown consumer");
      const t = now();
      const day = utcDay(t);
      const reserve = Math.ceil(dailyCap * reserveShare);
      const limit = Math.floor(dailyCap * share);
      let refused = false;
      let row: CreditBudgetRow;
      try {
        row = await store.update(name, day, (r) => {
          const own = consumerOf(r, consumer);
          if (
            (r.accountRemaining !== null &&
              r.accountRemaining - cost < creditFloor) ||
            r.spent + r.reserved + cost + reserve > dailyCap ||
            own.spent + own.reserved + cost > limit
          ) {
            refused = true;
            return null;
          }
          return {
            ...r,
            reserved: r.reserved + cost,
            consumers: {
              ...r.consumers,
              [consumer]: { ...own, reserved: own.reserved + cost },
            },
            accountRemaining:
              r.accountRemaining === null
                ? null
                : Math.max(0, r.accountRemaining - cost),
          };
        });
      } catch (error) {
        log({ event: "explorer_budget_unavailable", code: code(error) });
        throw new BlockscoutError("budget_unavailable", 30);
      }
      last = { day, row };
      if (refused)
        throw new BlockscoutError("budget_exhausted", secondsToUtcMidnight(t));
      return {
        settle: ({ remaining, at }) =>
          write("explorer_budget_settle_failed", day, (r) => {
            const own = consumerOf(r, consumer);
            const newer =
              remaining !== null &&
              (r.accountObservedAt === null || at >= r.accountObservedAt);
            return {
              ...r,
              spent: r.spent + cost,
              reserved: Math.max(0, r.reserved - cost),
              consumers: {
                ...r.consumers,
                [consumer]: {
                  spent: own.spent + cost,
                  reserved: Math.max(0, own.reserved - cost),
                },
              },
              accountRemaining: newer ? remaining : r.accountRemaining,
              accountObservedAt: newer ? at : r.accountObservedAt,
            };
          }),
        release: () =>
          write("explorer_budget_release_failed", day, (r) => {
            const own = consumerOf(r, consumer);
            return {
              ...r,
              reserved: Math.max(0, r.reserved - cost),
              consumers: {
                ...r.consumers,
                [consumer]: {
                  ...own,
                  reserved: Math.max(0, own.reserved - cost),
                },
              },
              accountRemaining:
                r.accountRemaining === null ? null : r.accountRemaining + cost,
            };
          }),
      };
    },
    snapshot() {
      const day = utcDay(now());
      const row = last?.day === day ? last.row : emptyRow();
      return {
        day,
        spent: row.spent,
        reserved: row.reserved,
        dailyCap,
        remaining: row.accountRemaining,
        consumers: structuredClone(row.consumers),
      };
    },
  };
}
