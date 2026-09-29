import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import test from "node:test";
import type { WalletHistoryKind } from "@pools/core";
import {
  createHistoryCursorCodec,
  historyCursorSecretMinLength,
  historyCursorShape,
  historyCursorTtlMs,
} from "./history-cursor";
import { canonicalPageParams } from "./history-page";
import { parseRequest, RequestError } from "./request";

const wallet = "0x42a68318a6d78644870d3a37ec9e708e3ea904f5";
const other = "0x" + "1".repeat(40);
const secret = randomBytes(32).toString("hex");
const txHash =
  "0x0e4220297ac84efaa3ecb54200ff72a50170e8fb8db6cade0d8023a69ac69be8";
/** The recorded transactions position, with the numbers Blockscout sends. */
const recordedTransactions = {
  index: 6,
  value: "0",
  hash: txHash.toUpperCase().replace("0X", "0x"),
  inserted_at: "2026-09-14T15:13:54.207069Z",
  block_number: 62905772,
  fee: "26489045362000",
  items_count: 50,
};
const canonicalTransactions = {
  block_number: "62905772",
  fee: "26489045362000",
  hash: txHash,
  index: "6",
  inserted_at: "2026-09-14T15:13:54.207069Z",
  items_count: "50",
  value: "0",
};

test("a position is only the explorer's own paging keys for the kind, each in its canonical form", () => {
  assert.equal(canonicalPageParams("transactions", null), null);
  assert.equal(canonicalPageParams("trades", undefined), null);
  assert.deepEqual(
    canonicalPageParams("transactions", recordedTransactions),
    canonicalTransactions,
  );
  assert.deepEqual(
    canonicalPageParams("trades", { index: 14, block_number: 67884997 }),
    {
      block_number: "67884997",
      index: "14",
    },
  );
  assert.deepEqual(
    canonicalPageParams("token-transfers", {
      block_number: "5",
      index: "0",
      items_count: "100",
      batch_log_index: 1,
      batch_block_hash: "0x" + "A".repeat(64),
      batch_transaction_hash: "0x" + "b".repeat(64),
      index_in_batch: 0,
    }),
    {
      batch_block_hash: "0x" + "a".repeat(64),
      batch_log_index: "1",
      batch_transaction_hash: "0x" + "b".repeat(64),
      block_number: "5",
      index: "0",
      index_in_batch: "0",
      items_count: "100",
    },
  );
  const bad: [Parameters<typeof canonicalPageParams>[0], unknown, RegExp][] = [
    ["transactions", [], /page/],
    ["transactions", "x", /page/],
    ["transactions", {}, /page empty/],
    ["transactions", { unused: "one" }, /page key unused/],
    ["trades", { type: "ERC-721" }, /page key type/],
    ["trades", { hash: txHash }, /page key hash/],
    ["transactions", { constructor: "1" }, /page key constructor/],
    ["transactions", { block_number: "007" }, /page value block_number/],
    ["transactions", { block_number: -1 }, /page value block_number/],
    ["transactions", { block_number: 1.5 }, /page value block_number/],
    ["transactions", { block_number: "1e3" }, /page value block_number/],
    ["transactions", { block_number: 2 ** 53 }, /page value block_number/],
    ["transactions", { block_number: null }, /page value block_number/],
    ["transactions", { block_number: true }, /page value block_number/],
    ["transactions", { index: 2147483648 }, /page value index/],
    ["transactions", { items_count: "-5" }, /page value items_count/],
    ["transactions", { fee: "1".repeat(79) }, /page value fee/],
    ["transactions", { fee: 12 }, /page value fee/],
    ["transactions", { value: "0x10" }, /page value value/],
    ["transactions", { hash: "0x12" }, /page value hash/],
    ["transactions", { inserted_at: "yesterday" }, /page value inserted_at/],
    [
      "transactions",
      { inserted_at: "2026-09-14 15:13:54Z" },
      /page value inserted_at/,
    ],
    ["transactions", { inserted_at: "2026-13-40T15:13:54Z" }, /page value/],
  ];
  for (const [kind, value, message] of bad)
    assert.throws(() => canonicalPageParams(kind, value), message);
});

