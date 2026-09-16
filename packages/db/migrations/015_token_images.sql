-- Cosmetic 128 px WebP copies of creator image URLs, encoded once by the read
-- API on a pool's first view. One row per pool: either the encoded bytes or
-- the last rejection with its retry time. Not evidence: no batch linkage, no
-- accounting join, and a lost row only costs one more encode.
CREATE TABLE token_images (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  pool_id text NOT NULL CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  source_url text NOT NULL,
  webp bytea,
  content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  byte_size integer,
  encoded_at timestamptz NOT NULL,
  rejection text CHECK (rejection IN ('source_rejected','dns_rejected','fetch_rejected','decode_rejected','timeout')),
  attempts integer NOT NULL CHECK (attempts>=1),
  retry_after timestamptz,
  PRIMARY KEY (chain_id,pool_id),
  CHECK (
    (webp IS NOT NULL AND content_hash IS NOT NULL
      AND byte_size=octet_length(webp) AND byte_size BETWEEN 1 AND 262144
      AND rejection IS NULL AND retry_after IS NULL)
    OR (webp IS NULL AND content_hash IS NULL AND byte_size IS NULL
      AND rejection IS NOT NULL AND retry_after IS NOT NULL)
  )
);
COMMENT ON TABLE token_images IS 'Re-encoded creator icons keyed by pool, written by the read API on first view. source_url records which catalog image_url the row came from; a changed catalog value re-encodes. Cosmetic cache only, never evidence.';
