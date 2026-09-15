import { getStream, type Client, type Stream } from "./index";

/** Changing coverage or its registry requires another stream, never a cursor reset. */
export const discoveryV2Identity = Object.freeze({
  key: "discovery:v2",
  start: 22754669,
  registryRevision: "robinhood-instant-v2",
  registrySourceRevision: "2b210b8ef8eb7e7c041e9ca1d95a39b2e1f9dd6f",
});

/** Caller holds the normal writer lock. This does not touch discovery:v1. */
export async function ensureDiscoveryV2(db: Client): Promise<Stream> {
  const identity = discoveryV2Identity;
  await db.query(
    `INSERT INTO indexer_streams
      (chain_id, stream_key, kind, start_block, registry_revision, registry_source_revision)
      VALUES (4663,$1,'discovery',$2,$3,$4)
      ON CONFLICT (chain_id,stream_key) DO NOTHING`,
    [
      identity.key,
      identity.start,
      identity.registryRevision,
      identity.registrySourceRevision,
    ],
  );
  const saved = await db.query(
    `SELECT registry_revision, registry_source_revision FROM indexer_streams
      WHERE chain_id=4663 AND stream_key=$1`,
    [identity.key],
  );
  const current = await getStream(db, identity.key);
  if (
    current.kind !== "discovery" ||
    current.poolId !== null ||
    current.start !== identity.start ||
    saved.rows[0]?.registry_revision !== identity.registryRevision ||
    saved.rows[0]?.registry_source_revision !== identity.registrySourceRevision
  )
    throw Error(
      "Discovery v2 identity differs from saved registry; create a new versioned stream",
    );
  return current;
}