test("cursors are signed, versioned, bound to the wallet, kind, filter and position, and expire after a day", () => {
  let now = Date.parse("2026-09-29T12:00:00Z");
  const codec = createHistoryCursorCodec({ secret, now: () => now });
  const page = { block_number: "67884997", index: "14" };
  const trades = { wallet, kind: "trades" as const };
  const cursor = codec.encode({ ...trades, page });
  assert.match(cursor, historyCursorShape);
  assert.deepEqual(codec.decode(cursor, trades), page);
  // The numbers the explorer sends are canonical text in the cursor.
  assert.deepEqual(
    codec.decode(
      codec.encode({
        ...trades,
        page: { index: 14, block_number: 67884997 } as never,
      }),
      trades,
    ),
    page,
  );
  // The payload is the binding and the position, nothing else, then the MAC.
  const bytes = Buffer.from(cursor, "base64url");
  const payload = JSON.parse(bytes.subarray(0, -32).toString());
  const e = Math.floor((now + historyCursorTtlMs) / 1000);
  assert.deepEqual(payload, {
    v: 2,
    w: wallet,
    k: "trades",
    f: { type: "ERC-20" },
    p: page,
    e,
  });
  assert.equal(bytes.length, Buffer.byteLength(JSON.stringify(payload)) + 32);
  const invalid = (
    raw: string,
    input: { wallet: string; kind: WalletHistoryKind } = trades,
  ) => assert.throws(() => codec.decode(raw, input), /cursor/);
  // Another wallet, another kind (and so another filter).
  invalid(cursor, { wallet: other, kind: "trades" });
  invalid(cursor, { wallet, kind: "token-transfers" });
  invalid(cursor, { wallet: wallet.toUpperCase(), kind: "trades" });
  // Any altered character, in the position or the signature, fails.
  for (let i = 0; i < cursor.length; i += 5)
    invalid(
      cursor.slice(0, i) +
        (cursor[i] === "A" ? "B" : "A") +
        cursor.slice(i + 1),
    );
  invalid(cursor.slice(1));
  invalid(cursor + "A");
  invalid(cursor.slice(0, 40));
  invalid("");
  invalid("A".repeat(2049));
  invalid("not base64url!");
  invalid("a.b");
  // Another server's secret; and the unsigned v1 format, which any caller
  // could write, with any position it liked.
  invalid(
    createHistoryCursorCodec({
      secret: randomBytes(32).toString("hex"),
      now: () => now,
    }).encode({ ...trades, page }),
  );
  for (const p of [page, { unused: "one" }, { unused: "two" }])
    invalid(
      Buffer.from(
        JSON.stringify({ v: 1, scope: "abc", kind: "trades", page: p }),
      ).toString("base64url"),
    );
  // A valid signature over a payload this api never issues: a position
  // outside the schema or not canonical, another filter, version or key set.
  const sign = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    return Buffer.concat([
      body,
      createHmac("sha256", secret).update(body).digest(),
    ]).toString("base64url");
  };
  const issued = {
    v: 2,
    w: wallet,
    k: "trades",
    f: { type: "ERC-20" },
    p: page,
    e,
  };
  assert.deepEqual(codec.decode(sign(issued), trades), page);
  for (const forged of [
    { ...issued, p: { ...page, unused: "one" } },
    { ...issued, p: { ...page, type: "ERC-721" } },
    { ...issued, p: { index: "14", block_number: "67884997" } },
    { ...issued, p: { block_number: "067884997", index: "14" } },
    { ...issued, p: { block_number: 67884997, index: 14 } },
    { ...issued, p: {} },
    { ...issued, p: null },
    { ...issued, f: {} },
    { ...issued, f: { type: "ERC-721" } },
    { ...issued, v: 1 },
    { ...issued, v: 3 },
    { ...issued, x: 1 },
    { v: 2, w: wallet, k: "trades", f: { type: "ERC-20" }, p: page },
    { ...issued, e: String(e) },
    { ...issued, e: e + 0.5 },
    { ...issued, w: wallet.toUpperCase() },
    { ...issued, k: "token-transfers" },
    [],
    null,
    "x",
    12,
  ])
    invalid(sign(forged));
  // Expiry: a day from the issuing clock.
  now += historyCursorTtlMs - 1000;
  assert.deepEqual(codec.decode(cursor, trades), page);
  now += 1000;
  invalid(cursor);
  // The other kinds and their filters.
  const transactions = { wallet, kind: "transactions" as const };
  const tx = codec.encode({
    ...transactions,
    page: recordedTransactions as never,
  });
  assert.deepEqual(
    JSON.parse(Buffer.from(tx, "base64url").subarray(0, -32).toString()).f,
    {},
  );
  assert.deepEqual(codec.decode(tx, transactions), canonicalTransactions);
  invalid(tx, { wallet, kind: "token-transfers" });
  invalid(tx, trades);
  assert.throws(
    () => codec.encode({ ...trades, page: { unused: "1" } }),
    /page key unused/,
  );
  assert.throws(() => codec.encode({ ...trades, page: {} }), /page empty/);
  // The secret: at least 32 characters, no whitespace, never printed.
  assert.equal(historyCursorSecretMinLength, 32);
  for (const bad of [
    undefined,
    "",
    "short",
    "x".repeat(31),
    "a b" + "c".repeat(40),
  ])
    assert.throws(
      () => createHistoryCursorCodec({ secret: bad }),
      (error: Error) =>
        /HISTORY_CURSOR_SECRET/.test(error.message) &&
        !(bad && bad.length > 5 && error.message.includes(bad)),
    );
  assert.throws(() => createHistoryCursorCodec({ secret, ttlMs: 0 }), /ttl/);
});

