import test from "node:test";
import assert from "node:assert/strict";
import { holdDuration } from "./hold-duration";

test("an average hold reads in the export's hours and minutes", () => {
  assert.equal(holdDuration(0), "<1m");
  assert.equal(holdDuration(59.9), "<1m");
  assert.equal(holdDuration(60), "1m");
  assert.equal(holdDuration(964), "16m");
  assert.equal(holdDuration(3599), "59m");
  assert.equal(holdDuration(3600), "1h 00m");
  assert.equal(holdDuration(13260), "3h 41m");
  assert.equal(holdDuration(86399), "23h 59m");
  assert.equal(holdDuration(86400), "1d 00h");
  assert.equal(holdDuration(220319), "2d 13h");
});
