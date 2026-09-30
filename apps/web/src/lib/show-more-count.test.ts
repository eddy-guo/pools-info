import test from "node:test";
import assert from "node:assert/strict";
import { showMoreCount } from "./show-more-count";

test("a pending count prints nothing", () => {
  assert.equal(showMoreCount(25, null), "");
});

test("only a real zero reads 0 results", () => {
  assert.equal(showMoreCount(25, 0), "0 results");
});

test("a known total reads the rows on show against it", () => {
  assert.equal(showMoreCount(25, 52), "Showing 25 of 52");
  assert.equal(showMoreCount(25, 10), "Showing 10 of 10");
  assert.equal(showMoreCount(1000, 1234), "Showing 1,000 of 1,234");
});
