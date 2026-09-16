import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodeFunctionResult,
  multicall3Abi,
  type Hex,
} from "viem";
import { Rpc, RpcCallError, hex } from "./rpc";

/** Multicall3's deterministic deployment address. Robinhood Chain carries the
 * same bytecode there (3,808 bytes, verified by eth_getCode on 2026-09-16). */
export const canonicalMulticall3Address: Hex =
  "0xca11bde05977b3631167028862be2a173976ca11";
export const multicallPolicy = Object.freeze({
  /** Member calls per aggregate3 request. Metadata and balance reads cost a
   * few thousand gas each, so 200 stays far below any provider eth_call cap. */
  maxCalls: 200,
});
export interface MulticallConfig {
  /** null reads every contract call individually, as before batching. */
  address: Hex | null;
  maxCalls: number;
}
/** MULTICALL3_ADDRESS: unset or empty selects the canonical deployment, "0"
 * disables aggregation, any other value must be the deployed address. */
export function multicallConfig(
  env: Record<string, string | undefined> = process.env,
): MulticallConfig {
  const raw = env.MULTICALL3_ADDRESS?.trim();
  const maxCalls = multicallPolicy.maxCalls;
  if (raw === undefined || raw === "")
    return { address: canonicalMulticall3Address, maxCalls };
  if (raw === "0") return { address: null, maxCalls };
  if (!/^0x[\da-f]{40}$/i.test(raw)) throw Error("Invalid MULTICALL3_ADDRESS");
  return { address: raw.toLowerCase() as Hex, maxCalls };
}
export interface ContractRead {
  to: Hex;
  data: Hex;
}
/** Retained beside logs, receipts and headers. Both shapes verify one result:
 * an eth_call row is the raw reply to one call; a multicall3 row is one
 * aggregate3 request (allowFailure for every member) with its raw reply, which
 * decodes back to each member's success flag and return data by position. */
export type ContractReadEvidence =
  | { kind: "eth_call"; to: Hex; data: Hex; block: Hex; result: Hex }
  | {
      kind: "multicall3";
      to: Hex;
      block: Hex;
      calls: { target: Hex; callData: Hex }[];
      result: Hex;
    };
export interface ContractReads {
  /** One raw return value per requested read, in request order. */
  results: Hex[];
  evidence: ContractReadEvidence[];
  /** Whether any aggregate3 request served this batch. */
  aggregated: boolean;
}
const isHex = (v: unknown): v is Hex =>
  typeof v === "string" && /^0x[\da-f]*$/i.test(v);
/** The member calls of one aggregate3 request, e.g. to serve retained
 * evidence back to a collector or to inspect what a request asked for. */
export function decodeAggregateRequest(
  data: Hex,
): { target: Hex; allowFailure: boolean; callData: Hex }[] {
  const { functionName, args } = decodeFunctionData({
    abi: multicall3Abi,
    data,
  });
  if (functionName !== "aggregate3") throw Error("Not an aggregate3 request");
  return (
    args as [readonly { target: Hex; allowFailure: boolean; callData: Hex }[]]
  )[0].map((c) => ({ ...c }));
}
/** The raw reply an aggregate3 request receives for these member outcomes. */
export function encodeAggregateReply(
  rows: readonly { success: boolean; returnData: Hex }[],
): Hex {
  return encodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    result: rows.map((r) => ({ ...r })),
  });
}
function aggregateData(calls: { target: Hex; callData: Hex }[]): Hex {
  return encodeFunctionData({
    abi: multicall3Abi,
    functionName: "aggregate3",
    args: [calls.map((c) => ({ ...c, allowFailure: true }))],
  });
}
function decodeAggregate(result: unknown, members: number) {
  if (!isHex(result) || result === "0x") return null;
  let rows: readonly { success: boolean; returnData: Hex }[];
  try {
    rows = decodeFunctionResult({
      abi: multicall3Abi,
      functionName: "aggregate3",
      data: result,
    });
  } catch {
    return null;
  }
  return rows.length === members ? rows : null;
}
// Transports whose aggregate request already failed once (no code at the
// configured address, a revert, or an undecodable reply) read individually
// for the rest of their life. Workers create one Rpc per cycle or per pool.
const unusable = new WeakSet<Rpc>();
async function readEach(
  rpc: Rpc,
  reads: ContractRead[],
  block: Hex,
): Promise<ContractReads> {
  const results = await rpc.batch<Hex>(
    "eth_call",
    reads.map((r) => [{ to: r.to, data: r.data }, block]),
  );
  if (results.length !== reads.length) throw Error("Missing contract reads");
  return {
    results,
    evidence: reads.map((r, i) => ({
      kind: "eth_call",
      to: r.to,
      data: r.data,
      block,
      result: results[i],
    })),
    aggregated: false,
  };
}
/** Read many view calls pinned to one block. With Multicall3 configured and
 * usable, members travel in bounded aggregate3 requests billed as one eth_call
 * each. A member that fails inside an aggregate is re-read on its own, so its
 * outcome (including the thrown failure) is exactly the individual read's; the
 * other members keep their aggregate results. */
