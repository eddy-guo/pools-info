import test from "node:test";
import assert from "node:assert/strict";
import { collectSnapshot } from "./collector";
import { Rpc } from "./rpc";

test("historical captures reject cutoffs ahead of the safe head before reading events", async () => {
  class HeadRpc extends Rpc {
    async call<T>(method: string): Promise<T> {
      if (method === "eth_chainId") return "0x1237" as T;
      if (method === "eth_blockNumber") return "0x400" as T;
      throw Error("Unexpected data read");
    }
  }
  for (const toBlock of [-1, 1.5, Number.NaN, 897, 1024])
    await assert.rejects(
      collectSnapshot({ rpc: new HeadRpc(), toBlock }),
      /Invalid historical cutoff/,
    );
});
