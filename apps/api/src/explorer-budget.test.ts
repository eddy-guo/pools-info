import assert from "node:assert/strict";
import test from "node:test";
import { BlockscoutError } from "./blockscout-error";
import { createBlockscoutClient, createRateLimiter } from "./blockscout-client";
import {
  createCreditBudget,
  createMemoryCreditBudgetStore,
  creditBudgetPolicy,
  secondsToUtcMidnight,
  utcDay,
  type CreditBudgetStore,
} from "./explorer-budget";

const wallet = "0x42a68318a6d78644870d3a37ec9e708e3ea904f5";
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const exhausted = (retryAfter?: number) => (e: unknown) =>
  e instanceof BlockscoutError &&
  e.kind === "budget_exhausted" &&
  (retryAfter === undefined || e.retryAfter === retryAfter);

test("the budget reserves each attempted call on the day's shared row, settles or releases it, and refuses at the cap, the consumer's share and the account floor", async () => {
  let now = Date.parse("2026-09-15T23:59:30Z");
  const store = createMemoryCreditBudgetStore();
  const budget = createCreditBudget({
    dailyCap: 100,
    store,
    now: () => now,
    log: () => undefined,
  });
  const day = "2026-09-15";
  assert.equal(utcDay(now), day);
  assert.deepEqual(budget.snapshot(), {
    day,
    spent: 0,
    reserved: 0,
    dailyCap: 100,
    remaining: null,
    consumers: {},
  });
  const first = await budget.reserve(20, { consumer: "history" });
  assert.deepEqual(budget.snapshot(), {
    day,
    spent: 0,
    reserved: 20,
    dailyCap: 100,
    remaining: null,
    consumers: { history: { spent: 0, reserved: 20 } },
  });
  await first.settle({ remaining: 1000, at: now });
  assert.deepEqual(budget.snapshot(), {
    day,
    spent: 20,
    reserved: 0,
    dailyCap: 100,
    remaining: 1000,
    consumers: { history: { spent: 20, reserved: 0 } },
  });
  // A released reservation is given back, the account view included.
  const released = await budget.reserve(30, { consumer: "following" });
  assert.equal(budget.snapshot().remaining, 970);
  assert.equal(budget.snapshot().reserved, 30);
  await released.release();
  assert.deepEqual(budget.snapshot(), {
    day,
    spent: 20,
    reserved: 0,
    dailyCap: 100,
    remaining: 1000,
    consumers: {
      history: { spent: 20, reserved: 0 },
      following: { spent: 0, reserved: 0 },
    },
  });
  // The consumer's share: the public history route has half the day.
  await (
    await budget.reserve(30, { consumer: "history" })
  ).settle({ remaining: null, at: now });
  await assert.rejects(
    budget.reserve(1, { consumer: "history" }),
    exhausted(30),
  );
  // Other readers still are, each up to the reserve share it leaves.
  await (
    await budget.reserve(20, { consumer: "following", reserveShare: 0.2 })
  ).settle({ remaining: null, at: now });
  await assert.rejects(
    budget.reserve(20, { consumer: "following", reserveShare: 0.2 }),
    exhausted(30),
  );
  await (
    await budget.reserve(20, { consumer: "census" })
  ).settle({ remaining: null, at: now });
  await assert.rejects(
    budget.reserve(20, { consumer: "census" }),
    exhausted(30),
  );
  // Answers without the header only lowered the account view.
  assert.deepEqual(budget.snapshot(), {
    day,
    spent: 90,
    reserved: 0,
    dailyCap: 100,
    remaining: 930,
    consumers: {
      history: { spent: 50, reserved: 0 },
      following: { spent: 20, reserved: 0 },
      census: { spent: 20, reserved: 0 },
    },
  });
  // Midnight starts a new row; a call reserved before it settles on its own.
  const late = await budget.reserve(10, { consumer: "following" });
  now = Date.parse("2026-09-16T00:00:00Z");
  assert.deepEqual(budget.snapshot(), {
    day: "2026-09-16",
    spent: 0,
    reserved: 0,
    dailyCap: 100,
    remaining: null,
    consumers: {},
  });
  await late.settle({ remaining: 500, at: now });
  const yesterday = await store.update("blockscout", day, () => null);
  assert.deepEqual(yesterday, {
    spent: 100,
    reserved: 0,
    consumers: {
      history: { spent: 50, reserved: 0 },
      following: { spent: 30, reserved: 0 },
      census: { spent: 20, reserved: 0 },
    },
    accountRemaining: 500,
    accountObservedAt: now,
  });
  assert.equal(budget.snapshot().spent, 0);
  await (
    await budget.reserve(20, { consumer: "history" })
  ).settle({ remaining: null, at: now });
  assert.equal(budget.snapshot().spent, 20);

  // The account floor: the explorer's stated balance, lowered by every
  // attempt since, refuses every reader from any process sharing the rows,
  // and an older answer's header never lifts a newer one.
  const floor = createCreditBudget({
    dailyCap: 100000,
    store,
    now: () => now,
    log: () => undefined,
  });
  assert.equal(creditBudgetPolicy.creditFloor, 30000);
  await (
    await floor.reserve(20, { consumer: "history" })
  ).settle({ remaining: 30050, at: now });
  const a = await floor.reserve(20, { consumer: "history" });
  const b = await floor.reserve(20, { consumer: "history" });
  assert.equal(floor.snapshot().remaining, 30010);
  await b.settle({ remaining: 29995, at: now + 2 });
  await a.settle({ remaining: 60000, at: now + 1 });
  assert.equal(floor.snapshot().remaining, 29995);
  await assert.rejects(
    floor.reserve(20, { consumer: "history" }),
    exhausted(secondsToUtcMidnight(now)),
  );
  const other = createCreditBudget({
    dailyCap: 100000,
    store,
    now: () => now,
    log: () => undefined,
  });
  await assert.rejects(other.reserve(20, { consumer: "census" }), exhausted());
  assert.equal(other.snapshot().remaining, 29995);
  // Nothing probes past the floor: the next UTC day starts over.
  now += 86400000;
  await (
    await other.reserve(20, { consumer: "census" })
  ).settle({ remaining: null, at: now });
  assert.equal(other.snapshot().remaining, null);
  // A floor of zero keeps only the next call's cost.
  const zero = createCreditBudget({
    dailyCap: 100000,
    creditFloor: 0,
    now: () => now,
    log: () => undefined,
  });
  await (
    await zero.reserve(20, { consumer: "history" })
  ).settle({ remaining: 25, at: now });
  await (
    await zero.reserve(20, { consumer: "history" })
  ).settle({ remaining: null, at: now });
  await assert.rejects(zero.reserve(20, { consumer: "history" }), exhausted());
  assert.throws(() => createCreditBudget({ dailyCap: 0 }), /cap/);
  assert.throws(
    () => createCreditBudget({ dailyCap: 1, creditFloor: -1 }),
    /floor/,
  );
  await assert.rejects(budget.reserve(0, { consumer: "history" }), /cost/);
  await assert.rejects(
    budget.reserve(1, { consumer: "history", reserveShare: 2 }),
    /reserve share/,
  );
  await assert.rejects(
    budget.reserve(1, { consumer: "other" as never }),
    /consumer/,
  );
});

