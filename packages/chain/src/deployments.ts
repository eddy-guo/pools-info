import type { Address, Hex } from "viem";
/** Pinned official Uniswap SDK plus chain-4663 getter/code verification.
 * Evidence and source links: docs/DEPLOYMENT-REGISTRY.md. Crowd is a different
 * lifecycle and deliberately does not participate in this Instant registry. */
export const instantRegistryRevision = "robinhood-instant-v2";
export const instantRegistrySourceRevision =
  "2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f";
export const instantRegistryVerifiedAtBlock = 63243824;
export interface InstantDeployment {
  chainId: 4663;
  kind: "instant";
  generation: string;
  strategy: Address;
  launcher: Address;
  feeSplitter: Address;
  creatorFees: boolean;
  tickSpacing: number;
  initialTick: number;
  minLaunchTick: number;
  fee: number;
  deployedAtBlock: number;
  runtimeCodeHash: Hex;
}
export const instantDeployments = [
  {
    chainId: 4663,
    kind: "instant",
    generation: "c3f9506",
    strategy: "0x60d73b21cdf2ea846ab3d58699bbbb8f29d72491",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0x7198c32a497c09497e04c86cf8f77a244a9e4b8f",
    creatorFees: true,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 22754669,
    runtimeCodeHash:
      "0x2562884d759c0753bffcd3e7fb60891bb1df15be441e6fe399e45fb5f3c87c4e",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "c3f9506",
    strategy: "0xfce92c70f1fc017b72f6dd7a00d9e38725c7fbd1",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
    creatorFees: false,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 22754669,
    runtimeCodeHash:
      "0xcfdc2cbbf2d955ed4e87a556b81ea338218601296f27c4b4ea12689aa92f8fbf",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "8e40a35",
    strategy: "0xce57498d3474dcc244dfb6710ffbe6d4441cd2b2",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0x7198c32a497c09497e04c86cf8f77a244a9e4b8f",
    creatorFees: true,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 23385219,
    runtimeCodeHash:
      "0x50c9d66d818a575b0c8ac7af64fd0beeb92aeed26db5a71c6901cdbd135539ba",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "8e40a35",
    strategy: "0x583a7903152b95831e82fff534448dee081754ec",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
    creatorFees: false,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 23385219,
    runtimeCodeHash:
      "0x0c2952a42a22148ccca35433ca55255e5f23a4e610cffa1aea5cb01807878f08",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "3e05da8",
    strategy: "0x9f67b864b565966dfcc2e0c6ba2483b2d5ff4b00",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0x7198c32a497c09497e04c86cf8f77a244a9e4b8f",
    creatorFees: true,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 23618250,
    runtimeCodeHash:
      "0x50c9d66d818a575b0c8ac7af64fd0beeb92aeed26db5a71c6901cdbd135539ba",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "3e05da8",
    strategy: "0x16b63f1c8415fd68591c31fb3c6796a333dd640c",
    launcher: "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
    feeSplitter: "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
    creatorFees: false,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 23618250,
    runtimeCodeHash:
      "0x0c2952a42a22148ccca35433ca55255e5f23a4e610cffa1aea5cb01807878f08",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "v311",
    strategy: "0x3f556b542105d5efbbefe7c766a4919c76b960fb",
    launcher: "0x7a6c474b4dcd35b72203d2b569eafe4c9b5c768e",
    feeSplitter: "0x6cc1b74fc1be1ff373fa07f3381856f38103e653",
    creatorFees: true,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 28080860,
    runtimeCodeHash:
      "0xde7da44a0b62c0b3a6d99d2bc883b2bdd9f3fc5dcfbe6c270d51e06e13f8f47d",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "v311",
    strategy: "0x36bdb859518c89f764337cd5c24762d2aa650f3c",
    launcher: "0x7a6c474b4dcd35b72203d2b569eafe4c9b5c768e",
    feeSplitter: "0xdf50f4ea2207f9d2a753a3dae729b36fdef13b23",
    creatorFees: false,
    tickSpacing: 60,
    initialTick: 198060,
    minLaunchTick: -208980,
    fee: 2500,
    deployedAtBlock: 28080860,
    runtimeCodeHash:
      "0x9c91c2d1627ceeec54bdee042534465fd47c6a1cdd72991e404c79bca94c9b0f",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "20260805",
    strategy: "0x23f8209572b4a1c2ad88a42749e830791fb027f1",
    launcher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
    feeSplitter: "0xeff166aaf189323c58dc27ed1206eb2c37faacdf",
    creatorFees: true,
    tickSpacing: 25,
    initialTick: 198050,
    minLaunchTick: -160100,
    fee: 2500,
    deployedAtBlock: 28519960,
    runtimeCodeHash:
      "0x29df27cf43533e9b3708dcd2a2c0fd17a1a8796407e7d39375f47e5c809cffca",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "20260805",
    strategy: "0xad44d55e7f8337c3ce113fbb591486e85be104b2",
    launcher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
    feeSplitter: "0x222d6d4f1ce59b0d48d5505114ec8addc90a4359",
    creatorFees: false,
    tickSpacing: 25,
    initialTick: 198050,
    minLaunchTick: -160100,
    fee: 2500,
    deployedAtBlock: 28519981,
    runtimeCodeHash:
      "0x6944058fa8339bcf018c4a2ddc043d378b47516f8756db34202bdc6cf93a9a8e",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "v330",
    strategy: "0x7c48dde3b447381f4d986334679b3afc7f2d35c2",
    launcher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
    feeSplitter: "0x9411fa7f956f64aa7981aa27cb3bc6ec0415449c",
    creatorFees: true,
    tickSpacing: 25,
    initialTick: 198050,
    minLaunchTick: -160100,
    fee: 2500,
    deployedAtBlock: 57982785,
    runtimeCodeHash:
      "0xbcf3403daaaf65a9e575e8736872ff79865c9988a303f1bb6ada7ae5ddfc4bdd",
  },
  {
    chainId: 4663,
    kind: "instant",
    generation: "v330",
    strategy: "0xc9566675b1ea42861546f3c5b74ace2c79c49572",
    launcher: "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
    feeSplitter: "0x882ae5e2095435a62fd1bbdefcb637f5ceafc0ee",
    creatorFees: false,
    tickSpacing: 25,
    initialTick: 198050,
    minLaunchTick: -160100,
    fee: 2500,
    deployedAtBlock: 57983002,
    runtimeCodeHash:
      "0x549e67dfd42358ddaeed7ef63437239245c67d381342b0ab1ee0470c3b97d8d9",
  },
] as const satisfies readonly InstantDeployment[];
const byStrategy = new Map<string, InstantDeployment>(
  instantDeployments.map((d) => [d.strategy, d]),
);
export function getInstantDeployment(
  strategy: string,
): InstantDeployment | undefined {
  return byStrategy.get(strategy.toLowerCase());
}
export const instantRegistryStartBlock = Math.min(
  ...instantDeployments.map((d) => d.deployedAtBlock),
);
