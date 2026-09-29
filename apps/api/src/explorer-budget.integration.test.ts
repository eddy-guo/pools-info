import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  BlockscoutError,
  createBlockscoutClient,
  createRateLimiter,
} from "./blockscout-client";
import {
  createCreditBudget,
  createCreditBudgetStore,
  secondsToUtcMidnight,
  type CreditBudgetStore,
} from "./explorer-budget";
import { createHistoryCursorCodec } from "./history-cursor";
import type { RequestError } from "./request";
import { applyTestMigrations } from "./test-migrations";
import { createTokenRegistry } from "./token-registry";
import { createWalletHistory } from "./wallet-history";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

test(
  "Postgres explorer credit budget: one row per credential and day shared by every process, reserved atomically, kept across restarts, per consumer and under the account floor",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = process.env.TEST_DATABASE_URL!;
    const schema = "api_test_budget_" + randomBytes(8).toString("hex");
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await applyTestMigrations(db);
    const stores: CreditBudgetStore[] = [];
    t.after(async () => {
      await Promise.all(stores.map((s) => s.close()));
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      await db.end();
    });
    let now = Date.parse("2026-09-29T10:00:00Z");
    let remaining: string | null = "90000";
    const fetches: string[] = [];
    const cursors = createHistoryCursorCodec({
      secret: randomBytes(32).toString("hex"),
      now: () => now,
    });
    const registry = createTokenRegistry(async () => []);
    /** One api process: its own pool on the shared rows, its own client. */
    const start = (dailyCap: number) => {
      const store = createCreditBudgetStore(url, schema);
      stores.push(store);
      const client = createBlockscoutClient({
        key: "k",
        budget: createCreditBudget({
          dailyCap,
          store,
          now: () => now,
          log: () => undefined,
        }),
        now: () => now,
        limiter: createRateLimiter({ sleep: async () => {} }),
        fetchImpl: (async (url: URL) => {
          fetches.push(String(url));
          await new Promise((resolve) => setTimeout(resolve, 5));
          return new Response(
            JSON.stringify({ items: [], next_page_params: null }),
            {
              headers:
                remaining === null ? {} : { "x-credits-remaining": remaining },
            },
          );
        }) as typeof fetch,
      });
      return {
        client,
        history: createWalletHistory({
          client,
          cursors,
          registry,
          now: () => now,
        }),
      };
    };
    const row = async (day: string) => {
      const { rows } = await db.query(
        `SELECT spent,reserved,consumers,account_remaining,
           (extract(epoch FROM account_observed_at)*1000)::bigint AS observed_at
         FROM explorer_credit_budget WHERE name='blockscout' AND day=$1::date`,
        [day],
      );
      assert.equal(rows.length, 1);
      return {
        ...rows[0],
        observed_at:
          rows[0].observed_at === null ? null : Number(rows[0].observed_at),
      };
    };
    // Two processes, one day row: cap 200, so the public route may spend 100.
    const a = start(200),
      b = start(200);
    await a.history.read({
      wallet: address(1),
      kind: "transactions",
      cursor: null,
    });
    await b.history.read({
      wallet: address(1),
      kind: "token-transfers",
      cursor: null,
    });
    assert.deepEqual(await row("2026-09-29"), {
      spent: 50,
      reserved: 0,
      consumers: { history: { spent: 50, reserved: 0 } },
      account_remaining: 90000,
      observed_at: now,
    });
    assert.equal(b.client.budget.snapshot().spent, 50);
    // Ten simultaneous reads across both processes against the route's 50
    // credits left: exactly two of 20 are admitted, whichever order the
    // rows are locked in.
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).history.read({
          wallet: address(10 + i),
          kind: "transactions",
          cursor: null,
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
    for (const r of results)
      if (r.status === "rejected")
        assert.equal((r.reason as RequestError).reason, "budget_exhausted");
    assert.equal(fetches.length, 4);
    assert.deepEqual(await row("2026-09-29"), {
      spent: 90,
      reserved: 0,
      consumers: { history: { spent: 90, reserved: 0 } },
      account_remaining: 90000,
      observed_at: now,
    });
    // The public route's allocation is spent; Following's is not, and its
    // reserve share is measured against the shared row.
    const followed = await a.history.refreshTrades(address(2), {
      reserveShare: 0.2,
    });
    assert.equal(followed.stale, false);
    assert.equal(fetches.length, 5);
    assert.deepEqual((await row("2026-09-29")).consumers, {
      history: { spent: 90, reserved: 0 },
      following: { spent: 30, reserved: 0 },
    });
    // A restart: a third process over the same rows continues the count.
    const c = start(200);
    assert.equal(c.client.budget.snapshot().spent, 0);
    await assert.rejects(
      c.history.read({
        wallet: address(3),
        kind: "transactions",
        cursor: null,
      }),
      (e: RequestError) =>
        e.status === 503 &&
        e.reason === "budget_exhausted" &&
        e.retryAfter === secondsToUtcMidnight(now),
    );
    assert.equal(c.client.budget.snapshot().spent, 120);
    assert.equal(fetches.length, 5);
    // The next UTC day: a header under the floor from one process stops the
    // other without a call, from any reader.
    now += 86400000;
    remaining = "29999";
    await a.history.read({
      wallet: address(4),
      kind: "transactions",
      cursor: null,
    });
    assert.equal(fetches.length, 6);
    await assert.rejects(
      b.history.read({
        wallet: address(5),
        kind: "transactions",
        cursor: null,
      }),
      (e: RequestError) => e.reason === "budget_exhausted",
    );
    await assert.rejects(
      b.history.refreshTrades(address(6), { reserveShare: 0.2 }),
      (e: RequestError) => e.reason === "budget_exhausted",
    );
    await assert.rejects(
      c.client.readCode([address(7)], {
        consumer: "census",
        reserveShare: 0.2,
      }),
      (e: unknown) =>
        e instanceof BlockscoutError && e.kind === "budget_exhausted",
    );
    assert.equal(fetches.length, 6);
    assert.equal(b.client.budget.snapshot().remaining, 29999);
    // Answers without the header: the last stated balance, lowered by each
    // attempt since, is what the floor is held against.
    now += 86400000;
    remaining = "30045";
    await a.history.read({
      wallet: address(8),
      kind: "transactions",
      cursor: null,
    });
    remaining = null;
    await b.history.read({
      wallet: address(9),
      kind: "transactions",
      cursor: null,
    });
    await a.history.read({
      wallet: address(10),
      kind: "transactions",
      cursor: null,
    });
    assert.equal((await row("2026-10-01")).account_remaining, 30005);
    await assert.rejects(
      b.history.read({
        wallet: address(11),
        kind: "transactions",
        cursor: null,
      }),
      (e: RequestError) => e.reason === "budget_exhausted",
    );
    assert.equal(fetches.length, 9);
    // The rows gone (the migration not yet applied, or the database away):
    // the route answers the explorer unavailable, and nothing is fetched.
    await db.query("DROP TABLE explorer_credit_budget");
    now += 86400000;
    await assert.rejects(
      a.history.read({
        wallet: address(12),
        kind: "transactions",
        cursor: null,
      }),
      (e: RequestError) =>
        e.status === 503 &&
        e.reason === "upstream_unavailable" &&
        e.retryAfter === 30,
    );
    assert.equal(fetches.length, 9);
  },
);
