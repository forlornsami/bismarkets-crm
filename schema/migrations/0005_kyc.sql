-- KYC: identity and proof-of-address submissions from the client portal and
-- app, their documents (encrypted at rest) and staff decisions. Also a
-- per-client notice the portal shows as a banner.

ALTER TABLE clients
  ADD COLUMN kyc_status ENUM('none', 'pending', 'approved', 'rejected') NOT NULL DEFAULT 'none' AFTER status_reason,
  ADD COLUMN kyc_approved_at DATETIME(3) NULL AFTER kyc_status,
  ADD COLUMN important_notice VARCHAR(500) NULL AFTER business_name,
  ADD KEY ix_clients_kyc (kyc_status);

CREATE TABLE kyc_submissions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  category ENUM('identity', 'address') NOT NULL,
  sub_type TINYINT UNSIGNED NOT NULL,
  status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  reject_reason VARCHAR(500) NULL,
  submitted_ip VARCHAR(45) NOT NULL DEFAULT '',
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  decided_by BIGINT UNSIGNED NULL,
  KEY ix_kyc_client (client_id, category, id),
  KEY ix_kyc_queue (status, submitted_at),
  CONSTRAINT fk_kyc_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_kyc_decided_by FOREIGN KEY (decided_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Document bytes are AES-256-GCM encrypted with the data key; only staff with
-- kyc.view can open them, and every view is audited.
CREATE TABLE kyc_documents (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  submission_id BIGINT UNSIGNED NOT NULL,
  slot TINYINT UNSIGNED NOT NULL,
  mime VARCHAR(40) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  file_name VARCHAR(160) NOT NULL DEFAULT '',
  bytes_enc LONGBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_kyc_doc_slot (submission_id, slot),
  CONSTRAINT fk_kyc_doc_submission FOREIGN KEY (submission_id) REFERENCES kyc_submissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
