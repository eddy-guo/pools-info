import type { Hex } from "viem";
import {
  multicallConfig,
  readContracts,
  type ContractReadEvidence,
  type MulticallConfig,
} from "./multicall";
import type { Rpc } from "./rpc";

/** `totalSupply()` selector. */
export const totalSupplySelector: Hex = "0x18160ddd";

export interface TokenSupply {
  token: Hex;
  /** Raw units as a decimal string; null when the call failed or its reply is
   * not one ABI word, so an unreadable token is stored as unread, never 0. */
  supplyRaw: string | null;
  block: number;
}

/** Reads `totalSupply()` for every token pinned to one block, in Multicall3
 * aggregates of `config.maxCalls` members. The public RPC answers state only
 * near its head, so callers pass a block they have just read from it. */
export async function readTokenSupplies(
  rpc: Rpc,
  tokens: Hex[],
  block: number,
  config: MulticallConfig = multicallConfig(),
): Promise<{ supplies: TokenSupply[]; evidence: ContractReadEvidence[] }> {
  for (const token of tokens)
    if (!/^0x[\da-f]{40}$/.test(token)) throw Error("Invalid token address");
  const reads = await readContracts(
    rpc,
    tokens.map((to) => ({ to, data: totalSupplySelector })),
    block,
    config,
  );
  return {
    supplies: tokens.map((token, i) => {
      const word = reads.results[i];
      return {
        token,
        supplyRaw: /^0x[\da-f]{64}$/i.test(word)
          ? BigInt(word).toString()
          : null,
        block,
      };
    }),
    evidence: reads.evidence,
  };
}
