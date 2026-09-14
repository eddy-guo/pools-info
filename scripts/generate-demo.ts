// Reproducible fictional market. NEVER label this as indexed chain data.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type {
  Address,
  Pool,
  Snapshot,
  Trade,
} from "../packages/core/src/types";
const address = (seed: string, bytes = 20) =>
  `0x${createHash("sha256")
    .update(`pools-demo:${seed}`)
    .digest("hex")
    .slice(0, bytes * 2)}` as Address;
const end = Date.parse("2026-09-14T06:00:00Z") / 1000;
const start = end - 7 * 86400;
const colors = [
  "#c4b5fd",
  "#a3e6b1",
  "#f7c478",
  "#fc9bbb",
  "#8dcefc",
  "#dfbbf7",
  "#ecdc8d",
  "#7bddcd",
];
const identities = [
  "quietcapital",
  "blockgarden",
  "earlybird",
  "sundaytrader",
  "pinknoise",
  "orbitally",
  "nightshift",
  "slowmoney",
].map((label, i) => ({ address: address(label), label, color: colors[i] }));
const seeds = [
  ["Orbit", "ORBIT", "◎", "#a9a0ff", "A small token with a wide orbit.", 9],
  ["Clover", "CLOV", "✳", "#8bdca8", "A little luck, shared by everyone.", 5],
  [
    "Daydream",
    "DREAM",
    "✦",
    "#efaccf",
    "For the ideas that arrive between blocks.",
    3,
  ],
  ["Mochi", "MOCHI", "m", "#ecc39c", "Soft edges. An onchain community.", -2],
  [
    "Signal",
    "SIG",
    "≋",
    "#9dcef9",
    "Finding a signal in the everyday noise.",
    7,
  ],
  [
    "Pebble",
    "PEBL",
    "●",
    "#cad39a",
    "Small beginnings, one ripple at a time.",
    2,
  ],
  ["Afterhours", "LATE", "☾", "#b99beb", "The internet does not sleep.", -4],
  ["Sundrop", "SUN", "☼", "#f8d27e", "A brighter corner of the chain.", 4],
  ["Lily", "LILY", "✿", "#97d7c9", "A community growing at its own pace.", 6],
  ["Ripple", "RIPL", "≈", "#8fbef2", "Every idea starts with a ripple.", -1],
  ["Kite", "KITE", "◇", "#f4a092", "Something worth looking up for.", 3],
  [
    "Common Ground",
    "GROUND",
    "⊞",
    "#c7b6a1",
    "A crowd launch built around shared beginnings.",
    4,
  ],
] as const;
const pools: Pool[] = seeds.map((s, i) => ({
  id: address(`pool:${i}`, 32),
  token: address(`token:${i}`),
  name: s[0],
  symbol: s[1],
  mark: s[2],
  color: s[3],
  description: s[4],
  decimals: 18,
  supply: (1000000000n * 10n ** 18n).toString(),
  mode: i === 11 ? "crowd" : "instant",
  creator: identities[i % 4].address,
  createdAt: start - (12 - i) * 86400,
  liquidityWei: (BigInt(12 + ((i * 17) % 70)) * 10n ** 18n).toString(),
}));
const trades: Trade[] = [];
let sequence = 0;
for (let p = 0; p < pools.length; p++) {
  for (let w = 0; w < identities.length; w++) {
    let qty = 0n;
    for (let step = 0; step < 16; step++) {
      const timestamp =
        start +
        500 +
        Math.floor((step * (7 * 86400 - 4000)) / 16) +
        w * 95 +
        p * 23;
      const side = step % 4 < 2 ? "buy" : "sell";
      const base = 140000000000n + BigInt(p * 29000000000);
      const trend = BigInt(
        1000 +
          step * seeds[p][5] * 9 +
          Math.round(Math.sin(step * 1.8 + p) * 90),
      );
      const price = (base * trend) / 1000n;
      const qtyBuy =
        BigInt(400000 + ((p * 13 + w * 19 + step * 11) % 80) * 75000) *
        10n ** 18n;
      const tokenRaw =
        side === "buy"
          ? qtyBuy
          : step % 4 === 3 && (w + p) % 3 !== 0
            ? qty
            : qty / 2n;
      qty += side === "buy" ? tokenRaw : -tokenRaw;
      const ethWei = (tokenRaw * price) / 10n ** 18n;
      const txHash = address(`tx:${sequence}`, 32);
      trades.push({
        id: `${txHash}:0`,
        txHash,
        logIndex: 0,
        block: 1000000 + timestamp - start,
        timestamp,
        poolId: pools[p].id,
        trader: identities[w].address,
        side,
        ethWei: ethWei.toString(),
        tokenRaw: tokenRaw.toString(),
      });
      sequence++;
    }
  }
}
trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
const snapshot: Snapshot = {
  manifest: {
    schemaVersion: 1,
    source: "demo",
    chainId: 4663,
    generatedAt: "2026-09-14T06:00:00Z",
    from: start,
    to: end,
    fromBlock: null,
    toBlock: null,
    ethUsd: "2356.80",
    coverage:
      "Fictional, reproducible seven-day dataset. Addresses, trades, prices, liquidity, and creator labels are simulated. No chain data is represented.",
  },
  pools,
  identities,
  trades,
};
writeFileSync(
  "data/snapshots/demo.json",
  JSON.stringify(snapshot, null, 2) + "\n",
);
console.log(
  `Generated demo snapshot: ${pools.length} pools, ${identities.length} wallets, ${trades.length} trades.`,
);
