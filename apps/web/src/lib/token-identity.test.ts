import test from "node:test";
import assert from "node:assert/strict";
import {
  searchResultTitle,
  tokenLabel,
  tokenLine,
  tokenSubSymbol,
} from "./token-identity";

const token = "0x5c9fdd5e0236b6a6e7c8caf5431b9b5d88596b30";

test("a named token reads as it always has", () => {
  const pool = { name: "Green Chain", symbol: "Chain", token };
  assert.equal(tokenLabel(pool), "Green Chain");
  assert.equal(tokenSubSymbol(pool), "Chain");
  assert.equal(tokenLine(pool), "Green Chain (Chain)");
  assert.equal(
    searchResultTitle("Green Chain (Chain)", token),
    "Green Chain · Chain",
  );
  // A symbol equal to the name is still the token's own symbol.
  assert.equal(tokenSubSymbol({ name: "gud", symbol: "gud" }), "gud");
});

test("a token without a name reads as its symbol, once", () => {
  for (const name of [null, undefined, "", "   "]) {
    const pool = { name, symbol: "PEPE", token };
    assert.equal(tokenLabel(pool), "PEPE");
    assert.equal(tokenSubSymbol(pool), null);
    assert.equal(tokenLine(pool), "PEPE");
  }
  assert.equal(searchResultTitle(" (PEPE)", token), "PEPE");
});

test("a token without a name or symbol reads as its short address", () => {
  // Production's own launch 0x10382be9… names itself " " with symbol " ".
  for (const blank of [null, "", " "]) {
    const pool = { name: blank, symbol: blank, token };
    assert.equal(tokenLabel(pool), "0x5c9f…6b30");
    assert.equal(tokenSubSymbol(pool), null);
    assert.equal(tokenLine(pool), "0x5c9f…6b30");
  }
  assert.equal(searchResultTitle("  ( )", token), "0x5c9f…6b30");
});

test("an empty-string name with a blank symbol never leaves a separator", () => {
  const pool = { name: "", symbol: "  ", token };
  assert.doesNotMatch(tokenLine(pool)!, /[·()]/);
  assert.doesNotMatch(searchResultTitle(" ()", token), /[·()]/);
});

test("a name is trimmed, and nothing is invented without a token", () => {
  assert.equal(
    tokenLabel({ name: "  Uptober ", symbol: "UPTOBER" }),
    "Uptober",
  );
  assert.equal(tokenLabel({ name: " ", symbol: "" }), undefined);
});

test("a search title of another shape is kept", () => {
  assert.equal(
    searchResultTitle("Look up this address", token),
    "Look up this address",
  );
});
