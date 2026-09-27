import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import {
  crowdAuctionOf,
  crowdPoolId,
  crowdTopics,
  decodeCrowdMigration,
  migrationMatches,
  type CrowdAuction,
} from "./crowd";
import type { RawLog } from "./events";

const fixture = (name: string) =>
  new URL(`./fixtures/crowd/${name}`, import.meta.url);
/** Every graduation the factory's auctions ever made (1,007 on 25 Sep 2026):
 * its AuctionCreated, the strategy's InitializerCreated and Migrated. */
const graduations: {
  created: RawLog;
  initializer: RawLog;
  migrated: RawLog;
}[] = JSON.parse(
  brotliDecompressSync(readFileSync(fixture("graduations.json.br"))).toString(),
).graduations;
/** The 54 pools.xyz crowd launches the sizing report counted. */
const template: {
  poolId: string;
  token: string;
  auction: string;
  strategy: string;
  createdTx: string;
  migratedTx: string;
}[] = JSON.parse(readFileSync(fixture("template-pools.json"), "utf8"));

test("crowd event topics are the deployed ones", () => {
  // Report pools-cca-scope-scout-c1 section 1, recomputed there with viem and
  // matched to the deployed logs.
  assert.match(crowdTopics.auctionCreated, /^0x7ede475f.*ae3b9$/);
  assert.match(crowdTopics.initializerCreated, /^0x6d759545.*708c$/);
  assert.match(crowdTopics.migrated, /^0xbcc36534.*28f4$/);
});

test("the template rule admits exactly the 54 pools.xyz crowd launches of all 1,007 graduations", () => {
  assert.equal(graduations.length, 1007);
  const admitted = new Map<string, CrowdAuction>();
  const reasons = new Map<string, number>();
  for (const g of graduations) {
    const result = crowdAuctionOf(g.created, g.initializer);
    if (typeof result === "string") {
      reasons.set(result, (reasons.get(result) ?? 0) + 1);
      continue;
    }
    const migration = decodeCrowdMigration(g.migrated);
    assert.ok(migrationMatches(result, migration), result.auction);
    admitted.set(result.poolId, result);
  }
  assert.deepEqual(
    [...admitted.keys()].sort(),
    template.map((p) => p.poolId).sort(),
  );
  // Every other graduation is another launchpad's auction shape.
  assert.deepEqual(Object.fromEntries(reasons), { not_template: 953 });
  for (const p of template) {
    const a = admitted.get(p.poolId)!;
    assert.equal(a.token, p.token);
    assert.equal(a.auction, p.auction);
    assert.equal(a.strategy, p.strategy);
    assert.equal(a.createdTx, p.createdTx);
    // Every one of them pays its LP positions to a pinned pools.xyz splitter.
    assert.equal(typeof a.creatorFees, "boolean");
  }
  const byFlag = [...admitted.values()].filter((a) => a.creatorFees).length;
  assert.equal(byFlag, 49);
});

test("XBOW verifies as the report measured it", () => {
  const xbow = graduations.find(
    (g) =>
      decodeCrowdMigration(g.migrated).poolId ===
      "0x49880df747b829dd30cd8f443a4cdee0b3ace0ba485a684464297ba58253e6c7",
  )!;
  const a = crowdAuctionOf(xbow.created, xbow.initializer) as CrowdAuction;
  assert.equal(a.token, "0xa156048aa84d13b1de40dfa8288d28b2593fc35c");
  assert.equal(a.strategy, "0xbf1ab81f7d534b2cc0da76fcf4d541322bb0e000");
  assert.deepEqual([a.fee, a.tickSpacing], [2500, 25]);
  assert.equal(a.creatorFees, true);
  assert.equal(a.createdBlock, 64611364);
  assert.equal(crowdPoolId(a.token, 2500, 25), a.poolId);
});

test("a creation is refused when its logs are not one registration", () => {
  const g = graduations.find(
    (g) => typeof crowdAuctionOf(g.created, g.initializer) !== "string",
  )!;
  const other = graduations.find((x) => x !== g)!;
  // An InitializerCreated for another auction, or from another transaction.
  assert.throws(() => crowdAuctionOf(g.created, other.initializer));
  assert.throws(() =>
    crowdAuctionOf(g.created, { ...g.initializer, address: g.created.address }),
  );
  assert.throws(() =>
    crowdAuctionOf({ ...g.created, removed: true }, g.initializer),
  );
  // A migration of another auction does not graduate this one.
  const a = crowdAuctionOf(g.created, g.initializer) as CrowdAuction;
  assert.equal(
    migrationMatches(a, decodeCrowdMigration(other.migrated)),
    false,
  );
});
