import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  http,
} from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
export function normalizeEnsName(value: string) {
  if (value.length > 255 || !value.toLowerCase().endsWith(".eth"))
    throw Error("Invalid ENS name");
  return normalize(value);
}
export async function resolveEnsName(name: string) {
  const client = createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
      { timeout: 8000, retryCount: 0 },
    ),
    ccipRead: false,
  });
  try {
    // Standard Ethereum address record. No arbitrary offchain resolver URLs are
    // followed from this server; unsupported resolvers report unavailable.
    return await client.getEnsAddress({
      name: normalizeEnsName(name),
      strict: true,
    });
  } catch (error) {
    const cause =
      error instanceof BaseError
        ? error.walk((e) => e instanceof ContractFunctionRevertedError)
        : undefined;
    if (
      cause instanceof ContractFunctionRevertedError &&
      cause.data?.errorName === "ResolverNotFound"
    )
      return null;
    throw error;
  }
}
