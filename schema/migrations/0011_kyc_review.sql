-- KYC review hardening. Clients can take back a pending upload (kept as
-- 'withdrawn' for the audit trail). Each submission keeps an encrypted copy of
-- the profile details its documents are checked against, refreshed on
-- approval. KYC evidence can no longer vanish with a client row.

ALTER TABLE kyc_submissions
  MODIFY COLUMN status ENUM('pending', 'approved', 'rejected', 'withdrawn') NOT NULL DEFAULT 'pending',
  ADD COLUMN profile_snapshot_enc BLOB NULL AFTER checklist;

ALTER TABLE kyc_submissions DROP FOREIGN KEY fk_kyc_client;

ALTER TABLE kyc_submissions
  ADD CONSTRAINT fk_kyc_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT;

ALTER TABLE kyc_documents DROP FOREIGN KEY fk_kyc_doc_submission;

ALTER TABLE kyc_documents
  ADD CONSTRAINT fk_kyc_doc_submission FOREIGN KEY (submission_id) REFERENCES kyc_submissions (id) ON DELETE RESTRICT;

-- The review screen looks for the same person on another account by date of birth and name.
ALTER TABLE clients ADD KEY ix_clients_dob (dob);

-- Opening submissions and documents is now its own permission. kyc.view alone
-- gives the queue, the counts and each client's KYC status.
INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'kyc.documents' FROM roles WHERE slug IN ('super_admin', 'admin', 'compliance', 'auditor');
