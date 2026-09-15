import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { parseRequest, RequestError } from "./request";
import { readTradeShare } from "./trade-share-read";
import { createApi } from "./server";

const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const identity = {
  poolId: word(1),
  txHash: word(2),
  logIndex: 3,
  wallet: address(11),
};
const path = `/v1/trades/${identity.poolId}/${identity.txHash}/3`;

test("trade share requests require an exact event and one normalized wallet", () => {
  const request = parseRequest(
    `${path.toUpperCase().replace("/V1/TRADES/", "/v1/trades/")}?wallet=${identity.wallet.toUpperCase()}`,
  );
  assert.equal(request.route, "trade-share");
  assert.equal(request.poolId, identity.poolId);
  assert.equal(request.txHash, identity.txHash);
  assert.equal(request.logIndex, identity.logIndex);
  assert.equal(request.wallet, identity.wallet);
  assert.notEqual(
    request.cacheKey,
    parseRequest(`${path}?wallet=${address(12)}`).cacheKey,
  );
  assert.notEqual(
    request.cacheKey,
    parseRequest(`${path.replace("/3", "/4")}?wallet=${address(11)}`).cacheKey,
  );
  for (const invalid of [
    path,
    `${path}?wallet=bad`,
    `${path}?wallet=${address(11)}&wallet=${address(11)}`,
    `${path}?wallet=${address(11)}&limit=1`,
    `${path.replace("/3", "/2147483648")}?wallet=${address(11)}`,
    `${path.replace("/3", "/-1")}?wallet=${address(11)}`,
    `${path.replace("/3", "/01")}?wallet=${address(11)}`,
  ]) {
    assert.throws(() => parseRequest(invalid), RequestError);
  }
});

test("trade share returns stored integer realization and rejects invalid projections", async () => {
  const row = {
    wallet: identity.wallet,
    pool_id: identity.poolId,
    token: address(1),
    symbol: "TEST",
    decimals: "6",
    transaction_hash: identity.txHash,
    log_index: identity.logIndex,
    block_number: "100",
    timestamp: "200",
    eth_wei: "900719925474099300001",
    token_raw: "900719925474099300002",
    realized_wei: "-900719925474099300003",
    disposed_cost_wei: "1801439850948198600004",
    asof_timestamp: "300",
    through_block: "199",
  };
  let queries = 0;
  const response = await readTradeShare(async (_sql, values) => {
    queries++;
    assert.deepEqual(values, [
      identity.poolId,
      identity.txHash,
      identity.logIndex,
      identity.wallet,
    ]);
    return { rows: [row] };
  }, identity);
  assert.equal(queries, 1);
  assert.equal(response.trade.realizedWei, row.realized_wei);
  assert.equal(response.trade.disposedCostWei, row.disposed_cost_wei);
  assert.equal(response.trade.ethWei, row.eth_wei);
  assert.equal(response.trade.tokenRaw, row.token_raw);
  assert.equal(response.trade.side, "sell");
  assert.equal(response.coverage.complete, false);
  for (const invalid of [
    { realized_wei: "1" },
    { disposed_cost_wei: "-1" },
    { eth_wei: "1.5" },
    { token_raw: "0" },
    { decimals: null },
  ]) {
    await assert.rejects(
      readTradeShare(
        async () => ({ rows: [{ ...row, ...invalid }] }),
        identity,
      ),
      { status: 503, code: "trade_share_projection_invalid" },
    );
  }
  await assert.rejects(
    readTradeShare(async () => ({ rows: [] }), identity),
    { status: 404, code: "trade_share_unavailable" },
  );
});

test("trade share HTTP responses disappear immediately after saved evidence removal", async (t) => {
  let reads = 0;
  const server = createApi({
    read: async () => {
      if (reads++) throw new RequestError(404, "trade_share_unavailable");
      return { trade: { txHash: identity.txHash } };
    },
    close: async () => {},
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const bound = server.address();
  assert.ok(bound && typeof bound !== "string");
  const url = `http://127.0.0.1:${bound.port}${path}?wallet=${identity.wallet}`;
  const initial = await fetch(url);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const removed = await fetch(url);
  assert.equal(removed.status, 404);
  assert.deepEqual(await removed.json(), { error: "trade_share_unavailable" });
  assert.equal(reads, 2);
});
