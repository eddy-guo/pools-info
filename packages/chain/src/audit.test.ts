import test from "node:test";
import assert from "node:assert/strict";
import { toEventSelector } from "viem";
import receiptData from "./fixtures/direct-buy.json";
import { attributeSwap, type Receipt } from "./audit";
import { contracts, swapEvent, type RawLog } from "./events";
// Robinhood block evidence, tx aa4665b6...0f6672, collected 2026-09-14.
const receipt = receiptData as unknown as Receipt;
const log = receipt.logs.find(
  (l) =>
    l.address.toLowerCase() === contracts.manager &&
    l.topics[0] === toEventSelector(swapEvent),
)!;
const token = "0x4636e0604cd1d0f638a6512c1c32e1cd25e2af02";
test("actual official-router buy reconciles exactly to the EOA's token receipt", () => {
  const result = attributeSwap(log, receipt, token, false);
  assert.equal(result.sender, receipt.from);
  assert.deepEqual(result.flags, []);
  assert.ok(result.matchedTransfer);
});
test("other routers and code-bearing senders remain unsupported", () => {
  const result = attributeSwap(log, { ...receipt, to: "0x1234" }, token, true);
  assert.ok(result.flags.includes("unsupported_route"));
  assert.ok(result.flags.includes("contract_sender"));
});
test("netting multiple swap legs does not falsely prove a simple direct route", () => {
  const result = attributeSwap(
    log,
    { ...receipt, logs: [...receipt.logs, { ...log, logIndex: "0xff" }] },
    token,
    false,
  );
  assert.ok(result.flags.includes("multiple_swap_route"));
});
test("a transfer to a different recipient cannot be attributed to tx.from", () => {
  const altered: Receipt = {
    ...receipt,
    logs: receipt.logs.map((l) =>
      l.address.toLowerCase() === token
        ? ({
            ...l,
            topics: [l.topics[0], l.topics[1], `0x${"1".repeat(64)}`],
          } as RawLog)
        : l,
    ),
  };
  const result = attributeSwap(log, altered, token, false);
  assert.ok(result.flags.includes("token_flow_mismatch"));
  assert.equal(result.matchedTransfer, null);
});
test("receipts from a different block fail instead of polluting accounting", () => {
  assert.throws(
    () => attributeSwap(log, { ...receipt, blockHash: "0x0000" }, token, false),
    /canonical/,
  );
});
test("a matching transaction hash is insufficient when its receipt has a different swap", () => {
  const altered = {
    ...receipt,
    logs: receipt.logs.filter((entry) => entry !== log),
  };
  assert.throws(() => attributeSwap(log, altered, token, false), /canonical/);
});
