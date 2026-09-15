-- Recent presentation claims stay owned by the exact verified launch batch.
-- Existing source foreign keys remove them when that batch is rewound.
ALTER TABLE recent_pools
  ADD COLUMN image_url text,
  ADD COLUMN description text,
  ADD COLUMN external_url text;