test("two clients over one store spend one budget, a cap admits exactly what it holds under concurrency, and a store that does not answer refuses without spending", async () => {
  const store = createMemoryCreditBudgetStore();
  const fetches: string[] = [];
  const fetchImpl = (async (url: URL) => {
    fetches.push(String(url));
    return new Response(JSON.stringify({ items: [], next_page_params: null }), {
      headers: { "x-credits-remaining": "90000" },
    });
  }) as typeof fetch;
  const client = (
    budget = createCreditBudget({ dailyCap: 100, store, log: () => undefined }),
    limiter = createRateLimiter({ sleep: async () => {} }),
  ) => createBlockscoutClient({ key: "k", budget, limiter, fetchImpl });
  const a = client(),
    b = client();
  await a.readPage("transactions", wallet, null);
  await b.readPage("transactions", wallet, null);
  // A process sees another's spend once it next reserves or settles.
  assert.equal(b.budget.snapshot().spent, 40);
  assert.equal(a.budget.snapshot().spent, 20);
  await a.readPage("token-transfers", wallet, null);
  assert.equal(a.budget.snapshot().spent, 70);
  // A restart: a new client over the same rows continues the day's count.
  const restarted = client();
  assert.equal(restarted.budget.snapshot().spent, 0);
  await restarted.readPage("transactions", wallet, null);
  assert.equal(restarted.budget.snapshot().spent, 90);
  await assert.rejects(
    restarted.readPage("token-transfers", wallet, null),
    exhausted(),
  );
  assert.equal(restarted.budget.snapshot().spent, 90);
  assert.equal(fetches.length, 4);
  // Ten simultaneous calls against a cap holding three: exactly three made.
  const c = client(
    createCreditBudget({
      dailyCap: 60,
      store: createMemoryCreditBudgetStore(),
      log: () => undefined,
    }),
    { acquire: () => new Promise((resolve) => setImmediate(resolve)) },
  );
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      c.readPage("transactions", address(i + 1), null),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(results.filter((r) => r.status === "rejected").length, 7);
  assert.equal(fetches.length, 7);
  assert.deepEqual(c.budget.snapshot(), {
    ...c.budget.snapshot(),
    spent: 60,
    reserved: 0,
    consumers: { history: { spent: 60, reserved: 0 } },
  });
  // The limiter refusing gives the reservation back.
  const refused = client(
    createCreditBudget({
      dailyCap: 100,
      store: createMemoryCreditBudgetStore(),
      log: () => undefined,
    }),
    {
      acquire: async () => {
        throw new BlockscoutError("upstream_unavailable", 1);
      },
    },
  );
  await assert.rejects(
    refused.readPage("transactions", wallet, null),
    /upstream_unavailable/,
  );
  assert.deepEqual(refused.budget.snapshot(), {
    ...refused.budget.snapshot(),
    spent: 0,
    reserved: 0,
    consumers: { history: { spent: 0, reserved: 0 } },
  });
  // A failed attempt is spent all the same, and the view only falls.
  const failing = createBlockscoutClient({
    key: "k",
    budget: createCreditBudget({
      dailyCap: 100,
      store: createMemoryCreditBudgetStore(),
      log: () => undefined,
    }),
    limiter: createRateLimiter({ sleep: async () => {} }),
    fetchImpl: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  const write = process.stderr.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await assert.rejects(
      failing.readPage("transactions", wallet, null),
      /upstream_unavailable/,
    );
  } finally {
    process.stderr.write = write;
  }
  assert.deepEqual(failing.budget.snapshot(), {
    ...failing.budget.snapshot(),
    spent: 20,
    reserved: 0,
    remaining: null,
  });
  // A store that does not answer: refused as `budget_unavailable`, logged
  // by SQLSTATE, and nothing is fetched.
  const logs: unknown[] = [];
  const broken: CreditBudgetStore = {
    update: async () => {
      throw Object.assign(Error("connection refused"), { code: "57014" });
    },
    close: async () => {},
  };
  const dark = client(
    createCreditBudget({
      dailyCap: 100,
      store: broken,
      log: (e) => logs.push(e),
    }),
  );
  await assert.rejects(
    dark.readPage("transactions", wallet, null),
    (e: unknown) =>
      e instanceof BlockscoutError &&
      e.kind === "budget_unavailable" &&
      e.retryAfter === 30,
  );
  assert.deepEqual(logs, [
    { event: "explorer_budget_unavailable", code: "57014" },
  ]);
  assert.equal(fetches.length, 7);
  // A settle the store loses is logged and leaves the reservation counted.
  let updates = 0;
  const flaky: CreditBudgetStore = {
    update: async (name, day, change) => {
      if (++updates > 1) throw Error("lost");
      return createMemoryCreditBudgetStore().update(name, day, change);
    },
    close: async () => {},
  };
  const lossy = createCreditBudget({
    dailyCap: 100,
    store: flaky,
    log: (e) => logs.push(e),
  });
  await (
    await lossy.reserve(20, { consumer: "history" })
  ).settle({
    remaining: null,
    at: Date.now(),
  });
  assert.deepEqual(logs.at(-1), {
    event: "explorer_budget_settle_failed",
    code: null,
  });
  assert.equal(lossy.snapshot().reserved, 20);
});