export async function readContracts(
  rpc: Rpc,
  reads: ContractRead[],
  blockNumber: number,
  config: MulticallConfig = multicallConfig(),
): Promise<ContractReads> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0)
    throw Error("Invalid contract read block");
  if (
    !Number.isSafeInteger(config.maxCalls) ||
    config.maxCalls < 1 ||
    config.maxCalls > 1000 ||
    (config.address !== null && !/^0x[\da-f]{40}$/i.test(config.address))
  )
    throw Error("Invalid multicall configuration");
  for (const r of reads)
    if (!/^0x[\da-f]{40}$/i.test(r.to) || !isHex(r.data))
      throw Error("Invalid contract read");
  const block = hex(blockNumber);
  if (!reads.length) return { results: [], evidence: [], aggregated: false };
  const multicall = config.address;
  if (multicall === null || unusable.has(rpc))
    return readEach(rpc, reads, block);
  const chunks: { target: Hex; callData: Hex }[][] = [];
  for (let i = 0; i < reads.length; i += config.maxCalls)
    chunks.push(
      reads
        .slice(i, i + config.maxCalls)
        .map((r) => ({ target: r.to, callData: r.data })),
    );
  let replies: unknown[];
  try {
    replies = await rpc.batch<unknown>(
      "eth_call",
      chunks.map((calls) => [
        { to: multicall, data: aggregateData(calls) },
        block,
      ]),
    );
  } catch (error) {
    if (!(error instanceof RpcCallError)) throw error;
    unusable.add(rpc);
    return readEach(rpc, reads, block);
  }
  const decoded = chunks.map((calls, i) =>
    decodeAggregate(replies[i], calls.length),
  );
  if (
    replies.length !== chunks.length ||
    decoded.some((rows) => rows === null)
  ) {
    unusable.add(rpc);
    return readEach(rpc, reads, block);
  }
  const results: (Hex | null)[] = [];
  const evidence: ContractReadEvidence[] = [];
  chunks.forEach((calls, i) => {
    evidence.push({
      kind: "multicall3",
      to: multicall,
      block,
      calls,
      result: replies[i] as Hex,
    });
    for (const row of decoded[i]!)
      results.push(row.success ? row.returnData : null);
  });
  const failed = results.flatMap((r, i) => (r === null ? [i] : []));
  if (failed.length) {
    const retried = await readEach(
      rpc,
      failed.map((i) => reads[i]),
      block,
    );
    failed.forEach((i, j) => (results[i] = retried.results[j]));
    evidence.push(...retried.evidence);
  }
  return { results: results as Hex[], evidence, aggregated: true };
}
export interface ExpandedContractRead {
  to: Hex;
  data: Hex;
  block: Hex;
  /** null when the member failed inside its aggregate request. */
  result: Hex | null;
}
/** Expand retained call evidence to one row per member call, re-deriving each
 * aggregate member's result from the raw aggregate3 reply by position. Rows
 * come back in evidence order; an individually re-read member appears again as
 * its own eth_call row after the aggregate that reported its failure. */
export function expandContractReads(
  evidence: ContractReadEvidence[],
): ExpandedContractRead[] {
  const rows: ExpandedContractRead[] = [];
  for (const entry of evidence) {
    if (entry.kind === "eth_call") {
      rows.push({
        to: entry.to,
        data: entry.data,
        block: entry.block,
        result: entry.result,
      });
      continue;
    }
    if (entry.kind !== "multicall3")
      throw Error("Unknown contract read evidence");
    const decoded = decodeAggregate(entry.result, entry.calls.length);
    if (!decoded) throw Error("Aggregate evidence does not match its calls");
    entry.calls.forEach((c, i) =>
      rows.push({
        to: c.target,
        data: c.callData,
        block: entry.block,
        result: decoded[i].success ? decoded[i].returnData : null,
      }),
    );
  }
  return rows;
}
/** The exact request bytes an aggregate evidence row was sent with. */
export function aggregateRequestData(
  entry: Extract<ContractReadEvidence, { kind: "multicall3" }>,
): Hex {
  return aggregateData(entry.calls);
}
