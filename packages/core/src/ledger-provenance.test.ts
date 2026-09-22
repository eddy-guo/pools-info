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
  otherWallet = addr(3),
  launcher = addr(4),
  router = addr(5),
  manager = addr(6),
  unregisteredWrapper = addr(7),
  farm = addr(8);
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
function observe(
  rows: LedgerBatchRows,
  roles: readonly TransferProtocolRole[] = protocols,
) {
  const events = planLedgerBatch(rows, rules);
  const before = structuredClone(events);
  const provenance = ledgerTransferProvenance(rows, events, roles);
  assert.deepEqual(events, before); // Annotation cannot alter the fold's plan.
  const oldState = createLedgerState(),
    newState = createLedgerState();
  applyLedgerEvents(oldState, before);
  applyLedgerEvents(newState, events);
  assert.deepEqual(newState, oldState);
  return { events, provenance };
}

test("observed endpoint classes distinguish intrinsic and registered roles without inventing an owner", () => {
  const sources = [ledgerZeroAddress, token, launcher, router, manager];
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
      "protocol",
    ],
  );
  assert.ok(
    provenance.every(
      (p) =>
        p.toRole.class === "unregistered" &&
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
  assert.ok(reverse.every((p) => p.fromRole.class === "unregistered"));
  const older = observe({
    registry,
    swaps: [],
    transfers: [transfer(launcher, wallet, 0, "100", 4)],
  });
  assert.equal(older.provenance[0].fromRole.class, "unregistered");
});

test("unregistered counterparties retain their addresses without wallet or farm guesses", () => {
  const endpoints = [otherWallet, unregisteredWrapper, farm];
  const { provenance } = observe({
    registry,
    swaps: [],
    transfers: [
      ...endpoints.map((from, i) => transfer(from, wallet, i, "100", 10 + i)),
      ...endpoints.map((to, i) => transfer(wallet, to, i, "100", 20 + i)),
    ],
  });
  assert.deepEqual(
    provenance.map((p) => ({
      from: p.from,
      fromClass: p.fromRole.class,
      to: p.to,
      toClass: p.toRole.class,
    })),
    [
      ...endpoints.map((from) => ({
        from,
        fromClass: "unregistered",
        to: wallet,
        toClass: "unregistered",
      })),
      ...endpoints.map((to) => ({
        from: wallet,
        fromClass: "unregistered",
        to,
        toClass: "unregistered",
      })),
    ],
  );
  assert.ok(
    provenance.every(
      (p) =>
        !["other_wallet", "farm"].includes(p.fromRole.class) &&
        !["other_wallet", "farm"].includes(p.toRole.class),
    ),
  );
});

test("positive evidence classifies wrappers and farms only inside its block range", () => {
  const roles: TransferProtocolRole[] = [
    ...protocols,
    {
      address: unregisteredWrapper,
      class: "wrapper",
      evidence: "protocol-registry:wrapper",
      fromBlock: 20,
      throughBlock: 29,
    },
    {
      address: farm,
      class: "farm",
      evidence: "signed-protocol-statement:farm",
      fromBlock: 20,
    },
  ];
  const at = (block: number, endpoint: string) =>
    observe(
      {
        registry,
        swaps: [],
        transfers: [transfer(endpoint, wallet, 0, "1", block)],
      },
      roles,
    ).provenance[0].fromRole;
  assert.deepEqual(at(19, unregisteredWrapper), {
    class: "unregistered",
    evidence: "registry:unregistered",
  });
  assert.deepEqual(at(20, unregisteredWrapper), {
    class: "wrapper",
    evidence: "protocol-registry:wrapper",
  });
  assert.deepEqual(at(29, unregisteredWrapper), {
    class: "wrapper",
    evidence: "protocol-registry:wrapper",
  });
  assert.deepEqual(at(30, unregisteredWrapper), {
    class: "unregistered",
    evidence: "registry:unregistered",
  });
  assert.deepEqual(at(20, farm), {
    class: "farm",
    evidence: "signed-protocol-statement:farm",
  });
  assert.deepEqual(at(20, otherWallet), {
    class: "unregistered",
    evidence: "registry:unregistered",
  });
});

test("residual provenance retains the complete gross graph instead of pretending net tokens came from the first sender", () => {
  const transfers = [
    transfer(manager, router, 1),
    transfer(router, wallet, 2),
    transfer(otherWallet, wallet, 3, "30"),
    transfer(wallet, otherWallet, 4, "10"),
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
    transfer(manager, otherWallet, 1, "40"),
    transfer(otherWallet, wallet, 2, "40"),
  ];
  const { events, provenance } = observe({
    registry,
    swaps: [swap({ txTo: otherWallet })],
    transfers,
  });
  assert.equal(events[0].kind, "unattributed_swap");
  assert.equal(provenance.length, 2);
  assert.ok(provenance.every((p) => p.context === "unattributed_swap"));
  assert.equal(provenance[0].toRole.class, "unregistered");
  assert.equal(provenance[1].fromRole.class, "unregistered");
});
