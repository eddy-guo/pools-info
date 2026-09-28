import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient, migrate } from "../../../packages/db/src/index";
import {
  BlockscoutError,
  createBlockscoutClient,
  createCreditBudget,
  type BlockscoutClient,
} from "./blockscout-client";
import {
  contractCensusPolicy,
  createContractCensus,
  createWalletCodeStore,
  walletCodeKind,
  type WalletCodeObservation,
  type WalletCodeStore,
} from "./trader-contracts";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
// The code eth_getCode answered on 28 Sep 2026: All-time #29's market maker
// (15,739 bytes, first bytes shown) and 30d/All #33, a wallet delegated to
// Uniswap's Calibur under EIP-7702.
const marketMaker = "0x6080604052600436106100bb575f3560e01c8063a29acc";
const delegated = "0xef0100e8b12077f4f9c3e1b239a62f283fe4ef6ec9c449";

test("a contract is code that is not an EIP-7702 delegation designator", () => {
  assert.equal(walletCodeKind("0x"), "none");
  assert.equal(walletCodeKind(delegated), "delegated");
  assert.equal(
    walletCodeKind(delegated.toUpperCase().replace("0X", "0x")),
    "delegated",
  );
  assert.equal(walletCodeKind(marketMaker), "contract");
  // The designator's prefix on anything but exactly one delegate is code.
  assert.equal(walletCodeKind(delegated + "00"), "contract");
  assert.equal(walletCodeKind("0xef0100"), "contract");
  assert.throws(() => walletCodeKind("0xabc"), /Invalid code/);
  assert.throws(() => walletCodeKind("6080"), /Invalid code/);
});

test("the explorer client reads code five addresses a call through the JSON-RPC gateway, at 20 credits a call, and refuses a malformed answer", async () => {
  const calls: { url: string; body: unknown[] }[] = [];
  let reply = (body: { id: number; params: string[] }[]) =>
    body.map(({ id, params }) => ({
      jsonrpc: "2.0",
      id,
      result:
        params[0] === addr(3)
          ? delegated
          : params[0] === addr(1)
            ? marketMaker
            : "0x",
    }));
  const client = createBlockscoutClient({
    key: "k",
    dailyCreditCap: 1000,
    fetchImpl: (async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify(reply(body)), {
        status: 200,
        headers: { "x-credits-remaining": "45000" },
      });
    }) as typeof fetch,
  });
  const wallets = [1, 2, 3, 4, 5, 6, 7].map(addr);
  const code = await client.readCode(wallets, 0.2);
  assert.deepEqual(
    calls.map((c) => [c.url, c.body.length]),
    [
      ["https://api.blockscout.com/4663/json-rpc", 5],
      ["https://api.blockscout.com/4663/json-rpc", 2],
    ],
  );
  assert.deepEqual(calls[0].body[0], {
    jsonrpc: "2.0",
    id: 0,
    method: "eth_getCode",
    params: [addr(1), "latest"],
  });
  assert.deepEqual(
    [...code],
    wallets.map((w) => [
      w,
      w === addr(1) ? marketMaker : w === addr(3) ? delegated : "0x",
    ]),
  );
  assert.deepEqual(client.budget.snapshot(), {
    ...client.budget.snapshot(),
    spent: 40,
    remaining: 45000,
  });
  // A missing answer, an error in place of one or anything but hex code
  // fails the read rather than recording a guess.
  for (const broken of [
    (body: { id: number }[]) =>
      body.slice(1).map(({ id }) => ({ id, result: "0x" })),
    (body: { id: number }[]) =>
      body.map(({ id }) => ({ id, error: { code: -32000 } })),
    (body: { id: number }[]) => body.map(({ id }) => ({ id, result: "0x123" })),
  ]) {
    reply = broken as unknown as typeof reply;
    await assert.rejects(
      client.readCode([addr(1)], 0.2),
      (e: BlockscoutError) => e.kind === "upstream_unavailable",
    );
  }
});

/** A store over a fixed candidate list, recording what the census wrote. */
function memoryStore(due: string[]) {
  const recorded: WalletCodeObservation[][] = [];
  const store: WalletCodeStore = {
    async candidates(limit) {
      const done = new Set(recorded.flat().map((o) => o.address));
      return due.filter((a) => !done.has(a)).slice(0, limit);
    },
    async record(observations) {
      recorded.push([...observations]);
    },
    async close() {},
  };
  return { store, recorded };
}
/** An explorer that answers every address with `code(address)`, stating
 * `remaining` credits after each call. */
