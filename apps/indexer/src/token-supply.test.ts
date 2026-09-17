import test from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { RpcCallError } from "@pools/chain";
import type { TokenSupplyRow, UnreadTokenSupply } from "@pools/db";
import {
  runTokenSupplyRead,
  tokenSupplyConfig,
  tokenSupplyPolicy,
  type TokenSupplyDeps,
} from "./token-supply";

const token = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;

test("configuration defaults to the public RPC and refuses Alchemy", () => {
  assert.deepEqual(tokenSupplyConfig({}), {
    rpcUrl: tokenSupplyPolicy.publicRpcUrl,
    minIntervalMs: 1000,
    maxRequests: 500,
  });
  assert.equal(
    tokenSupplyConfig({ ROBINHOOD_RPC_URL: " " }).rpcUrl,
    tokenSupplyPolicy.publicRpcUrl,
  );
  for (const url of [
    "https://robinhood-mainnet.g.alchemy.com/v2/key",
    "https://RPC.ALCHEMY.COM",
  ])
    assert.throws(
      () => tokenSupplyConfig({ ROBINHOOD_RPC_URL: url }),
      /never reads Alchemy/,
    );
  assert.throws(
    () => tokenSupplyConfig({ ROBINHOOD_RPC_URL: "not a url" }),
    /Invalid ROBINHOOD_RPC_URL/,
  );
  assert.deepEqual(
    tokenSupplyConfig({
      TOKEN_SUPPLY_MIN_INTERVAL_MS: "2000",
      TOKEN_SUPPLY_MAX_REQUESTS: "40",
    }),
    {
      rpcUrl: tokenSupplyPolicy.publicRpcUrl,
      minIntervalMs: 2000,
      maxRequests: 40,
    },
  );
  for (const [name, value] of [
    ["TOKEN_SUPPLY_MIN_INTERVAL_MS", "0"],
    ["TOKEN_SUPPLY_MIN_INTERVAL_MS", "1.5"],
    ["TOKEN_SUPPLY_MAX_REQUESTS", "0"],
  ])
    assert.throws(() => tokenSupplyConfig({ [name]: value }), /Invalid/);
});

/** A catalog of `pools` pools, pool n holding token n, read by a fake chain
 * whose head advances by 10 blocks per read. */
function fixture(pools: number, options: { unreadable?: Set<number> } = {}) {
  const saved = new Map<string, TokenSupplyRow>();
  const catalog = Array.from({ length: pools }, (_, i) => ({
    poolRef: i + 1,
    token: token(i + 1),
  }));
  let head = 1000;
  let requests = 0;
  const reads: { tokens: number; block: number }[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: TokenSupplyDeps = {
    unread: async (after, limit): Promise<UnreadTokenSupply[]> =>
      catalog
        .filter((p) => p.poolRef > after && !saved.has(p.token))
        .slice(0, limit),
    save: async (rows) => {
      for (const r of rows) saved.set(r.token, r);
      return rows.length;
    },
    head: async () => {
      requests++;
      return (head += 10);
    },
    read: async (tokens, block) => {
      requests++;
      reads.push({ tokens: tokens.length, block });
      return {
        aggregated: true,
        supplies: tokens.map((t) => ({
          token: t,
          supplyRaw: options.unreadable?.has(Number(BigInt(t)))
            ? null
            : (BigInt(t) * 10n ** 27n).toString(),
          block,
        })),
      };
    },
    requests: () => requests,
    log: (e) => logs.push(e),
  };
  return { deps, saved, reads, logs };
}

test("a run reads every unread token once, one aggregate per page, refreshing the head", async () => {
  const f = fixture(4250, { unreadable: new Set([7, 4001]) });
  const summary = await runTokenSupplyRead(f.deps);
  // 4,250 pools at 200 per aggregate: 22 aggregates and a head every 20.
  assert.equal(f.reads.length, 22);
  assert.deepEqual(
    f.reads.map((r) => r.tokens),
    [...Array(21).fill(200), 50],
  );
  assert.deepEqual([...new Set(f.reads.map((r) => r.block))], [1010, 1020]);
  assert.equal(f.reads[19].block, 1010);
  assert.equal(f.reads[20].block, 1020);
  assert.deepEqual(
    { ...summary, elapsedMs: 0 },
    {
      pools: 4250,
      tokens: 4250,
      saved: 4248,
      unreadable: [token(7), token(4001)],
      aggregates: 22,
      heads: 2,
      requests: 24,
      firstBlock: 1010,
      lastBlock: 1020,
      elapsedMs: 0,
    },
  );
  assert.equal(
    f.saved.get(token(4250))?.supplyRaw,
    (4250n * 10n ** 27n).toString(),
  );
  assert.equal(f.saved.has(token(7)), false);
  assert.deepEqual(
    f.logs.map((l) => [l.event, l.pools]),
    [["token_supply_progress", 4000]],
  );
  // A second run only revisits what stayed unread.
  const again = await runTokenSupplyRead(f.deps);
  assert.equal(again.pools, 2);
  assert.deepEqual(again.unreadable, [token(7), token(4001)]);
});

test("a token whose call reverts is isolated by halving its page; the rest of the page is kept", async () => {
  const f = fixture(450);
  const read = f.deps.read;
  const sizes: number[] = [];
  f.deps.read = async (tokens, block) => {
    sizes.push(tokens.length);
    if (tokens.includes(token(77))) throw new RpcCallError();
    return read(tokens, block);
  };
  const summary = await runTokenSupplyRead(f.deps);
  // Page one's failing halves narrow 200, 100, 50, 25, 13, 7, 4, 2 down to
  // token 77 alone; every half that passes is one aggregate, depth first. Pages
  // two and three read once each.
  assert.deepEqual(summary.unreadable, [token(77)]);
  assert.equal(summary.saved, 449);
  assert.equal(summary.pools, 450);
  assert.equal(f.saved.has(token(77)), false);
  assert.equal(
    f.saved.get(token(76))?.supplyRaw,
    (76n * 10n ** 27n).toString(),
  );
  assert.deepEqual(
    sizes,
    [200, 100, 50, 50, 25, 25, 13, 7, 4, 2, 1, 1, 2, 3, 6, 12, 100, 200, 50],
  );
  assert.equal(summary.aggregates, 10);
  assert.equal(summary.heads, 1);
  // Any other failure stops the run.
  const g = fixture(10);
  g.deps.read = async () => {
    throw Error("fetch failed");
  };
  await assert.rejects(runTokenSupplyRead(g.deps), /fetch failed/);
});

test("a run stops rather than fall back to one request per token", async () => {
  const f = fixture(10);
  f.deps.read = async () => ({ aggregated: false, supplies: [] });
  await assert.rejects(
    runTokenSupplyRead(f.deps),
    /refusing one request per token/,
  );
  assert.equal(f.saved.size, 0);
});
