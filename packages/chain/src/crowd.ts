import {
  decodeAbiParameters,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbiItem,
  toEventSelector,
  type Hex,
} from "viem";
import { instantDeployments } from "./deployments";
import type { RawLog } from "./events";

/** pools.xyz crowd launches (docs/CROWD-LAUNCHES.md): Uniswap's continuous
 * clearing auction (CCA) created through pools.xyz's LiquidityLauncher and
 * one of the two LBPStrategy singletons, which migrates the raise and the
 * reserved tokens into an ordinary v4 pool once the auction graduates. The
 * addresses were verified on Blockscout (verified source) and the event
 * signatures re-hash to the deployed topics (report pools-cca-scope-scout-c1
 * section 1, 25 Sep 2026). Crowd is a lifecycle of its own and never joins
 * the Instant registry in deployments.ts. */
export const crowdRegistryRevision = "robinhood-crowd-v1" as const;
/** The upstream sources the event signatures were read from (main branch,
 * read 25 Sep 2026): Uniswap/liquidity-launcher and
 * Uniswap/continuous-clearing-auction. */
export const crowdRegistrySourceRevision =
  "1eda9f0c0243e2fdc0cbe0d665200ffa8c2ba53a";
export const crowdAuctionSourceRevision =
  "6c9e559e63a7a141a4fe4bd5aa0f47fee1354b58";
export const crowdFactory = Object.freeze({
  /** ContinuousClearingAuctionFactory, created at block 5,446,662. */
  address: "0x000000001f26a0044baa66024e7b6599c61963f8",
  deployedAtBlock: 5446662,
});
export interface CrowdStrategy {
  generation: "lbp-v1" | "lbp-v2";
  strategy: string;
}
export const crowdStrategies: readonly CrowdStrategy[] = Object.freeze([
  // 4-hour auctions, the first on 11 Jul 2026.
  {
    generation: "lbp-v1",
    strategy: "0x05d552391067389ee44fec3924157ed33f976000",
  },
  // 1-hour auctions, the first on 14 Sep 2026.
  {
    generation: "lbp-v2",
    strategy: "0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000",
  },
]);
const zero = "0x0000000000000000000000000000000000000000";
/** The pools.xyz quick-launch ("Crowd") template: what separates pools.xyz's
 * own crowd launches from every other auction the shared factory creates.
 * Over the factory's whole history (4,569 auctions, 1,007 graduated, read on
 * 25 Sep 2026) this admits 2,711 auctions and exactly 54 graduated pools;
 * crowd.test.ts replays the recorded graduations against it. */
export const crowdTemplate = Object.freeze({
  /** 500,000,000 tokens of 18 decimals offered in the auction. */
  auctionAmountRaw: 500_000_000n * 10n ** 18n,
  /** Raised in native ETH. */
  currency: zero,
  /** Unsold tokens are burned. */
  tokensRecipient: "0x000000000000000000000000000000000000dead",
  /** endBlock - startBlock: four hours on the v1 strategy, one on v2. */
  auctionBlocks: [144000, 36000] as readonly number[],
});
/** The LP positions go to one of pools.xyz's pinned fee splitters, whose
 * registry flag says whether the creator takes a share of the fees. */
const feeSplitters = new Map<string, boolean>();
for (const d of instantDeployments) {
  const prior = feeSplitters.get(d.feeSplitter);
  if (prior !== undefined && prior !== d.creatorFees)
    throw Error("Inconsistent pinned fee splitter");
  feeSplitters.set(d.feeSplitter, d.creatorFees);
}
export const crowdLaunchers: readonly string[] = [
  ...new Set(instantDeployments.map((d) => d.launcher)),
];

export const auctionCreatedEvent = parseAbiItem(
  "event AuctionCreated(address indexed auction, address indexed token, uint256 amount, bytes configData)",
);
export const initializerCreatedEvent = parseAbiItem(
  "event InitializerCreated(address indexed initializer, (address token, address currency, uint64 migrationBlock, uint128 reservedTokenAmountForLP, address recipient, address positionRecipient, (uint24 fee, int24 tickSpacing, address hook) poolParameters, bytes positionDefinitions, bytes lpAllocationSchedule) migrationParams)",
);
export const migratedEvent = parseAbiItem(
  "event Migrated(address indexed initializer, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) indexed key, uint160 initialSqrtPriceX96, bytes plan)",
);
export const crowdTopics = Object.freeze({
  auctionCreated: toEventSelector(auctionCreatedEvent),
  initializerCreated: toEventSelector(initializerCreatedEvent),
  migrated: toEventSelector(migratedEvent),
});
/** The factory's configData: abi.encode(AuctionParameters). */
const auctionParameters = [
  {
    type: "tuple",
    components: [
      { name: "currency", type: "address" },
      { name: "tokensRecipient", type: "address" },
      { name: "fundsRecipient", type: "address" },
      { name: "startBlock", type: "uint64" },
      { name: "endBlock", type: "uint64" },
      { name: "claimBlock", type: "uint64" },
      { name: "tickSpacing", type: "uint256" },
      { name: "validationHook", type: "address" },
      { name: "floorPrice", type: "uint256" },
      { name: "requiredCurrencyRaised", type: "uint128" },
      { name: "auctionStepsData", type: "bytes" },
    ],
  },
] as const;
const lower = (s: string) => s.toLowerCase();
export function getCrowdStrategy(address: string): CrowdStrategy | undefined {
  return crowdStrategies.find((s) => s.strategy === lower(address));
}
/** The hookless v4 pool id of an ETH/token pair: keccak256(abi.encode(key)). */
export function crowdPoolId(token: string, fee: number, tickSpacing: number) {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ],
      [zero, token as Hex, fee, tickSpacing, zero],
    ),
  ).toLowerCase();
}