function explorer(
  code: (address: string) => string,
  remaining: () => number,
  fail?: (call: number) => BlockscoutError | null,
) {
  const budget = createCreditBudget({ dailyCap: 100000 });
  const asked: string[][] = [];
  const client = {
    budget,
    async readCode(addresses: readonly string[]) {
      asked.push([...addresses]);
      const error = fail?.(asked.length);
      if (error) throw error;
      budget.spend(20);
      budget.observeRemaining(remaining(), 30);
      return new Map(addresses.map((a) => [a, code(a)]));
    },
  } as unknown as BlockscoutClient;
  return { client, asked };
}

test("a census run reads the due candidates five to a call, records each batch as it lands and keeps to its per-run and daily bounds", async () => {
  const due = Array.from({ length: 60 }, (_, i) => addr(i + 1));
  const { store, recorded } = memoryStore(due);
  const { client, asked } = explorer(
    (a) => (a === addr(2) ? marketMaker : a === addr(3) ? delegated : "0x"),
    () => 90000,
  );
  let now = Date.parse("2026-09-28T10:00:00Z");
  const policy = { ...contractCensusPolicy, addressesPerDay: 40 };
  const census = createContractCensus({
    store,
    client,
    log: () => undefined,
    now: () => now,
    policy,
  });
  const first = await census.run();
  assert.equal(first.stopped, "done");
  assert.deepEqual(
    asked.map((b) => b.length),
    [5, 5, 5, 5, 5],
  );
  assert.equal(first.observed.length, policy.addressesPerRun);
  assert.deepEqual(first.observed.slice(0, 3), [
    { address: addr(1), kind: "none", codeBytes: 0 },
    { address: addr(2), kind: "contract", codeBytes: 23 },
    { address: addr(3), kind: "delegated", codeBytes: 23 },
  ]);
  assert.deepEqual(
    recorded.map((r) => r.length),
    [5, 5, 5, 5, 5],
  );
  // The day's 40 addresses: fifteen more, then nothing until midnight UTC.
  const second = await census.run();
  assert.equal(second.observed.length, 15);
  assert.equal((await census.run()).stopped, "daily_cap");
  now = Date.parse("2026-09-29T00:00:01Z");
  assert.equal((await census.run()).observed.length, 20);
  await census.close();
});

test("a census run never reads under the credit floor and never retries a failed call", async () => {
  const due = Array.from({ length: 20 }, (_, i) => addr(i + 1));
  // The key's balance falls under the floor after the second call.
  let balance = contractCensusPolicy.creditFloor + 30;
  const { store, recorded } = memoryStore(due);
  const low = explorer(
    () => "0x",
    () => (balance -= 20),
  );
  const census = createContractCensus({
    store,
    client: low.client,
    log: () => undefined,
  });
  const run = await census.run();
  assert.deepEqual(
    [run.stopped, low.asked.length, recorded.flat().length],
    ["credit_floor", 2, 10],
  );
  // Still under the floor: not even the first call of the next run.
  assert.equal((await census.run()).stopped, "credit_floor");
  assert.equal(low.asked.length, 2);
  // An explorer failure ends the run where it stands, once.
  const failing = explorer(
    () => "0x",
    () => 90000,
    (call) =>
      call === 2 ? new BlockscoutError("upstream_unavailable", 30) : null,
  );
  const other = memoryStore(due);
  const failed = await createContractCensus({
    store: other.store,
    client: failing.client,
    log: () => undefined,
  }).run();
  assert.deepEqual(
    [failed.stopped, failing.asked.length, other.recorded.flat().length],
    ["explorer_failed", 2, 5],
  );
  // The daily cap the api's own budget keeps reads as the floor does.
  const exhausted = explorer(
    () => "0x",
    () => 90000,
    () => new BlockscoutError("budget_exhausted", 3600),
  );
  assert.equal(
    (
      await createContractCensus({
        store: memoryStore(due).store,
        client: exhausted.client,
        log: () => undefined,
      }).run()
    ).stopped,
    "credit_floor",
  );
  // No explorer key: nothing to read with.
  assert.equal(
    (
      await createContractCensus({
        store: memoryStore(due).store,
        client: null,
        log: () => undefined,
      }).run()
    ).stopped,
    "not_configured",
  );
});

