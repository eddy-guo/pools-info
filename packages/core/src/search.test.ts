import { test } from "node:test";
import assert from "node:assert/strict";
import captured from "../../../data/snapshots/chain.json";
import {
  createLocalSearchProvider,
  searchEntryIdentity,
  type SearchEntry,
} from "./search";
import type { ChainSnapshot } from "./chain-types";
const snapshot = captured as ChainSnapshot;

test("search identity ignores view parameters and address case while preserving groups and distinct pools", () => {
  const address = `0x${"a1".repeat(20)}`;
  const entry: SearchEntry = {
    id: "local",
    group: "Wallets",
    title: "Wallet",
    context: "",
    terms: [],
    address,
    href: `/wallet/${address}/`,
  };
  assert.equal(
    searchEntryIdentity(entry),
    searchEntryIdentity({
      ...entry,
      id: "remote",
      address: address.toUpperCase(),
      href: `/wallet/${address}/?window=All`,
    }),
  );
  assert.notEqual(
    searchEntryIdentity(entry),
    searchEntryIdentity({
      ...entry,
      group: "Creators",
      href: `/creators/${address}/`,
    }),
  );
  const pool = {
    ...entry,
    group: "Tokens" as const,
    href: `/pool/0x${"1".repeat(64)}/?launch=old`,
  };
  assert.equal(
    searchEntryIdentity(pool),
    searchEntryIdentity({
      ...pool,
      href: `/pool/0x${"1".repeat(64)}/?window=24h`,
    }),
  );
  assert.notEqual(
    searchEntryIdentity(pool),
    searchEntryIdentity({ ...pool, href: `/pool/0x${"2".repeat(64)}/` }),
  );
  const tx = {
    ...entry,
    group: "Transactions" as const,
    address: `0x${"ab".repeat(32)}`,
    href: "https://robinhoodchain.blockscout.com/tx/one",
  };
  assert.equal(
    searchEntryIdentity(tx),
    searchEntryIdentity({
      ...tx,
      address: tx.address.toUpperCase(),
      href: `${tx.href}?view=logs`,
    }),
  );
});
const lookup = (q: string) =>
  createLocalSearchProvider(snapshot, {}).search(q, {
    signal: new AbortController().signal,
  });
test("name typos and transpositions find tokens, and typed search constrains groups", async () => {
  const exact = await lookup("FOLIO");
  const typo = await lookup("FOLIOO");
  const transposed = await lookup("FOLIO".replace("LI", "IL"));
  assert.equal(exact.entries[0].title, typo.entries[0].title);
  assert.equal(exact.entries[0].title, transposed.entries[0].title);
  assert.ok(
    (await lookup("token: monki")).entries.every((e) => e.group === "Tokens"),
  );
});
test("full addresses and hashes are exact, with honest unknown-address fallbacks", async () => {
  const m = snapshot.markets[0];
  const known = await lookup(m.token.toUpperCase().replace("0X", "0x"));
  assert.equal(known.entries[0].group, "Tokens");
  assert.equal(known.entries[0].address, m.token);
  const unknown = await lookup("0x1111111111111111111111111111111111111111");
  assert.ok(
    unknown.entries.some(
      (e) => e.href === "/wallet/0x1111111111111111111111111111111111111111/",
    ),
  );
  assert.ok(unknown.entries.some((e) => e.context.includes("not verified")));
  assert.equal((await lookup(m.id)).entries[0].context, "Pool ID · Robinhood");
  assert.equal((await lookup("0xzzzzzzzz")).entries.length, 0);
});
test("ENS detection preserves unsupported names for a real resolver, never inventing a wallet", async () => {
  const r = await lookup("vitalik.eth");
  assert.equal(r.kind, "ens");
  assert.equal(r.entries.length, 0);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    createLocalSearchProvider(snapshot, {}).search("x", {
      signal: abort.signal,
    }),
  );
});

test("catalog-only tokens are searchable without invented trading metrics", async () => {
  const m = snapshot.markets[0];
  const catalog = {
    schemaVersion: 1 as const,
    chainId: 4663 as const,
    generatedAt: snapshot.generatedAt,
    toBlock: snapshot.toBlock,
    blockHash: snapshot.blockHash,
    ranges: [{ fromBlock: 1, toBlock: snapshot.toBlock }],
    pools: [
      {
        id: "0x" + "f".repeat(64),
        token: "0x" + "a".repeat(40),
        name: "Archived Example",
        symbol: "ARC",
        launchTx: m.launchTx,
        launchSender: m.launchSender,
        launchBlock: 1,
        launchedAt: 1,
      },
    ],
  };
  const r = await createLocalSearchProvider(snapshot, {}, catalog).search(
    "archvied",
    { signal: new AbortController().signal },
  );
  assert.equal(r.entries[0].title, "Archived Example (ARC)");
  assert.match(r.entries[0].context, /details load on demand/);
  assert.ok(r.entries[0].href.includes("launch="));
});
