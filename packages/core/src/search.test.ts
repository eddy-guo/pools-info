import { test } from "node:test";
import assert from "node:assert/strict";
import captured from "../../../data/snapshots/chain.json";
import { createLocalSearchProvider } from "./search";
import type { ChainSnapshot } from "./chain-types";
const snapshot = captured as ChainSnapshot;
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