test(
  "the census reaches every servable gate and page without admitting an unservable wallet",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const db = createClient(process.env.TEST_DATABASE_URL!);
    await db.connect();
    const schema = "api_test_tradercensus_" + randomUUID().replaceAll("-", "");
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await migrate(db);
    const store = createWalletCodeStore(process.env.TEST_DATABASE_URL, schema);
    t.after(async () => {
      await store.close();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.end();
    });
    await db.query(`INSERT INTO agg_wallets(address,first_block)
    SELECT decode(lpad(to_hex(i),40,'0'),'hex'),0 FROM generate_series(1,105) i`);
    await db.query(`INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,
    trades,supported_trades,wins,losses,closures,hold_seconds,supported_positions,excluded_positions,window_start,refreshed_at)
    SELECT 4663,'All',wallet_ref,
      CASE WHEN wallet_ref<=99 THEN 1000-wallet_ref WHEN wallet_ref=100 THEN 900 WHEN wallet_ref=101 THEN 950
        WHEN wallet_ref=102 THEN -200 WHEN wallet_ref=103 THEN -100 WHEN wallet_ref=104 THEN -300 ELSE -400 END,
      CASE WHEN wallet_ref=104 THEN 2000 WHEN wallet_ref<=99 THEN 1000-wallet_ref ELSE -400 END,
      100,100,CASE WHEN wallet_ref=101 THEN 0 WHEN wallet_ref=102 THEN 900 ELSE 10 END,
      CASE WHEN wallet_ref=101 THEN 0 WHEN wallet_ref=102 THEN 900 ELSE 10 END,
      0,0,0,0,1,0,0,now() FROM agg_wallets`);
    await db.query(`INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,
    trades,supported_trades,wins,losses,closures,hold_seconds,supported_positions,excluded_positions,window_start,refreshed_at)
    VALUES(4663,'1h',105,3000,3000,100,100,10,10,0,0,0,0,1,0,0,now())`);
    await db.query(`INSERT INTO agg_trader_windows(chain_id,"window",wallet_ref,realized_wei,net_wei,volume_wei,disposed_cost_wei,
      trades,supported_trades,wins,losses,closures,hold_seconds,supported_positions,excluded_positions,window_start,refreshed_at)
      SELECT 4663,'6h',wallet_ref,
        CASE WHEN wallet_ref<=100 THEN 1001-wallet_ref WHEN wallet_ref=101 THEN 0 ELSE 950 END,
        CASE WHEN wallet_ref<=100 THEN 1001-wallet_ref WHEN wallet_ref=101 THEN 0 ELSE 950 END,
        100,100,CASE WHEN wallet_ref<=100 THEN 900 WHEN wallet_ref=101 THEN 800 ELSE 700 END,
        CASE WHEN wallet_ref<=100 THEN 900 WHEN wallet_ref=101 THEN 800 ELSE 700 END,
        0,0,0,0,1,0,0,now() FROM agg_wallets WHERE wallet_ref<=102`);
    const sixHour = (
      await db.query(
        "SELECT trader_servable_refs('6h','realized') AS wallet_ref",
      )
    ).rows.map((r) => Number(r.wallet_ref));
    assert(sixHour.includes(102));
    assert(!sixHour.includes(101));
    const due = await store.candidates(200);
    for (const ref of [100, 101, 102, 104, 105])
      assert(due.includes(addr(ref)), `missing servable wallet ${ref}`);
    assert(!due.includes(addr(103)));
    assert.equal(due.length, 104);
    const census = createContractCensus({
      store,
      log: () => undefined,
      policy: {
        ...contractCensusPolicy,
        addressesPerRun: 200,
        addressesPerDay: 200,
      },
      client: {
        budget: createCreditBudget({ dailyCap: 100000 }),
        async readCode(addresses: readonly string[]) {
          return new Map(
            addresses.map((address) => [
              address,
              address === addr(101) ? marketMaker : "0x",
            ]),
          );
        },
      } as never,
    });
    const run = await census.run();
    assert(
      run.observed.some(
        (o) => o.address === addr(101) && o.kind === "contract",
      ),
    );
    assert(!(await store.candidates(200)).includes(addr(101)));
  },
);
