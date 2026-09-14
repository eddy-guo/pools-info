import { Rpc } from "@pools/chain";

/** Route log queries only, keeping archive state on the original provider.
 * Construct both clients together with identical total time/request limits.
 * Counters are shared so splitting providers cannot double the batch budget. */
export function withLogRpc(state: Rpc, logs: Rpc): Rpc {
  let verified = false;
  state.logs = async (address, topics, from, to) => {
    logs.requests = state.requests;
    logs.calls = state.calls;
    try {
      if (!verified) {
        if (Number(await logs.call<string>("eth_chainId", [])) !== 4663)
          throw Error("Wrong chain");
        verified = true;
      }
      return await logs.logs(address, topics, from, to);
    } finally {
      state.requests = logs.requests;
      state.calls = logs.calls;
    }
  };
  return state;
}