/** A pools.xyz template auction as its creation transaction declares it. */
export interface CrowdAuction {
  auction: string;
  token: string;
  strategy: string;
  /** The hookless ETH/token pool the migration must create. */
  poolId: string;
  fee: number;
  tickSpacing: number;
  /** The fee splitter the LP positions go to, and its registry flag. */
  positionRecipient: string;
  creatorFees: boolean;
  createdBlock: number;
  createdTx: string;
}
export type CrowdRejection =
  | "not_template"
  | "unpinned_fee_splitter"
  | "hooked_pool"
  | "inconsistent_initializer";
/** Pair a factory AuctionCreated with the pinned strategy's InitializerCreated
 * for the same auction in the same transaction and apply the template rule.
 * Returns the auction, or why it is not a pools.xyz crowd launch. Throws on a
 * log that is not what its pinned source emits. */
export function crowdAuctionOf(
  created: RawLog,
  initializer: RawLog,
): CrowdAuction | CrowdRejection {
  if (
    created.removed ||
    initializer.removed ||
    lower(created.address) !== crowdFactory.address ||
    lower(created.topics[0] ?? "") !== crowdTopics.auctionCreated ||
    lower(initializer.topics[0] ?? "") !== crowdTopics.initializerCreated ||
    lower(created.transactionHash) !== lower(initializer.transactionHash) ||
    lower(created.blockHash) !== lower(initializer.blockHash) ||
    created.blockNumber !== initializer.blockNumber
  )
    throw Error("Unexpected crowd launch source");
  const strategy = getCrowdStrategy(initializer.address);
  if (!strategy) throw Error("Unexpected crowd launch source");
  const a = decodeEventLog({
    abi: [auctionCreatedEvent],
    data: created.data,
    topics: created.topics,
    strict: true,
  }).args;
  const i = decodeEventLog({
    abi: [initializerCreatedEvent],
    data: initializer.data,
    topics: initializer.topics,
    strict: true,
  }).args;
  const auction = lower(a.auction),
    token = lower(a.token);
  if (lower(i.initializer) !== auction)
    throw Error("Unexpected crowd launch source");
  let config;
  try {
    [config] = decodeAbiParameters(auctionParameters, a.configData);
  } catch {
    return "not_template";
  }
  const p = i.migrationParams;
  if (
    a.amount !== crowdTemplate.auctionAmountRaw ||
    lower(config.currency) !== crowdTemplate.currency ||
    lower(config.tokensRecipient) !== crowdTemplate.tokensRecipient ||
    !crowdTemplate.auctionBlocks.includes(
      Number(config.endBlock - config.startBlock),
    )
  )
    return "not_template";
  // The strategy itself refuses these at registration; a disagreement means
  // the logs are not one registration.
  if (
    lower(config.fundsRecipient) !== strategy.strategy ||
    lower(p.token) !== token ||
    lower(p.currency) !== crowdTemplate.currency
  )
    return "inconsistent_initializer";
  if (lower(p.poolParameters.hook) !== zero) return "hooked_pool";
  const creatorFees = feeSplitters.get(lower(p.positionRecipient));
  if (creatorFees === undefined) return "unpinned_fee_splitter";
  const { fee, tickSpacing } = p.poolParameters;
  return {
    auction,
    token,
    strategy: strategy.strategy,
    poolId: crowdPoolId(token, fee, tickSpacing),
    fee,
    tickSpacing,
    positionRecipient: lower(p.positionRecipient),
    creatorFees,
    createdBlock: Number(created.blockNumber),
    createdTx: lower(created.transactionHash),
  };
}
export interface CrowdMigration {
  strategy: string;
  auction: string;
  poolId: string;
}
/** A pinned strategy's Migrated log: the auction it graduated and the pool id
 * (the indexed PoolKey topic is keccak256 of the encoded key). */
export function decodeCrowdMigration(log: RawLog): CrowdMigration {
  const strategy = getCrowdStrategy(log.address);
  if (
    log.removed ||
    !strategy ||
    lower(log.topics[0] ?? "") !== crowdTopics.migrated ||
    log.topics.length !== 3
  )
    throw Error("Unexpected crowd launch source");
  // Decodes the data words; the struct topic stays its hash.
  decodeAbiParameters([{ type: "uint160" }, { type: "bytes" }], log.data);
  return {
    strategy: strategy.strategy,
    auction: lower("0x" + log.topics[1]!.slice(26)),
    poolId: lower(log.topics[2]!),
  };
}
/** The migration graduates exactly this auction into exactly its pool. */
export function migrationMatches(auction: CrowdAuction, m: CrowdMigration) {
  return (
    m.strategy === auction.strategy &&
    m.auction === auction.auction &&
    m.poolId === auction.poolId
  );
}
