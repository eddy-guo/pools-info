import { RequestError } from "./request";
export type ReadQuery = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Record<string, any>[] }>;

/** Two independently verified discovery ranges, one pool identity. Recent data
 * does not create historical coverage or a financial analytics publication. */
export const catalogCte = `WITH catalog AS (
  SELECT p.chain_id,p.pool_id,p.token,p.name,p.symbol,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at,
    p.source_stream,p.source_batch,'historical_discovery'::text AS discovery_source,p.creator_fees,
    coalesce(p.image_url,r.image_url) AS image_url,
    coalesce(p.description,r.description) AS description,
    coalesce(p.external_url,r.external_url) AS external_url,
    jsonb_build_object(
      'imageUrl',CASE WHEN p.image_url IS NOT NULL THEN jsonb_build_object('stream',p.source_stream,'batch',p.source_batch)
        WHEN r.image_url IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END,
      'description',CASE WHEN p.description IS NOT NULL THEN jsonb_build_object('stream',p.source_stream,'batch',p.source_batch)
        WHEN r.description IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END,
      'externalUrl',CASE WHEN p.external_url IS NOT NULL THEN jsonb_build_object('stream',p.source_stream,'batch',p.source_batch)
        WHEN r.external_url IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END
    ) AS metadata_sources
  FROM indexed_pools p LEFT JOIN recent_pools r ON p.chain_id=r.chain_id AND p.pool_id=r.pool_id
    AND (p.token,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at)
      IS NOT DISTINCT FROM (r.token,r.launch_block,r.launch_tx,r.launch_sender,r.launched_at)
  WHERE p.chain_id=4663
  UNION ALL
  SELECT r.chain_id,r.pool_id,r.token,r.name,r.symbol,r.launch_block,r.launch_tx,r.launch_sender,r.launched_at,
    'recent:discovery'::text,r.source_batch,'recent_discovery'::text,NULL::boolean,
    r.image_url,r.description,r.external_url,
    jsonb_build_object(
      'imageUrl',CASE WHEN r.image_url IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END,
      'description',CASE WHEN r.description IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END,
      'externalUrl',CASE WHEN r.external_url IS NOT NULL THEN jsonb_build_object('stream','recent:discovery','batch',r.source_batch) END
    )
  FROM recent_pools r WHERE r.chain_id=4663
    AND NOT EXISTS (SELECT 1 FROM indexed_pools p WHERE p.chain_id=r.chain_id AND p.pool_id=r.pool_id)
)`;

export async function assertCatalogIdentity(query: ReadQuery): Promise<void> {
  const conflict =
    await query(`SELECT 1 FROM recent_pools r JOIN indexed_pools p
    ON p.chain_id=r.chain_id AND p.pool_id=r.pool_id WHERE r.chain_id=4663
    AND (p.token,p.launch_block,p.launch_tx,p.launch_sender,p.launched_at)
      IS DISTINCT FROM (r.token,r.launch_block,r.launch_tx,r.launch_sender,r.launched_at) LIMIT 1`);
  if (conflict.rows.length)
    throw new RequestError(503, "catalog_identity_conflict");
}
