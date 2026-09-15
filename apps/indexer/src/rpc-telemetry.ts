import type { Rpc } from "@pools/chain";

export type RpcMethodCounts = Record<string, number>;
export type MeteredRpc = Rpc & { methodCounts?: RpcMethodCounts };
/** Count logical calls, including log-range constituents, before transport
 * retries. Both provider adapters can share the same fixed-method counter. */
export function trackRpcMethods(
  rpc: Rpc,
  counts: RpcMethodCounts = {},
): MeteredRpc {
  const call = rpc.call.bind(rpc);
  const batch = rpc.batch.bind(rpc);
  const increment = (method: string, count: number) => {
    const label = [
      "eth_chainId",
      "eth_blockNumber",
      "eth_getBlockByNumber",
      "eth_getTransactionReceipt",
      "eth_getBlockReceipts",
      "eth_getLogs",
      "eth_call",
    ].includes(method)
      ? method
      : "other";
    counts[label] = (counts[label] ?? 0) + count;
  };
  rpc.call = async <T>(method: string, params: unknown[]) => {
    increment(method, 1);
    return call<T>(method, params);
  };
  rpc.batch = async <T>(method: string, params: unknown[][]) => {
    increment(method, params.length);
    return batch<T>(method, params);
  };
  return Object.assign(rpc, { methodCounts: counts });
}
