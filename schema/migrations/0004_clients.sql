-- Clients, their portal sessions, email codes, password resets, notes and the
-- email outbox. Client ids start at 100001 so they read as account numbers.

CREATE TABLE clients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  password_hash VARCHAR(255) NULL,
  status ENUM('active', 'frozen', 'closed') NOT NULL DEFAULT 'active',
  status_reason VARCHAR(255) NULL,
  email_verified_at DATETIME(3) NULL,
  phone VARCHAR(32) NULL,
  phone_code VARCHAR(6) NULL,
  country VARCHAR(80) NULL,
  city VARCHAR(80) NULL,
  address VARCHAR(255) NULL,
  zipcode VARCHAR(20) NULL,
  dob DATE NULL,
  gender ENUM('Male', 'Female') NULL,
  bio VARCHAR(1000) NULL,
  business_name VARCHAR(120) NULL,
  referral_code VARCHAR(16) NOT NULL,
  referred_by BIGINT UNSIGNED NULL,
  source ENUM('portal', 'app', 'staff', 'import') NOT NULL DEFAULT 'portal',
  assigned_staff_id BIGINT UNSIGNED NULL,
  created_by_staff_id BIGINT UNSIGNED NULL,
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  password_changed_at DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  last_login_ip VARCHAR(45) NULL,
  created_ip VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_clients_email (email),
  UNIQUE KEY uq_clients_referral (referral_code),
  KEY ix_clients_status (status),
  KEY ix_clients_assigned (assigned_staff_id),
  KEY ix_clients_country (country),
  KEY ix_clients_created (created_at),
  CONSTRAINT fk_clients_referred_by FOREIGN KEY (referred_by) REFERENCES clients (id) ON DELETE SET NULL,
  CONSTRAINT fk_clients_assigned FOREIGN KEY (assigned_staff_id) REFERENCES staff_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_clients_created_by FOREIGN KEY (created_by_staff_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=100001 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Bearer tokens are stored only as SHA-256 digests. An impersonation session
-- records the staff member who opened it and is read-only.
CREATE TABLE client_sessions (
  id CHAR(64) NOT NULL PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('login', 'impersonation') NOT NULL DEFAULT 'login',
  staff_id BIGINT UNSIGNED NULL,
  reason VARCHAR(255) NULL,
  ip VARCHAR(45) NOT NULL,
  user_agent VARCHAR(255) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  revoked_reason VARCHAR(40) NULL,
  KEY ix_client_sessions_client (client_id, revoked_at),
  CONSTRAINT fk_client_sessions_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_sessions_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One-time email codes (sign-up, withdrawals, email changes), stored as HMACs.
CREATE TABLE email_codes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  purpose ENUM('register', 'withdrawal', 'update_email') NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  KEY ix_email_codes_lookup (email, purpose, created_at),
  CONSTRAINT fk_email_codes_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE client_password_resets (
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  requested_by_staff_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  KEY ix_client_resets_client (client_id),
  CONSTRAINT fk_client_resets_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_resets_staff FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE client_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  staff_id BIGINT UNSIGNED NULL,
  body VARCHAR(4000) NOT NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_client_notes_client (client_id, created_at),
  CONSTRAINT fk_client_notes_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_notes_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every email the CRM wants to send. Until a mail provider is connected the
-- messages are held here. body_text has one-time codes and links blanked out;
-- the full message is kept only encrypted (body_enc) for the sender.
CREATE TABLE email_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  to_email VARCHAR(254) NOT NULL,
  template VARCHAR(48) NOT NULL,
  subject VARCHAR(200) NOT NULL,
  body_text TEXT NOT NULL,
  body_enc BLOB NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  status ENUM('queued', 'sent', 'failed', 'held') NOT NULL DEFAULT 'held',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  KEY ix_outbox_status (status, created_at),
  KEY ix_outbox_client (client_id),
  CONSTRAINT fk_outbox_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
