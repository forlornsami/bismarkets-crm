-- Staff can upload KYC documents for a client, approve without documents and
-- change a decision later. Each submission records who sent it.

ALTER TABLE kyc_submissions
  ADD COLUMN source ENUM('client', 'staff') NOT NULL DEFAULT 'client' AFTER sub_type,
  ADD COLUMN uploaded_by BIGINT UNSIGNED NULL AFTER source,
  ADD COLUMN staff_note VARCHAR(500) NULL AFTER uploaded_by,
  ADD CONSTRAINT fk_kyc_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES staff_users (id) ON DELETE SET NULL;

-- New permissions for the built-in roles that already exist. Roles an admin
-- edited keep their other choices; these two are only added.
INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'kyc.upload' FROM roles WHERE slug IN ('super_admin', 'admin', 'compliance');
INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'kyc.override' FROM roles WHERE slug IN ('super_admin', 'admin');
