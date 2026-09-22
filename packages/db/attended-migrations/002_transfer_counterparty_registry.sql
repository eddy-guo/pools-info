-- Deliberately outside migrations/: only the attended, archive-bound entrypoint
-- applies this additive classification expansion and empty evidence registry.
ALTER TABLE agg_transfer_provenance
  DROP CONSTRAINT agg_transfer_provenance_classification_version_check,
  DROP CONSTRAINT agg_transfer_provenance_from_class_check,
  DROP CONSTRAINT agg_transfer_provenance_to_class_check;
ALTER TABLE agg_transfer_provenance
  ADD CONSTRAINT agg_transfer_provenance_classification_version_check
    CHECK (classification_version IN (1,2)),
  ADD CONSTRAINT agg_transfer_provenance_from_class_check
    CHECK (from_class IN ('mint_burn','token_contract','launcher','wrapper_or_router','wrapper','farm','protocol','unregistered')),
  ADD CONSTRAINT agg_transfer_provenance_to_class_check
    CHECK (to_class IN ('mint_burn','token_contract','launcher','wrapper_or_router','wrapper','farm','protocol','unregistered'));

-- Positive evidence only. There is deliberately no default row, inferred row,
-- update path or delete path. The guarded registration function accepts an
-- address once and refuses a different assertion for it.
CREATE TABLE agg_transfer_counterparty_registry (
  chain_id integer NOT NULL CHECK (chain_id=4663),
  address bytea NOT NULL CHECK (octet_length(address)=20),
  class text NOT NULL CHECK (class IN ('wrapper','farm')),
  label text NOT NULL CHECK (length(label)>0 AND length(label)<=200),
  valid_from_block bigint NOT NULL CHECK (valid_from_block>=0),
  valid_through_block bigint CHECK (valid_through_block>=valid_from_block),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('protocol_registry','verified_contract_source','signed_protocol_statement')),
  evidence_authority text NOT NULL CHECK (length(evidence_authority)>0 AND length(evidence_authority)<=200),
  evidence_source text NOT NULL CHECK (length(evidence_source)>0 AND length(evidence_source)<=2000),
  evidence_sha256 text NOT NULL CHECK (evidence_sha256~'^[a-f0-9]{64}$'),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256~'^[a-f0-9]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (chain_id,address)
);
COMMENT ON TABLE agg_transfer_counterparty_registry IS
  'Append-only positive evidence for wrapper/farm address attribution; absence means unregistered.';
CREATE FUNCTION reject_transfer_counterparty_registry_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'transfer counterparty registry is append-only';
END $$;
CREATE TRIGGER agg_transfer_counterparty_registry_append_only
BEFORE UPDATE OR DELETE ON agg_transfer_counterparty_registry
FOR EACH ROW EXECUTE FUNCTION reject_transfer_counterparty_registry_mutation();
