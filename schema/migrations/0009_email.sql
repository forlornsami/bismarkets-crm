-- Email: the mail provider staff configure in the CRM, saved templates,
-- emails staff send to clients and colleagues, and delivery tracking.

-- One row. The SMTP password is stored only encrypted with the data key.
CREATE TABLE mail_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  provider VARCHAR(32) NOT NULL DEFAULT 'custom',
  host VARCHAR(253) NULL,
  port SMALLINT UNSIGNED NOT NULL DEFAULT 587,
  security ENUM('tls', 'starttls', 'none') NOT NULL DEFAULT 'starttls',
  username VARCHAR(254) NULL,
  password_enc VARBINARY(600) NULL,
  from_name VARCHAR(80) NOT NULL DEFAULT 'BIS Markets',
  from_email VARCHAR(254) NULL,
  reply_to VARCHAR(254) NULL,
  last_test_at DATETIME(3) NULL,
  last_test_ok TINYINT(1) NULL,
  last_test_error VARCHAR(300) NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_mail_settings_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO mail_settings (id) VALUES (1);

CREATE TABLE email_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  category ENUM('service', 'marketing') NOT NULL DEFAULT 'service',
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_email_templates_name (name),
  CONSTRAINT fk_email_templates_created FOREIGN KEY (created_by) REFERENCES staff_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_email_templates_updated FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per email a staff member sends, to one person or a group.
CREATE TABLE email_campaigns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  audience ENUM('clients', 'staff') NOT NULL,
  audience_label VARCHAR(255) NOT NULL,
  filter JSON NOT NULL,
  category ENUM('service', 'marketing') NOT NULL DEFAULT 'service',
  subject VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  template_id BIGINT UNSIGNED NULL,
  recipients INT UNSIGNED NOT NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_campaigns_created (created_at),
  CONSTRAINT fk_campaigns_template FOREIGN KEY (template_id) REFERENCES email_templates (id) ON DELETE SET NULL,
  CONSTRAINT fk_campaigns_staff FOREIGN KEY (created_by) REFERENCES staff_users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE email_outbox
  MODIFY status ENUM('queued', 'sending', 'sent', 'failed', 'held', 'cancelled') NOT NULL DEFAULT 'held',
  ADD COLUMN category ENUM('system', 'service', 'marketing') NOT NULL DEFAULT 'system' AFTER template,
  ADD COLUMN campaign_id BIGINT UNSIGNED NULL AFTER client_id,
  ADD COLUMN staff_user_id BIGINT UNSIGNED NULL AFTER campaign_id,
  ADD COLUMN next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER attempts,
  ADD COLUMN last_error VARCHAR(300) NULL AFTER next_attempt_at,
  ADD COLUMN provider_id VARCHAR(200) NULL AFTER last_error,
  ADD KEY ix_outbox_due (status, next_attempt_at),
  ADD KEY ix_outbox_campaign (campaign_id),
  ADD CONSTRAINT fk_outbox_campaign FOREIGN KEY (campaign_id) REFERENCES email_campaigns (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_outbox_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id) ON DELETE SET NULL;

-- Marketing emails stop once a client unsubscribes; service emails still go.
ALTER TABLE clients ADD COLUMN marketing_opt_out_at DATETIME(3) NULL AFTER kyc_approved_at;

INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'comms.bulk' FROM roles WHERE slug IN ('super_admin', 'admin');
