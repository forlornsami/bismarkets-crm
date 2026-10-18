-- Review queue claims: whoever opens an item holds it for a short time, so two
-- reviewers never work the same submission. The checklist the reviewer ticked is
-- kept with the decision.
ALTER TABLE kyc_submissions
  ADD COLUMN claimed_by BIGINT UNSIGNED NULL AFTER decided_by,
  ADD COLUMN claimed_until DATETIME(3) NULL AFTER claimed_by,
  ADD COLUMN checklist JSON NULL AFTER claimed_until,
  ADD CONSTRAINT fk_kyc_claimed_by FOREIGN KEY (claimed_by) REFERENCES staff_users (id) ON DELETE SET NULL;

ALTER TABLE kyc_documents ADD KEY ix_kyc_doc_sha (sha256);
