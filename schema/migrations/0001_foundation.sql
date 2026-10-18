-- Phase 1 foundation: staff, roles, permissions, sessions and the audit log.
-- Applied by `npm run migrate`; never run automatically on start.

CREATE TABLE roles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(48) NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_roles_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE role_permissions (
  role_id BIGINT UNSIGNED NOT NULL,
  permission VARCHAR(64) NOT NULL,
  PRIMARY KEY (role_id, permission),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE staff_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id BIGINT UNSIGNED NOT NULL,
  status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  totp_secret_enc VARBINARY(255) NULL,
  totp_enabled_at DATETIME(3) NULL,
  totp_last_step BIGINT NULL,
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  scope_countries JSON NULL,
  scope_desks JSON NULL,
  password_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  last_login_ip VARCHAR(45) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_staff_email (email),
  KEY ix_staff_role (role_id),
  KEY ix_staff_status (status),
  CONSTRAINT fk_staff_role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Session ids are stored only as SHA-256 digests; the CSRF token is derived
-- from the session token with an HMAC, so it needs no column.
CREATE TABLE staff_sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  staff_id BIGINT UNSIGNED NOT NULL,
  ip VARCHAR(45) NOT NULL,
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  stepup_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  revoked_reason VARCHAR(64) NULL,
  KEY ix_sessions_staff (staff_id, revoked_at),
  CONSTRAINT fk_sessions_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Short-lived second step of a login (password accepted, 2FA pending).
CREATE TABLE staff_login_challenges (
  id CHAR(64) NOT NULL PRIMARY KEY,
  staff_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('totp', 'enroll') NOT NULL,
  pending_secret_enc VARBINARY(255) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  ip VARCHAR(45) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  KEY ix_challenges_staff (staff_id),
  CONSTRAINT fk_challenges_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only, hash-chained audit log. Each row's hash covers the previous
-- row's hash, so editing or removing any row breaks verification.
CREATE TABLE audit_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL,
  actor_type ENUM('staff', 'client', 'system') NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  actor_label VARCHAR(254) NOT NULL DEFAULT '',
  action VARCHAR(64) NOT NULL,
  entity_type VARCHAR(48) NOT NULL DEFAULT '',
  entity_id VARCHAR(64) NOT NULL DEFAULT '',
  ip VARCHAR(45) NOT NULL DEFAULT '',
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  before_json JSON NULL,
  after_json JSON NULL,
  meta_json JSON NULL,
  prev_hash CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  KEY ix_audit_time (occurred_at),
  KEY ix_audit_actor (actor_type, actor_id, occurred_at),
  KEY ix_audit_action (action, occurred_at),
  KEY ix_audit_entity (entity_type, entity_id, occurred_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE audit_chain_head (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  last_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_hash CHAR(64) NOT NULL
) ENGINE=InnoDB;

INSERT INTO audit_chain_head (id, last_id, last_hash) VALUES (1, 0, REPEAT('0', 64));

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only';
