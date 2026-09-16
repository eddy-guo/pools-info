import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";
import {
  aggregateRequestData,
  canonicalMulticall3Address,
  decodeAggregateRequest,
  encodeAggregateReply,
  expandContractReads,
  multicallConfig,
  readContracts,
  type ContractRead,
  type MulticallConfig,
} from "./multicall";
import { Rpc, RpcCallError, hex } from "./rpc";

const addr = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const value = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
const config: MulticallConfig = {
  address: canonicalMulticall3Address,
  maxCalls: 2,
};
const reads: ContractRead[] = [1, 2, 3, 4, 5].map((n) => ({
  to: addr(n),
  data: `0x${n.toString(16).padStart(8, "0")}`,
}));
/** A provider that answers plain calls and Multicall3 aggregates alike. */
function provider(
  answer: (to: Hex, data: Hex) => Hex | null,
  options: { aggregateReply?: (rows: Hex) => unknown; throwOn?: Hex } = {},
) {
  const rpc = new Rpc();
  const requests: { to: Hex; data: Hex; block: unknown }[] = [];
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    assert.equal(method, "eth_call");
    return params.map((p) => {
      const call = p[0] as { to: Hex; data: Hex };
      requests.push({ ...call, block: p[1] });
      if (call.to !== canonicalMulticall3Address) {
        if (call.to === options.throwOn) throw new RpcCallError();
        const reply = answer(call.to, call.data);
        if (reply === null) throw new RpcCallError();
        return reply;
      }
      const rows = decodeAggregateRequest(call.data).map((c) => {
        assert.equal(c.allowFailure, true);
        const reply = answer(c.target, c.callData);
        return { success: reply !== null, returnData: reply ?? "0x" };
      });
      const encoded = encodeAggregateReply(rows);
      return options.aggregateReply ? options.aggregateReply(encoded) : encoded;
    }) as T[];
  };
  return { rpc, requests };
}
test("configuration defaults to the canonical Multicall3, can be disabled or pointed elsewhere", () => {
  assert.deepEqual(multicallConfig({}), {
    address: canonicalMulticall3Address,
    maxCalls: 200,
  });
  assert.equal(
    multicallConfig({ MULTICALL3_ADDRESS: " " }).address,
    canonicalMulticall3Address,
  );
  assert.equal(multicallConfig({ MULTICALL3_ADDRESS: "0" }).address, null);
  assert.equal(
    multicallConfig({
      MULTICALL3_ADDRESS: addr(0xabc).toUpperCase().replace("0X", "0x"),
    }).address,
    addr(0xabc),
  );
  assert.throws(
    () => multicallConfig({ MULTICALL3_ADDRESS: "0x12" }),
    /MULTICALL3_ADDRESS/,
  );
});
test("aggregate reads return per-call results in order, bounded per request, with evidence that expands back to each member", async () => {
  const p = provider((to) => value(BigInt(to)));
  const r = await readContracts(p.rpc, reads, 1500, config);
  assert.equal(r.aggregated, true);
  assert.deepEqual(
    r.results,
    reads.map((x) => value(BigInt(x.to))),
  );
  // Five members at two per aggregate: three eth_call requests, none to a token.
  assert.equal(p.requests.length, 3);
  assert.ok(
    p.requests.every(
      (q) => q.to === canonicalMulticall3Address && q.block === hex(1500),
    ),
  );
  assert.equal(r.evidence.length, 3);
  assert.deepEqual(
    r.evidence.map((e) => e.kind),
    ["multicall3", "multicall3", "multicall3"],
  );
  assert.deepEqual(
    expandContractReads(r.evidence),
    reads.map((x) => ({
      to: x.to,
      data: x.data,
      block: hex(1500),
      result: value(BigInt(x.to)),
    })),
  );
  const first = r.evidence[0];
  assert.equal(first.kind, "multicall3");
  if (first.kind === "multicall3")
    assert.equal(aggregateRequestData(first), p.requests[0].data);
});
test("a member that fails inside an aggregate is re-read individually; its outcome is the individual read's", async () => {
  const bad = addr(3);
  const p = provider((to) => (to === bad ? null : value(BigInt(to))));
  await assert.rejects(readContracts(p.rpc, reads, 1500, config), RpcCallError);
  // The aggregates were still served; only the failed member was retried alone.
  assert.deepEqual(
    p.requests.map((q) => q.to),
    [
      canonicalMulticall3Address,
      canonicalMulticall3Address,
      canonicalMulticall3Address,
      bad,
    ],
  );
  // When the individual read succeeds, the batch does too and both rows are retained.
  let attempts = 0;
  const flaky = provider((to, data) =>
    to === bad && attempts++ === 0 ? null : value(BigInt(to) + BigInt(data)),
  );
  const r = await readContracts(flaky.rpc, reads, 1500, config);
  assert.deepEqual(
    r.results,
    reads.map((x) => value(BigInt(x.to) + BigInt(x.data))),
  );
  assert.deepEqual(
    r.evidence.map((e) => e.kind),
    ["multicall3", "multicall3", "multicall3", "eth_call"],
  );
  const rows = expandContractReads(r.evidence);
  assert.equal(rows.length, 6);
  assert.equal(rows[2].result, null);
  assert.deepEqual(rows[5], {
    to: bad,
    data: reads[2].data,
    block: hex(1500),
    result: value(BigInt(bad) + BigInt(reads[2].data)),
  });
});
test("no code at the configured address, a reverting aggregate or a malformed reply fall back to individual reads for the rest of that transport", async () => {
  for (const [aggregateReply, aggregates] of [
    [() => "0x", 3],
    [() => "0x1234", 3],
    [() => null, 3],
    // The provider rejects the whole aggregate request at its first member.
    [
      () => {
        throw new RpcCallError();
      },
      1,
    ],
  ] as const) {
    const p = provider((to) => value(BigInt(to)), { aggregateReply });
    const r = await readContracts(p.rpc, reads, 1500, config);
    assert.equal(r.aggregated, false);
    assert.deepEqual(
      r.results,
      reads.map((x) => value(BigInt(x.to))),
    );
    assert.deepEqual(
      r.evidence.map((e) => e.kind),
      reads.map(() => "eth_call"),
    );
    assert.deepEqual(
      p.requests.map((q) => q.to),
      [
        ...Array.from({ length: aggregates }, () => canonicalMulticall3Address),
        ...reads.map((x) => x.to),
      ],
    );
    const again = await readContracts(p.rpc, reads.slice(0, 1), 1500, config);
    assert.equal(again.aggregated, false);
    assert.equal(p.requests.at(-1)!.to, reads[0].to);
    assert.equal(p.requests.length, aggregates + 6);
  }
  // Transport failures are not aggregate failures: they propagate unchanged.
  const down = new Rpc();
  down.batch = async () => {
    throw Error("fetch failed");
  };
  await assert.rejects(
    readContracts(down, reads, 1500, config),
    /fetch failed/,
  );
});
test("disabled aggregation and empty batches read individually; invalid inputs are rejected", async () => {
  const p = provider((to) => value(BigInt(to)));
  const r = await readContracts(p.rpc, reads, 7, {
    address: null,
    maxCalls: 200,
  });
  assert.equal(r.aggregated, false);
  assert.deepEqual(
    p.requests.map((q) => q.to),
    reads.map((x) => x.to),
  );
  assert.deepEqual(await readContracts(p.rpc, [], 7, config), {
    results: [],
    evidence: [],
    aggregated: false,
  });
  assert.equal(p.requests.length, 5);
  await assert.rejects(readContracts(p.rpc, reads, -1, config), /block/);
  await assert.rejects(
    readContracts(p.rpc, reads, 7, { address: "0x12", maxCalls: 1 }),
    /multicall configuration/,
  );
  await assert.rejects(
    readContracts(p.rpc, [{ to: "0x1", data: "0x" }], 7, config),
    /Invalid contract read/,
  );
  assert.throws(
    () =>
      expandContractReads([
        {
          kind: "multicall3",
          to: canonicalMulticall3Address,
          block: "0x7",
          calls: [],
          result: "0x",
        },
      ]),
    /does not match/,
  );
});
