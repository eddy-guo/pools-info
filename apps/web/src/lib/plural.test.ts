import test from "node:test";
import assert from "node:assert/strict";
import { countLabel, plural } from "./plural";

test("a count of exactly 1 takes the singular noun", () => {
  assert.equal(plural(1, "pool"), "pool");
  assert.equal(countLabel(1, "pool"), "1 pool");
});

test("0 and every count past 1 take the plural noun", () => {
  assert.equal(countLabel(0, "pool"), "0 pools");
  assert.equal(countLabel(2, "pool"), "2 pools");
  assert.equal(countLabel(30160, "trade"), "30,160 trades");
  assert.equal(countLabel(1_000_000, "result"), "1,000,000 results");
});

test("an irregular plural is named, not derived", () => {
  assert.equal(countLabel(1, "launch", "launches"), "1 launch");
  assert.equal(countLabel(3, "launch", "launches"), "3 launches");
  assert.equal(plural(1, "has", "have"), "has");
  assert.equal(plural(4, "has", "have"), "have");
});
