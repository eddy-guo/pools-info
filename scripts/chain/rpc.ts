import type { Hex } from "viem";
import type { RawLog } from "./events";

export class Rpc {
  requests = 0;
  constructor(
    private url = process.env.ROBINHOOD_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com",
  ) {}
  async call<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      this.requests++;
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: this.requests,
            method,
            params,
          }),
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw Error(`RPC HTTP ${res.status}`);
        const body = (await res.json()) as {
          result?: T;
          error?: { message: string };
        };
        if (body.error || body.result === undefined)
          throw Error(
            `RPC ${method}: ${body.error?.message ?? "missing result"}`,
          );
        return body.result;
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw Error("RPC retry exhausted");
  }
  async logs(
    address: string | readonly string[],
    topics: unknown[],
    from: number,
    to: number,
  ): Promise<RawLog[]> {
    const rows: RawLog[] = [];
    // Explicit bounded chunks. No silent partial snapshot on failure.
    for (let start = from; start <= to; start += 10000) {
      rows.push(
        ...(await this.call<RawLog[]>("eth_getLogs", [
          {
            address,
            topics,
            fromBlock: hex(start),
            toBlock: hex(Math.min(to, start + 9999)),
          },
        ])),
      );
    }
    const unique = new Map<string, RawLog>();
    for (const row of rows) {
      const block = Number(row.blockNumber);
      if (row.removed || block < from || block > to)
        throw Error("Noncanonical/out-of-range log");
      const id = `${row.transactionHash}:${row.logIndex}`;
      const prior = unique.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row))
        throw Error("Conflicting duplicate log");
      unique.set(id, row);
    }
    return [...unique.values()].sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) ||
        Number(a.logIndex) - Number(b.logIndex),
    );
  }
}
export const hex = (n: number): Hex => `0x${n.toString(16)}`;
