import test from "node:test";
import assert from "node:assert/strict";
import { watchlistHeading } from "./watchlist";

test("the watchlist heading counts its pools in the right number", () => {
  assert.equal(watchlistHeading(true), "Shared watchlist");
  assert.equal(watchlistHeading(false), "Your watchlist");
  assert.equal(watchlistHeading(true, 1), "Shared watchlist · 1 pool");
  assert.equal(watchlistHeading(true, 2), "Shared watchlist · 2 pools");
  assert.equal(watchlistHeading(false, 0), "Your watchlist · 0 pools");
  assert.equal(watchlistHeading(false, 1), "Your watchlist · 1 pool");
});
