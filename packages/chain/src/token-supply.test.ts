import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";
import {
  canonicalMulticall3Address,
  decodeAggregateRequest,
  encodeAggregateReply,
  expandContractReads,
} from "./multicall";
import { Rpc, hex } from "./rpc";
import { readTokenSupplies, totalSupplySelector } from "./token-supply";

const token = (n: number): Hex => `0x${n.toString(16).padStart(40, "0")}`;
const word = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);

test("supplies are read in bounded aggregates at one block and decoded per token", async () => {
  const rpc = new Rpc();
  const requests: { to: Hex; block: unknown; members: number }[] = [];
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    assert.equal(method, "eth_call");
    return params.map((p) => {
      const call = p[0] as { to: Hex; data: Hex };
      assert.equal(call.to, canonicalMulticall3Address);
      const members = decodeAggregateRequest(call.data);
      requests.push({ to: call.to, block: p[1], members: members.length });
      return encodeAggregateReply(
        members.map((m) => {
          assert.equal(m.callData, totalSupplySelector);
          const n = BigInt(m.target);
          // Token 3 answers with a short reply, which is not a supply.
          return {
            success: true,
            returnData: n === 3n ? "0x01" : word(n * 10n ** 27n),
          };
        }),
      );
    }) as T[];
  };
  const tokens = [1, 2, 3, 4, 5].map(token);
  const r = await readTokenSupplies(rpc, tokens, 65_000_000, {
    address: canonicalMulticall3Address,
    maxCalls: 2,
  });
  assert.deepEqual(
    requests.map((q) => [q.block, q.members]),
    [
      [hex(65_000_000), 2],
      [hex(65_000_000), 2],
      [hex(65_000_000), 1],
    ],
  );
  assert.deepEqual(r.supplies, [
    { token: token(1), supplyRaw: (10n ** 27n).toString(), block: 65_000_000 },
    {
      token: token(2),
      supplyRaw: (2n * 10n ** 27n).toString(),
      block: 65_000_000,
    },
    { token: token(3), supplyRaw: null, block: 65_000_000 },
    {
      token: token(4),
      supplyRaw: (4n * 10n ** 27n).toString(),
      block: 65_000_000,
    },
    {
      token: token(5),
      supplyRaw: (5n * 10n ** 27n).toString(),
      block: 65_000_000,
    },
  ]);
  assert.equal(expandContractReads(r.evidence).length, 5);
});

test("token addresses must be lower-case catalog addresses", async () => {
  const rpc = new Rpc();
  rpc.batch = async () => assert.fail("no request for invalid input");
  await assert.rejects(
    readTokenSupplies(rpc, ["0xABC" as Hex], 1),
    /Invalid token address/,
  );
  await assert.rejects(
    readTokenSupplies(rpc, [token(1).replace("0x", "0X") as Hex], 1),
    /Invalid token address/,
  );
});
