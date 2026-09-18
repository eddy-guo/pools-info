-- Whether the deployment that launched the pool pays its creator a share of
-- the fees. That is a property of the strategy contract the launch log came
-- from, not of the pool, and the pinned registry in
-- packages/chain/src/deployments.ts (docs/DEPLOYMENT-REGISTRY.md) names it per
-- strategy; the ledger's launch lane resolves that deployment to verify every
-- launch it writes, so the flag is in hand at discovery and costs no read.
-- Nullable, and null means unknown, never disabled: a row written before this
-- migration, or by a source that did not carry the flag, stays null until an
-- observation that carries it fills it (pnpm creator-fees:backfill derives it
-- from the launch logs the launch stream already retains), and the read API
-- omits the flag rather than inventing a "Disabled" for it. Nullable addition
-- only, so nothing that reads indexed_pools today changes.
ALTER TABLE indexed_pools ADD COLUMN creator_fees boolean;
COMMENT ON COLUMN indexed_pools.creator_fees IS 'Whether the launching deployment takes creator fees (packages/chain/src/deployments.ts, keyed by the launch log''s emitting strategy); null when no observation carried it, never a stand-in for false.';
