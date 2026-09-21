import test from "node:test";
import assert from "node:assert/strict";
import {
  ledgerTransferProvenance,
  type TransferProtocolRole,
} from "./ledger-provenance";
import {
  applyLedgerEvents,
  createLedgerState,
  ledgerZeroAddress,
  planLedgerBatch,
  type LedgerBatchRows,
  type LedgerSwap,
  type LedgerTransfer,
} from "./ledger";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const token = addr(1),
  wallet = addr(2),
  other = addr(3),
  launcher = addr(4),
  router = addr(5),
  manager = addr(6),
  creator = addr(7);
const poolId = hash(1);
const rules = { manager, router };
const registry = [{ poolId, token }];
const protocols: TransferProtocolRole[] = [
  {
    address: launcher,
    class: "launcher",
    evidence: "recorded:launcher",
    fromBlock: 5,
  },
  {
    address: router,
    class: "wrapper_or_router",
    evidence: "recorded:router",
    fromBlock: 5,
  },
  {
    address: manager,
    class: "protocol",
    evidence: "recorded:manager",
    fromBlock: 5,
  },
];
const launchers = new Map([[poolId, creator]]);
const transfer = (
  from: string,
  to: string,
  logIndex: number,
  value = "100",
  block = 10,
): LedgerTransfer => ({
  txHash: hash(block),
  blockHash: hash(block + 100),
  block,
  timestamp: block * 100,
  logIndex,
  token,
  from,
  to,
  value,
});
const swap = (fields: Partial<LedgerSwap> = {}): LedgerSwap => ({
  txHash: hash(10),
  blockHash: hash(110),
  block: 10,
  timestamp: 1000,
  logIndex: 0,
  token,
  poolId,
  initiator: wallet,
  txTo: router,
  side: "buy",
  ethWei: "900719925474099312345",
  tokenRaw: "100",
  sqrtPriceX96: "1",
  liquidity: "1",
  tick: 0,
  ...fields,
});
function observe(rows: LedgerBatchRows) {
  const events = planLedgerBatch(rows, rules);
  const before = structuredClone(events);
  const provenance = ledgerTransferProvenance(
    rows,
    events,
    protocols,
    launchers,
  );
  assert.deepEqual(events, before); // Annotation cannot alter the fold's plan.
  const oldState = createLedgerState(),
    newState = createLedgerState();
  applyLedgerEvents(oldState, before);
  applyLedgerEvents(newState, events);
  assert.deepEqual(newState, oldState);
  return { events, provenance };
}

test("observed endpoint classes distinguish mint, token, launcher, router and launch initiator without inventing an owner", () => {
  const sources = [
    ledgerZeroAddress,
    token,
    launcher,
    router,
    creator,
    other,
    manager,
  ];
  const { provenance } = observe({
    registry,
    swaps: [],
    transfers: sources.map((a, i) =>
      transfer(a, wallet, i, "900719925474099312345"),
    ),
  });
  assert.deepEqual(
    provenance.map((p) => p.fromRole.class),
    [
      "mint_burn",
      "token_contract",
      "launcher",
      "wrapper_or_router",
      "launch_initiator",
      "unclassified",
      "protocol",
    ],
  );
  assert.ok(
    provenance.every(
      (p) =>
        p.toRole.class === "unclassified" &&
        p.value === "900719925474099312345",
    ),
  );
  const reverse = observe({
    registry,
    swaps: [],
    transfers: sources.map((a, i) => transfer(wallet, a, i)),
  }).provenance;
  assert.deepEqual(
    reverse.map((p) => p.toRole),
    provenance.map((p) => p.fromRole),
  );
  assert.ok(reverse.every((p) => p.fromRole.class === "unclassified"));
  const older = observe({
    registry,
    swaps: [],
    transfers: [transfer(launcher, wallet, 0, "100", 4)],
  });
  assert.equal(older.provenance[0].fromRole.class, "unclassified");
});

test("residual provenance retains the complete gross graph instead of pretending net tokens came from the first sender", () => {
  const transfers = [
    transfer(manager, router, 1),
    transfer(router, wallet, 2),
    transfer(other, wallet, 3, "30"),
    transfer(wallet, other, 4, "10"),
    transfer(wallet, wallet, 5, "7"),
  ];
  const { events, provenance } = observe({
    registry,
    swaps: [swap()],
    transfers,
  });
  const residual = events.find(
    (e) => e.kind === "inflow" && e.wallet === wallet,
  );
  assert.equal(residual?.tokenRaw, 20n);
  assert.deepEqual(
    provenance.map((p) => [p.from, p.to, p.value]),
    transfers.map((p) => [p.from, p.to, p.value]),
  );
  assert.ok(provenance.every((p) => p.context === "residual"));
  // Full attribution with a pass-through has no unexplained movement to retain.
  assert.equal(
    observe({ registry, swaps: [swap()], transfers: transfers.slice(0, 2) })
      .provenance.length,
    0,
  );
});

test("ambiguous swaps retain legs even when the fold applies no net transfer; tx recipient is not a verified wrapper", () => {
  const transfers = [
    transfer(manager, other, 1, "40"),
    transfer(other, wallet, 2, "40"),
  ];
  const { events, provenance } = observe({
    registry,
    swaps: [swap({ txTo: other })],
    transfers,
  });
  assert.equal(events[0].kind, "unattributed_swap");
  assert.equal(provenance.length, 2);
  assert.ok(provenance.every((p) => p.context === "unattributed_swap"));
  assert.equal(provenance[0].toRole.class, "unclassified");
  assert.equal(provenance[1].fromRole.class, "unclassified");
});