test("the parser keeps a history cursor as received and refuses only its shape", () => {
  const request = parseRequest(
    `/v1/wallets/${wallet.toUpperCase().replace("0X", "0x")}/history`,
  );
  assert.equal(request.route, "history");
  assert.equal(request.wallet, wallet);
  assert.equal(request.kind, "transactions");
  assert.equal(request.historyCursor, null);
  const codec = createHistoryCursorCodec({ secret });
  const cursor = codec.encode({
    wallet,
    kind: "transactions",
    page: { block_number: "1", index: "2" },
  });
  const paged = parseRequest(`/v1/wallets/${wallet}/history?cursor=${cursor}`);
  assert.equal(paged.historyCursor, cursor);
  assert.notEqual(paged.cacheKey, request.cacheKey);
  const transfers = parseRequest(
    `/v1/wallets/${wallet}/history?kind=token-transfers`,
  );
  assert.equal(transfers.kind, "token-transfers");
  const trades = parseRequest(`/v1/wallets/${wallet}/history?kind=trades`);
  assert.equal(trades.kind, "trades");
  assert.notEqual(trades.cacheKey, transfers.cacheKey);
  // The parser never decodes: a well-formed cursor of any provenance reaches
  // the history reader, whose verification (wallet-history.test.ts) refuses
  // it before any paid read.
  assert.equal(
    parseRequest(`/v1/wallets/${other}/history?cursor=${cursor}`).historyCursor,
    cursor,
  );
  assert.equal(
    parseRequest(`/v1/wallets/${wallet}/history?kind=trades&cursor=${cursor}`)
      .historyCursor,
    cursor,
  );
  for (const suffix of [
    "?kind=logs",
    "?limit=5",
    "?cursor=",
    "?cursor=%00",
    `?cursor=${"a".repeat(2049)}`,
    "?cursor=a.b",
    `?cursor=${cursor}&cursor=${cursor}`,
    "/",
  ])
    assert.throws(
      () => parseRequest(`/v1/wallets/${wallet}/history${suffix}`),
      RequestError,
    );
  // The existing activity and profile routes keep their meaning.
  assert.equal(parseRequest(`/v1/wallets/${wallet}/activity`).route, "wallet");
  assert.equal(parseRequest(`/v1/wallets/${wallet}`).route, "profile");
});
