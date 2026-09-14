import {
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  type Hex,
} from "viem";

export const contracts = {
  manager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  launcher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
  strategies: [
    "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
    "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
  ],
} as const;
// InstantLaunchStrategy at the deployment's published source commit dd8769c.
export const launchEvent = parseAbiItem(
  "event TokenLaunched(bytes32 indexed poolId, address indexed token, address indexed finalPositionRecipient, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key)",
);
export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
export const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);
export interface RawLog {
  address: Hex;
  topics: [Hex, ...Hex[]];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed: boolean;
}
export function decodeLaunch(log: RawLog) {
  if (
    log.removed ||
    !contracts.strategies.some((a) => a === log.address.toLowerCase())
  )
    throw Error("Unexpected launch source");
  const { args } = decodeEventLog({ abi: [launchEvent], ...log, strict: true });
  const k = args.key;
  const id = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
  if (
    id !== args.poolId ||
    k.currency0 !== "0x0000000000000000000000000000000000000000" ||
    k.currency1.toLowerCase() !== args.token.toLowerCase() ||
    k.hooks !== "0x0000000000000000000000000000000000000000"
  )
    throw Error("Unsupported or inconsistent PoolKey");
  return args;
}
export function decodeSwap(log: RawLog) {
  if (log.removed || log.address.toLowerCase() !== contracts.manager)
    throw Error("Unexpected swap source");
  const { args } = decodeEventLog({ abi: [swapEvent], ...log, strict: true });
  // v4 event amounts are the caller's BalanceDelta: input negative, output positive.
  if (
    !(args.amount0 < 0n && args.amount1 > 0n) &&
    !(args.amount0 > 0n && args.amount1 < 0n)
  )
    throw Error("Unsupported swap signs");
  return {
    ...args,
    side: args.amount0 < 0n ? ("buy" as const) : ("sell" as const),
    ethWei: abs(args.amount0).toString(),
    tokenRaw: abs(args.amount1).toString(),
  };
}
export function spotPriceWei(sqrt: bigint, decimals: number) {
  if (
    sqrt <= 0n ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  )
    throw Error("Invalid price inputs");
  return (((1n << 192n) * 10n ** BigInt(decimals)) / (sqrt * sqrt)).toString();
}
const abs = (v: bigint) => (v < 0n ? -v : v);
