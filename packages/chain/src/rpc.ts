import type { Hex } from "viem";
import type { RawLog } from "./events";
type Request = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown[];
};
type Reply = { id: number; result?: unknown; error?: { message: string } };
class LogRangeLimit extends Error {
  constructor(readonly blocks: number) {
    super(`RPC log range limited to ${blocks} blocks`);
  }
}
export class Rpc {
  requests = 0;
  calls = 0;
  private started = Date.now();
  private nextRequestAt = 0;
  private logRange = 10000;
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
        const result = (await response.json().catch(() => null)) as
          Reply | Reply[] | null;
        // Some providers return plan limits as HTTP 400 JSON-RPC errors. Keep
        // provider messages private and only extract the advertised range size.
        if (
          !Array.isArray(body) &&
          body.method === "eth_getLogs" &&
          result &&
          !Array.isArray(result)
        ) {
          const match = result.error?.message?.match(
            /up to (?:a )?([\d,]+) block range/i,
          );
          const blocks = match ? Number(match[1].replaceAll(",", "")) : 0;
          if (
            Number.isSafeInteger(blocks) &&
            blocks > 0 &&
            blocks < this.logRange
          )
            throw new LogRangeLimit(blocks);
        }
        if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
        if (!result) throw Error("RPC returned invalid JSON");
        for (const row of Array.isArray(result) ? result : [result])
          if (row.error || row.result === undefined)
            throw Error("RPC returned an error or missing result");
        return result;
      } catch (error) {
        if (error instanceof LogRangeLimit || attempt === 3) throw error;
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
    // Plan-limited endpoints can use small ranges batched into one HTTP request.
    // Existing time/request budgets still apply; never return partial coverage.
    for (let start = from; start <= to;) {
      const ranges: { from: number; to: number }[] = [];
      const batchSize = this.logRange < 10000 ? 20 : 1;
      for (
        let next = start;
        next <= to && ranges.length < batchSize;
        next += this.logRange
      )
        ranges.push({ from: next, to: Math.min(to, next + this.logRange - 1) });
      const params = ranges.map((r) => [
        { address, topics, fromBlock: hex(r.from), toBlock: hex(r.to) },
      ]);
      try {
        const result =
          ranges.length === 1
            ? [await this.call<RawLog[]>("eth_getLogs", params[0])]
            : await this.batch<RawLog[]>("eth_getLogs", params);
        result.forEach((logs, i) => {
          if (!Array.isArray(logs)) throw Error("Invalid RPC log result");
          if (
            logs.some(
              (l) =>
                Number(l.blockNumber) < ranges[i].from ||
                Number(l.blockNumber) > ranges[i].to,
            )
          )
            throw Error("Out-of-range log batch");
          rows.push(...logs);
        });
        start = ranges.at(-1)!.to + 1;
      } catch (error) {
        if (!(error instanceof LogRangeLimit)) throw error;
        this.logRange = error.blocks;
      }
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
