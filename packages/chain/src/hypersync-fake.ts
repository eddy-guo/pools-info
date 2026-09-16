import { encodeAbiParameters, keccak256, toEventSelector } from "viem";
import type { HyperSyncQuery } from "./hypersync";
import { contracts, launchEvent, swapEvent, transferEvent } from "./events";
import { instantDeployments } from "./deployments";
import { tokenMetadataEvent, tokenMetadataFactory } from "./token-metadata";

/** In-memory stand-in for the HyperSync JSON API, shaped exactly like the
 * responses recorded under fixtures/hypersync: `data` is an array of chunks,
 * quantities are JSON numbers except the hex block timestamp, absent topics
 * are omitted, and pages end on complete blocks. Tests only. */
export interface FakeHyperSyncLog {
  block: number;
  logIndex: number;
  transactionIndex?: number;
  transactionHash: string;
  address: string;
  topics: string[];
  data: string;
  from: string;
  to?: string | null;
  status?: 0 | 1;
}
export interface FakeHyperSyncRequest {
  path: string;
  body?: HyperSyncQuery;
  headers: Record<string, string>;
}
export interface FakeHyperSyncOptions {
  height: number;
  logs?: FakeHyperSyncLog[];
  maxLogsPerPage?: number;
  maxBlocksPerPage?: number;
  hash?: (block: number) => string;
  timestamp?: (block: number) => number;
  /** Return a Response to override the next matching request. */
  intercept?: (
    request: FakeHyperSyncRequest,
    count: number,
  ) => Response | undefined;
}
export const word = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, "0")}`;
/** One verified instant launch as the chain emits it in one transaction: the
 * launcher's log, the factory's metadata and the strategy's TokenLaunched. */
export function fakeLaunch(options: {
  block: number;
  token: string;
  sender: string;
  transactionHash: string;
  metadata?: { description: string; website: string; image: string };
}) {
  const deployment = instantDeployments[0];
  const zero = "0x0000000000000000000000000000000000000000";
  const key = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [
      zero,
      options.token as `0x${string}`,
      deployment.fee,
      deployment.tickSpacing,
      zero,
    ],
  );
  const poolId = keccak256(key);
  const shared = {
    block: options.block,
    transactionHash: options.transactionHash,
    from: options.sender,
  };
  const logs: FakeHyperSyncLog[] = [
    {
      ...shared,
      logIndex: 0,
      address: deployment.launcher,
      topics: [word(1)],
      data: "0x",
    },
    ...(options.metadata
      ? [
          {
            ...shared,
            logIndex: 1,
            address: tokenMetadataFactory,
            topics: [toEventSelector(tokenMetadataEvent)],
            data: encodeAbiParameters(tokenMetadataEvent.inputs, [
              options.token as `0x${string}`,
              { ...options.metadata, extraData: "0x" },
            ]),
          },
        ]
      : []),
    {
      ...shared,
      logIndex: 2,
      address: deployment.strategy,
      topics: [
        toEventSelector(launchEvent),
        poolId,
        `0x${options.token.slice(2).padStart(64, "0")}`,
        `0x${deployment.feeSplitter.slice(2).padStart(64, "0")}`,
      ],
      data: key,
    },
  ];
  return { poolId, logs, deployment };
}
/** One PoolManager swap; amounts are the caller's BalanceDelta legs. */
export function fakeSwap(options: {
  block: number;
  logIndex: number;
  poolId: string;
  from: string;
  amounts?: [bigint, bigint];
  transactionHash?: string;
}): FakeHyperSyncLog {
  const [amount0, amount1] = options.amounts ?? [-10n, 200n];
  return {
    block: options.block,
    logIndex: options.logIndex,
    transactionHash:
      options.transactionHash ?? word(options.block * 100 + options.logIndex),
    address: contracts.manager,
    topics: [toEventSelector(swapEvent), options.poolId, word(4)],
    data: encodeAbiParameters(
      [
        { type: "int128" },
        { type: "int128" },
        { type: "uint160" },
        { type: "uint128" },
        { type: "int24" },
        { type: "uint24" },
      ],
      [amount0, amount1, 1n << 96n, 1n, 0, 2500],
    ),
    from: options.from,
  };
}
/** One ERC-20 Transfer of a token; the transaction initiator defaults to
 * `from`, as when a wallet moves its own tokens. */
export function fakeTransfer(options: {
  block: number;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
  transactionHash?: string;
  sender?: string;
  txTo?: string | null;
}): FakeHyperSyncLog {
  const topic = (a: string) =>
    `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  return {
    block: options.block,
    logIndex: options.logIndex,
    transactionHash:
      options.transactionHash ?? word(options.block * 100 + options.logIndex),
    address: options.token,
    topics: [
      toEventSelector(transferEvent),
      topic(options.from),
      topic(options.to),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [options.value]),
    from: options.sender ?? options.from,
    ...(options.txTo === undefined ? {} : { to: options.txTo }),
  };
}
export class FakeHyperSync {
  requests: FakeHyperSyncRequest[] = [];
  height: number;
  logs: FakeHyperSyncLog[];
  /** Hashes at and above this block change, as after a reorg. */
  reorgFrom: number | null = null;
  maxLogsPerPage: number;
  maxBlocksPerPage: number;
  private readonly baseHash: (block: number) => string;
  private readonly timestamp: (block: number) => number;
  private readonly intercept?: FakeHyperSyncOptions["intercept"];
  constructor(options: FakeHyperSyncOptions) {
    this.height = options.height;
    this.logs = [...(options.logs ?? [])];
    this.maxLogsPerPage = options.maxLogsPerPage ?? 5000;
    this.maxBlocksPerPage = options.maxBlocksPerPage ?? Infinity;
    this.baseHash = options.hash ?? word;
    this.timestamp = options.timestamp ?? ((n) => n * 2);
    this.intercept = options.intercept;
  }
  hashOf(block: number) {
    const base = this.baseHash(block);
    return this.reorgFrom !== null && block >= this.reorgFrom
      ? `0x${(BigInt(base) + 0x100000000n).toString(16).padStart(64, "0")}`
      : base;
  }
  block(number: number) {
    return {
      number,
      hash: this.hashOf(number),
      parent_hash: number === 0 ? word(0) : this.hashOf(number - 1),
      timestamp: `0x${this.timestamp(number).toString(16)}`,
    };
  }
  private matches(log: FakeHyperSyncLog, query: HyperSyncQuery) {
    const selections = query.logs ?? [];
    if (!selections.length) return false;
    return selections.some((s) => {
      if (
        s.address?.length &&
        !s.address.some((a) => a.toLowerCase() === log.address.toLowerCase())
      )
        return false;
      return (s.topics ?? []).every(
        (values, i) =>
          !values.length ||
          values.some((v) => v.toLowerCase() === log.topics[i]?.toLowerCase()),
      );
    });
  }
  respond(query: HyperSyncQuery) {
    const from = query.from_block;
    const end = Math.min(query.to_block ?? this.height + 1, this.height + 1);
    const logs: Record<string, unknown>[] = [];
    const transactions = new Map<string, Record<string, unknown>>();
    const blocks = new Map<number, Record<string, unknown>>();
    let next = from,
      consumedBlocks = 0;
    for (let n = from; n < end; n++) {
      if (consumedBlocks >= this.maxBlocksPerPage) break;
      // Like the documented server: a limit may be slightly exceeded to
      // complete the current block, and the page then ends.
      const own = this.logs
        .filter((l) => l.block === n && this.matches(l, query))
        .sort((a, b) => a.logIndex - b.logIndex);
      for (const l of own) {
        const row: Record<string, unknown> = {
          removed: false,
          log_index: l.logIndex,
          transaction_index: l.transactionIndex ?? 0,
          transaction_hash: l.transactionHash,
          block_hash: this.hashOf(n),
          block_number: n,
          address: l.address,
          data: l.data,
        };
        l.topics.forEach((t, i) => (row[`topic${i}`] = t));
        logs.push(row);
        transactions.set(l.transactionHash, {
          block_hash: this.hashOf(n),
          block_number: n,
          from: l.from,
          hash: l.transactionHash,
          to:
            l.to === undefined
              ? "0x8876789976decbfcbbbe364623c63652db8c0904"
              : l.to,
          transaction_index: l.transactionIndex ?? 0,
          status: l.status ?? 1,
        });
        blocks.set(n, this.block(n));
      }
      if (query.include_all_blocks) blocks.set(n, this.block(n));
      consumedBlocks++;
      next = n + 1;
      if (logs.length >= this.maxLogsPerPage) break;
    }
    const pick = (row: Record<string, unknown>, fields?: string[]) =>
      fields
        ? Object.fromEntries(
            Object.entries(row).filter(([k]) => fields.includes(k)),
          )
        : row;
    const chunk: Record<string, unknown> = {};
    const f = query.field_selection;
    if (f.log) chunk.logs = logs.map((r) => pick(r, f.log));
    if (f.transaction)
      chunk.transactions = [...transactions.values()].map((r) =>
        pick(r, f.transaction),
      );
    if (f.block)
      chunk.blocks = [...blocks.values()]
        .sort((a, b) => Number(a.number) - Number(b.number))
        .map((r) => pick(r, f.block));
    return {
      data: [chunk],
      archive_height: this.height,
      next_block: next,
      total_execution_time: 1,
      rollback_guard: null,
    };
  }
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as HyperSyncQuery)
        : undefined;
    const request = { path: url.pathname, body, headers };
    this.requests.push(request);
    const override = this.intercept?.(request, this.requests.length);
    if (override) return override;
    const json =
      url.pathname === "/height"
        ? { height: this.height }
        : body
          ? this.respond(body)
          : null;
    if (!json) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
