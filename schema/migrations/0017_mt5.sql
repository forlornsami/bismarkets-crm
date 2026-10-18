-- MT5: the trading servers the CRM knows, the account packages clients choose
-- from, each client's MT5 accounts, and every balance operation the CRM sends
-- to MT5 (wallet transfers and demo funding). Server addresses and manager
-- credentials are not here: only the MT5 gateway holds them, and the CRM
-- names a server by its code.

CREATE TABLE mt5_servers (
  -- The same code is configured in the gateway (GATEWAY_SERVERS).
  code VARCHAR(16) NOT NULL PRIMARY KEY,
  label VARCHAR(60) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  CONSTRAINT ck_mt5_server_code CHECK (REGEXP_LIKE(code, '^[a-z0-9_-]{1,16}$', 'c')),
  CONSTRAINT fk_mt5_server_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row of MT5 rules. Demo accounts open in one group on one server.
CREATE TABLE mt5_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  demo_server_code VARCHAR(16) NULL,
  demo_group VARCHAR(64) NULL,
  -- The leverages clients may choose, as digits separated by commas ("2000" is 1:2000).
  leverages VARCHAR(100) NOT NULL DEFAULT '2000',
  max_live_accounts SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  max_demo_accounts SMALLINT UNSIGNED NOT NULL DEFAULT 5,
  demo_max_opening_cents BIGINT NOT NULL DEFAULT 10000000,
  demo_max_topup_cents BIGINT NOT NULL DEFAULT 1000000,
  demo_max_balance_cents BIGINT NOT NULL DEFAULT 100000000,
  max_transfer_cents BIGINT NOT NULL DEFAULT 10000000,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  CONSTRAINT ck_mt5_settings_limits CHECK (max_live_accounts > 0 AND max_demo_accounts > 0 AND demo_max_opening_cents > 0
    AND demo_max_topup_cents > 0 AND demo_max_balance_cents >= demo_max_opening_cents AND max_transfer_cents > 0),
  CONSTRAINT fk_mt5_settings_server FOREIGN KEY (demo_server_code) REFERENCES mt5_servers (code) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_settings_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO mt5_settings (id) VALUES (1);

-- What clients choose when they open a real account. Each package opens
-- accounts in one MT5 group; changing the group affects new accounts only.
CREATE TABLE account_packages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  description VARCHAR(300) NOT NULL DEFAULT '',
  -- Up to 8 short lines shown on the package card: ["Spreads from 0.0 pips", ...].
  highlights JSON NULL,
  -- Shown as "<n> pips" when it is a number, otherwise as written ("From 0.0").
  spread_label VARCHAR(40) NOT NULL,
  -- Shown as "$<n>" when it is a number, otherwise as written; NULL shows nothing.
  commission_label VARCHAR(40) NULL,
  min_deposit_cents BIGINT NOT NULL DEFAULT 0,
  server_code VARCHAR(16) NOT NULL,
  mt5_group VARCHAR(64) NOT NULL,
  is_recommended TINYINT(1) NOT NULL DEFAULT 0,
  is_visible TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  KEY ix_account_packages_visible (is_visible, sort_order),
  CONSTRAINT ck_account_package_min CHECK (min_deposit_cents >= 0),
  CONSTRAINT fk_account_package_server FOREIGN KEY (server_code) REFERENCES mt5_servers (code) ON DELETE RESTRICT,
  CONSTRAINT fk_account_package_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A client's MT5 account. The row is written before MT5 is asked to create
-- the account ('creating'), so an answer that never arrives ('unknown') can
-- be looked up later by create_ref, which is also the MT5 user's comment.
-- archived_at is the client's own archive (trading switched off);
-- suspended_at is staff switching the account off (no sign-in).
-- The balance columns are the last figures read from MT5.
CREATE TABLE mt5_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  server_code VARCHAR(16) NOT NULL,
  login BIGINT UNSIGNED NULL,
  is_demo TINYINT(1) NOT NULL,
  package_id BIGINT UNSIGNED NULL,
  package_name VARCHAR(60) NOT NULL,
  mt5_group VARCHAR(64) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  leverage INT UNSIGNED NOT NULL,
  status ENUM('creating', 'active', 'unknown', 'failed') NOT NULL DEFAULT 'creating',
  create_ref VARCHAR(24) NOT NULL,
  failure VARCHAR(40) NULL,
  checks SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_check_at DATETIME(3) NULL,
  archived_at DATETIME(3) NULL,
  suspended_at DATETIME(3) NULL,
  suspended_by BIGINT UNSIGNED NULL,
  suspended_reason VARCHAR(300) NULL,
  balance_cents BIGINT NULL,
  credit_cents BIGINT NULL,
  equity_cents BIGINT NULL,
  margin_cents BIGINT NULL,
  margin_free_cents BIGINT NULL,
  snapshot_at DATETIME(3) NULL,
  mt5_registered_at DATETIME(3) NULL,
  created_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mt5_account_login (server_code, login),
  UNIQUE KEY uq_mt5_account_create_ref (create_ref),
  KEY ix_mt5_accounts_client (client_id, id),
  KEY ix_mt5_accounts_login (login),
  KEY ix_mt5_accounts_pending (status, next_check_at),
  CONSTRAINT ck_mt5_account_login CHECK (status NOT IN ('active') OR login IS NOT NULL),
  CONSTRAINT ck_mt5_account_leverage CHECK (leverage > 0),
  CONSTRAINT fk_mt5_account_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_account_server FOREIGN KEY (server_code) REFERENCES mt5_servers (code) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_account_package FOREIGN KEY (package_id) REFERENCES account_packages (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_account_suspended_by FOREIGN KEY (suspended_by) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every balance change the CRM asks MT5 to make. The row is written before
-- the request is sent ('sending'), and the reference is the MT5 deal's
-- comment, so an answer that never arrives ('unknown') is settled by finding
-- the deal later, never by sending the operation again. Amounts are always
-- positive; the purpose gives the direction.
CREATE TABLE mt5_balance_ops (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(24) NOT NULL,
  purpose ENUM('wallet_to_mt5', 'mt5_to_wallet', 'demo_funding', 'demo_topup') NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  mt5_account_id BIGINT UNSIGNED NOT NULL,
  server_code VARCHAR(16) NOT NULL,
  login BIGINT UNSIGNED NOT NULL,
  amount_cents BIGINT NOT NULL,
  status ENUM('sending', 'unknown', 'completed', 'failed') NOT NULL DEFAULT 'sending',
  mt5_ticket BIGINT UNSIGNED NULL,
  -- Why it failed or is stuck, for staff ('no_money', 'refused', 'unavailable', 'not_found', 'mismatch', ...).
  failure VARCHAR(40) NULL,
  -- What the client is told when it failed; never MT5's own text.
  client_message VARCHAR(200) NULL,
  checks SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_check_at DATETIME(3) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  resolved_note VARCHAR(500) NULL,
  requested_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_mt5_op_reference (reference),
  KEY ix_mt5_ops_client (client_id, purpose, id),
  KEY ix_mt5_ops_account (mt5_account_id, status),
  KEY ix_mt5_ops_pending (status, next_check_at),
  CONSTRAINT ck_mt5_op_amount CHECK (amount_cents > 0),
  CONSTRAINT fk_mt5_op_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_op_account FOREIGN KEY (mt5_account_id) REFERENCES mt5_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mt5_op_resolved_by FOREIGN KEY (resolved_by) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
