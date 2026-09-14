import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildHolderLedger,
  type HolderTransfer,
  type HolderLedgerOptions,
} from "./holders";
import type { Address } from "./types";

const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`;
const digest = (n: number): Address => `0x${n.toString(16).padStart(64, "0")}`;
const zero = addr(0),
  token = addr(10),
  alice = addr(11),
  bob = addr(12),
  manager = addr(13);
function event(
  block: number,
  from: Address,
  to: Address,
  value: bigint,
  logIndex = 0,
): HolderTransfer {
  return {
    token,
    txHash: digest(block),
    blockHash: digest(block + 100),
    block,
    logIndex,
    from,
    to,
    valueRaw: value.toString(),
  };
}
function options(totalSupplyRaw = "100"): HolderLedgerOptions {
  return {
    token,
    totalSupplyRaw,
    coverage: {
      fromBlock: 1,
      toBlock: 10,
      tokenBirthBlock: 1,
      cutoffBlockHash: digest(110),
    },
    infrastructure: [{ address: manager, label: "PoolManager" }],
  };
}

test("mint, transfers, burn and infrastructure reconcile without converting raw units to Number", () => {
  const supply = 2n ** 200n;
  const result = buildHolderLedger(
    [
      event(1, zero, alice, supply),
      event(2, alice, manager, 100n),
      event(3, alice, bob, 25n),
      event(4, bob, zero, 5n),
    ],
    options((supply - 5n).toString()),
  );
  assert.equal(result.complete, true);
  assert.equal(result.trackedSupplyRaw, (supply - 5n).toString());
  assert.deepEqual(result.balances, [
    {
      address: alice,
      balanceRaw: (supply - 125n).toString(),
      kind: "holder",
      infrastructureLabel: null,
    },
    {
      address: manager,
      balanceRaw: "100",
      kind: "infrastructure",
      infrastructureLabel: "PoolManager",
    },
    {
      address: bob,
      balanceRaw: "20",
      kind: "holder",
      infrastructureLabel: null,
    },
  ]);
  assert.equal(result.positiveHoldersIncludingInfrastructure, 3);
  assert.equal(result.positiveHoldersExcludingInfrastructure, 2);
  assert.ok(!("pnl" in result.balances[0]));
});

test("self transfers retain balance, zero transfers create no holders, and fully burned holders disappear", () => {
  const result = buildHolderLedger(
    [
      event(1, zero, alice, 100n),
      event(2, alice, alice, 100n),
      event(3, bob, manager, 0n),
      event(4, zero, zero, 0n),
      event(5, alice, zero, 100n),
    ],
    options("0"),
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.balances, []);
  assert.equal(result.uniqueTransferCount, 5);
  assert.throws(
    () => buildHolderLedger([event(1, alice, alice, 1n)], options()),
    /Negative holder balance/,
  );
});

test("replay is idempotent across case differences, deterministic and does not mutate caller events", () => {
  const mint = event(1, zero, alice, 100n);
  const send = event(2, alice, bob, 50n, 1);
  const input = [
    send,
    mint,
    {
      ...mint,
      token: `0x${token.slice(2).toUpperCase()}` as Address,
      to: `0x${alice.slice(2).toUpperCase()}` as Address,
    },
  ];
  const saved = JSON.stringify(input);
  const result = buildHolderLedger(input, options());
  assert.deepEqual(result, buildHolderLedger([mint, send], options()));
  assert.equal(JSON.stringify(input), saved);
  assert.deepEqual(
    result.balances.map((row) => row.address),
    [alice, bob],
  );
});

test("same-block log ordering is respected before debit validation", () => {
  const result = buildHolderLedger(
    [event(1, alice, bob, 100n, 2), event(1, zero, alice, 100n, 1)],
    options(),
  );
  assert.equal(result.balances[0].address, bob);
  assert.equal(result.balances.length, 1);
});

test("supply equality cannot claim complete history without verified token-birth coverage", () => {
  for (const coverage of [
    { ...options().coverage, tokenBirthBlock: null },
    { ...options().coverage, fromBlock: 2 },
  ]) {
    const result = buildHolderLedger([event(2, zero, alice, 100n)], {
      ...options(),
      coverage,
    });
    assert.equal(result.supplyMatches, true);
    assert.equal(result.complete, false);
    assert.deepEqual(result.incompleteReasons, ["missing_birth_coverage"]);
  }
  const mismatch = buildHolderLedger([event(1, zero, alice, 99n)], options());
  assert.equal(mismatch.complete, false);
  assert.equal(mismatch.supplyMatches, false);
  assert.deepEqual(mismatch.incompleteReasons, ["supply_mismatch"]);
});

test("incomplete inventory, conflicting events and canonical block conflicts fail closed", () => {
  const mint = event(1, zero, alice, 100n);
  assert.throws(
    () => buildHolderLedger([event(1, alice, bob, 1n)], options()),
    /Negative holder balance/,
  );
  assert.throws(
    () => buildHolderLedger([mint, event(2, alice, zero, 101n)], options()),
    /Negative holder balance/,
  );
  assert.throws(
    () => buildHolderLedger([mint, { ...mint, valueRaw: "99" }], options()),
    /Conflicting duplicate transfer/,
  );
  assert.throws(
    () => buildHolderLedger([mint, { ...mint, txHash: digest(99) }], options()),
    /Conflicting event block\/log position/,
  );
  assert.throws(
    () =>
      buildHolderLedger(
        [mint, { ...event(1, alice, bob, 1n, 1), blockHash: digest(500) }],
        options(),
      ),
    /Conflicting canonical block hashes/,
  );
  assert.throws(
    () =>
      buildHolderLedger(
        [{ ...event(10, zero, alice, 100n), blockHash: digest(500) }],
        options(),
      ),
    /Conflicting canonical block hashes/,
  );
});

test("invalid token, amount, index and coverage values never enter the ledger", () => {
  const mint = event(1, zero, alice, 100n);
  for (const valueRaw of [
    "-1",
    "1.2",
    "01",
    "0xff",
    "1e18",
    (1n << 256n).toString(),
  ])
    assert.throws(
      () => buildHolderLedger([{ ...mint, valueRaw }], options()),
      /amount/i,
    );
  for (const block of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => buildHolderLedger([{ ...mint, block }], options()),
      /index/,
    );
  assert.throws(
    () => buildHolderLedger([{ ...mint, token: bob }], options()),
    /Mixed token/,
  );
  assert.throws(
    () => buildHolderLedger([{ ...mint, from: "0xno" }], options()),
    /address/,
  );
  assert.throws(
    () => buildHolderLedger([{ ...mint, txHash: "0x01" }], options()),
    /hash/,
  );
  assert.throws(
    () => buildHolderLedger([event(11, zero, alice, 100n)], options()),
    /outside captured coverage/,
  );
  assert.throws(
    () =>
      buildHolderLedger([], {
        ...options(),
        coverage: { ...options().coverage, fromBlock: 11 },
      }),
    /coverage range/,
  );
  assert.throws(
    () =>
      buildHolderLedger([], {
        ...options(),
        coverage: { ...options().coverage, tokenBirthBlock: 11 },
      }),
    /coverage range/,
  );
});

test("infrastructure configuration requires explicit consistent nonzero labels", () => {
  for (const infrastructure of [
    [{ address: zero, label: "burn" }],
    [{ address: manager, label: " " }],
    [
      { address: manager, label: "PoolManager" },
      { address: manager, label: "Router" },
    ],
  ])
    assert.throws(
      () => buildHolderLedger([], { ...options("0"), infrastructure }),
      /infrastructure/,
    );
});
