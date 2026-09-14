import type {
  HypersyncClient,
  Query,
  QueryResponse,
} from "@envio-dev/hypersync-client";
import type { Hex } from "viem";
import type { RawLog } from "./events";
import { hex } from "./rpc";

export type Header = { number: Hex; timestamp: Hex; hash: Hex };
type Client = Pick<HypersyncClient, "get" | "getHeight" | "getChainId">;
const hashPattern = /^0x[0-9a-f]{64}$/i;

// Bulk history supplies logs and their headers. Complete transaction receipts
// and state reads remain independent RPC inputs to attribution/reconciliation.
export class HyperSyncHistory {
  requests = 0;
  readonly blocks = new Map<number, Header>();
  private started = Date.now();
  constructor(
    private client: Client,
    private timeoutMs = 45000,
  ) {}

  static async create(token: string, timeoutMs?: number) {
    const { HypersyncClient } = await import("@envio-dev/hypersync-client");
    return new HyperSyncHistory(
      new HypersyncClient({
        url: "https://robinhood.hypersync.xyz",
        apiToken: token,
        httpReqTimeoutMillis: 5000,
        maxNumRetries: 1,
        proactiveRateLimitSleep: false,
      }),
      timeoutMs,
    );
  }

  async height() {
    if ((await this.client.getChainId()) !== 4663)
      throw Error("Wrong archive chain");
    const height = await this.client.getHeight();
    if (!Number.isSafeInteger(height) || height < 128)
      throw Error("Invalid archive height");
    return height;
  }

  private async query(query: Query): Promise<QueryResponse> {
    if (Date.now() - this.started >= this.timeoutMs || this.requests >= 100)
      throw Error("Bulk collection budget exceeded");
    this.requests++;
    const result = await this.client.get(query);
    if (
      !Number.isSafeInteger(result.nextBlock) ||
      result.nextBlock <= query.fromBlock ||
      result.nextBlock > query.toBlock!
    )
      throw Error("Incomplete or non-progressing archive page");
    for (const block of result.data.blocks) {
      if (
        !Number.isSafeInteger(block.number) ||
        block.number! < query.fromBlock ||
        block.number! >= result.nextBlock ||
        !Number.isSafeInteger(block.timestamp) ||
        block.timestamp! < 0 ||
        !hashPattern.test(block.hash ?? "")
      )
        throw Error("Invalid archive block");
      const header = {
        number: hex(block.number!),
        timestamp: hex(block.timestamp!),
        hash: block.hash!.toLowerCase() as Hex,
      };
      const prior = this.blocks.get(block.number!);
      if (prior && JSON.stringify(prior) !== JSON.stringify(header))
        throw Error("Archive block changed between queries");
      this.blocks.set(block.number!, header);
    }
    return result;
  }

  async verifyCutoff(number: number, expectedHash: Hex) {
    await this.query({
      fromBlock: number,
      toBlock: number + 1,
      includeAllBlocks: true,
      fieldSelection: { block: ["Number", "Timestamp", "Hash"] },
    });
    if (this.blocks.get(number)?.hash !== expectedHash.toLowerCase())
      throw Error("Archive and RPC cutoff disagree");
  }

  async logs(
    address: string | readonly string[],
    topics: string[],
    from: number,
    to: number,
  ): Promise<RawLog[]> {
    const addresses = (
      typeof address === "string" ? [address] : [...address]
    ).map((a) => a.toLowerCase());
    const rows = new Map<string, RawLog>();
    let previousGuard: QueryResponse["rollbackGuard"];
    for (let cursor = from; cursor <= to;) {
      const page = await this.query({
        fromBlock: cursor,
        toBlock: to + 1,
        logs: [{ address: addresses, topics: topics.map((t) => [t]) }],
        maxNumLogs: 5000,
        fieldSelection: {
          block: ["Number", "Timestamp", "Hash"],
          log: [
            "BlockNumber",
            "BlockHash",
            "TransactionHash",
            "LogIndex",
            "Address",
            "Data",
            "Removed",
            "Topic0",
            "Topic1",
            "Topic2",
            "Topic3",
          ],
        },
      });
      const guard = page.rollbackGuard;
      if (
        previousGuard &&
        (!guard ||
          guard.firstBlockNumber !== previousGuard.blockNumber + 1 ||
          guard.firstParentHash !== previousGuard.hash)
      )
        throw Error("Archive rollback between pages");
      previousGuard = guard;
      for (const log of page.data.logs) {
        const block = this.blocks.get(log.blockNumber!);
        const eventTopics = log.topics.filter((t): t is string => t != null);
        if (
          log.removed ||
          !Number.isSafeInteger(log.blockNumber) ||
          log.blockNumber! < cursor ||
          log.blockNumber! >= page.nextBlock ||
          !Number.isSafeInteger(log.logIndex) ||
          log.logIndex! < 0 ||
          !hashPattern.test(log.transactionHash ?? "") ||
          !block ||
          block.hash !== log.blockHash?.toLowerCase() ||
          !addresses.includes(log.address?.toLowerCase() ?? "") ||
          !/^0x(?:[0-9a-f]{2})*$/i.test(log.data ?? "") ||
          !eventTopics.every((t) => hashPattern.test(t)) ||
          !topics.every(
            (topic, i) => topic.toLowerCase() === eventTopics[i]?.toLowerCase(),
          )
        )
          throw Error("Invalid or mismatched archive log");
        const row: RawLog = {
          address: log.address!.toLowerCase() as Hex,
          topics: eventTopics.map((t) => t.toLowerCase()) as RawLog["topics"],
          data: log.data!.toLowerCase() as Hex,
          blockNumber: hex(log.blockNumber!),
          blockHash: block.hash,
          transactionHash: log.transactionHash!.toLowerCase() as Hex,
          logIndex: hex(log.logIndex!),
          removed: false,
        };
        const id = `${row.transactionHash}:${row.logIndex}`;
        const prior = rows.get(id);
        if (prior && JSON.stringify(prior) !== JSON.stringify(row))
          throw Error("Conflicting archive log");
        rows.set(id, row);
      }
      if (rows.size > 20000)
        throw Error("Archive scan exceeds bounded log limit");
      cursor = page.nextBlock;
    }
    return [...rows.values()].sort(
      (a, b) =>
        Number(a.blockNumber) - Number(b.blockNumber) ||
        Number(a.logIndex) - Number(b.logIndex),
    );
  }
}
