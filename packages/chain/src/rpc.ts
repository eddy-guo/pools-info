import type { Hex } from "viem";
import type { RawLog } from "./events";
type Request = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
type Reply = { id: number; result?: unknown; error?: { message: string } };
export class Rpc {
  requests = 0;
  calls = 0;
  private started = Date.now();
  private nextRequestAt = 0;
  constructor(
    private url = process.env.ROBINHOOD_RPC_URL ??
      "https://rpc.mainnet.chain.robinhood.com",
    private limits: {
      timeoutMs?: number;
      maxRequests?: number;
      minIntervalMs?: number;
    } = {},
  ) {}
  private async send(body: Request | Request[]): Promise<Reply | Reply[]> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const scheduledAt = Math.max(Date.now(), this.nextRequestAt);
      this.nextRequestAt = scheduledAt + (this.limits.minIntervalMs ?? 0);
      const pause = scheduledAt - Date.now();
      if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
      const remaining =
        (this.limits.timeoutMs ?? 45000) - (Date.now() - this.started);
      if (remaining <= 0 || this.requests >= (this.limits.maxRequests ?? 1500))
        throw Error(
          `Collection budget exceeded after ${this.requests} HTTP requests and ${this.calls} RPC calls`,
        );
      this.requests++;
      try {
        const response = await fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1, Math.min(10000, remaining))),
          cache: "no-store",
        });
        if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
        const result = (await response.json()) as Reply | Reply[];
        for (const row of Array.isArray(result) ? result : [result])
          if (row.error || row.result === undefined)
            throw Error("RPC returned an error or missing result");
        return result;
      } catch (error) {
        if (attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw Error("RPC retry exhausted");
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.calls;
    const response = await this.send({ jsonrpc: "2.0", id, method, params });
    if (Array.isArray(response) || response.id !== id)
      throw Error("RPC response ID mismatch");
    return response.result as T;
  }
  async batch<T>(method: string, paramsList: unknown[][]): Promise<T[]> {
    const values: T[] = [];
    for (let i = 0; i < paramsList.length; i += 20) {
      const requests = paramsList.slice(i, i + 20).map((params) => ({
        jsonrpc: "2.0" as const,
        id: ++this.calls,
        method,
        params,
      }));
      const response = await this.send(requests);
      if (!Array.isArray(response) || response.length !== requests.length)
        throw Error("Incomplete RPC batch");
      const replies = new Map(response.map((r) => [r.id, r]));
      if (replies.size !== requests.length)
        throw Error("Duplicate RPC batch IDs");
      for (const request of requests) {
        const reply = replies.get(request.id);
        if (!reply) throw Error("Missing RPC batch ID");
        values.push(reply.result as T);
      }
    }
    return values;
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
