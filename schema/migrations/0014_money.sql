-- Money: one USD wallet per client, a double-entry ledger, the broker's deposit
-- methods and the payout types clients may save, deposits with a proof of
-- payment, and withdrawals. Amounts are integer minor units (cents); nothing
-- money-related is a float.

-- One row of limits and rates. Thresholds that decide when a second person
-- must approve are changed only with settings.manage and a fresh 2FA code.
CREATE TABLE money_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  min_deposit_cents BIGINT NOT NULL DEFAULT 5000,
  min_withdrawal_cents BIGINT NOT NULL DEFAULT 5000,
  max_withdrawal_cents BIGINT NULL,
  min_transfer_cents BIGINT NOT NULL DEFAULT 1000,
  -- Pakistani rupees per US dollar, for PKR deposit methods.
  usd_to_pkr DECIMAL(18,6) NOT NULL DEFAULT 280.000000,
  deposit_second_approval_cents BIGINT NOT NULL DEFAULT 500000,
  withdrawal_second_approval_cents BIGINT NOT NULL DEFAULT 100000,
  first_withdrawal_second_approval TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  CONSTRAINT ck_money_settings_positive CHECK (min_deposit_cents > 0 AND min_withdrawal_cents > 0 AND min_transfer_cents > 0 AND usd_to_pkr > 0
    AND deposit_second_approval_cents > 0 AND withdrawal_second_approval_cents > 0 AND (max_withdrawal_cents IS NULL OR max_withdrawal_cents >= min_withdrawal_cents)),
  CONSTRAINT fk_money_settings_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO money_settings (id) VALUES (1);

-- The cached balance of each client's wallet. It always equals the sum of the
-- wallet's ledger entries (checked by `cli verify-ledger`) and can never go
-- below zero. `held` is money set aside for withdrawals waiting to be paid.
CREATE TABLE wallets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  wallet_key VARCHAR(32) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'USD',
  available_cents BIGINT NOT NULL DEFAULT 0,
  held_cents BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallet_client (client_id, currency),
  UNIQUE KEY uq_wallet_key (wallet_key),
  CONSTRAINT ck_wallet_available CHECK (available_cents >= 0),
  CONSTRAINT ck_wallet_held CHECK (held_cents >= 0),
  CONSTRAINT fk_wallet_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Double entry: every transaction's entries sum to zero per currency. A
-- positive amount on a client account is money the broker owes that client;
-- the broker's bank and payout accounts carry the other side. Entries are
-- never changed or removed; a mistake is corrected by a new transaction.
CREATE TABLE ledger_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  source_type VARCHAR(24) NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  staff_id BIGINT UNSIGNED NULL,
  memo VARCHAR(160) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- The same deposit can be credited once, the same withdrawal held once, and so on.
  UNIQUE KEY uq_ledger_source (source_type, source_id, kind),
  KEY ix_ledger_client (client_id, id),
  CONSTRAINT fk_ledger_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ledger_staff FOREIGN KEY (staff_id) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE ledger_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  transaction_id BIGINT UNSIGNED NOT NULL,
  account VARCHAR(64) NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  currency CHAR(3) NOT NULL,
  amount_cents BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_entries_transaction (transaction_id),
  KEY ix_entries_account (account, id),
  KEY ix_entries_client (client_id, id),
  CONSTRAINT ck_entry_nonzero CHECK (amount_cents <> 0),
  CONSTRAINT fk_entry_transaction FOREIGN KEY (transaction_id) REFERENCES ledger_transactions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';

CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries is append-only';

CREATE TRIGGER ledger_transactions_no_update BEFORE UPDATE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';

CREATE TRIGGER ledger_transactions_no_delete BEFORE DELETE ON ledger_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_transactions is append-only';

-- Deposit methods are the broker's own accounts that clients pay into; their
-- details are shown to every verified client, so they are not secret.
-- Withdrawal methods are the payout types a client may save an account for.
CREATE TABLE payment_methods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  direction ENUM('deposit', 'withdrawal') NOT NULL,
  kind ENUM('bank', 'crypto') NOT NULL,
  name VARCHAR(80) NOT NULL,
  currency ENUM('USD', 'PKR') NOT NULL DEFAULT 'USD',
  network ENUM('', 'trc20', 'bep20', 'binance_pay') NOT NULL DEFAULT '',
  bank_name VARCHAR(120) NOT NULL DEFAULT '',
  account_title VARCHAR(120) NOT NULL DEFAULT '',
  account_number VARCHAR(64) NOT NULL DEFAULT '',
  iban VARCHAR(64) NOT NULL DEFAULT '',
  wallet_address VARCHAR(128) NOT NULL DEFAULT '',
  qr_mime VARCHAR(40) NULL,
  qr_bytes MEDIUMBLOB NULL,
  -- Part of the QR image's public URL, so it cannot be guessed; replaced with each new image.
  qr_token CHAR(32) NULL,
  amount_note VARCHAR(300) NOT NULL DEFAULT '',
  fee_label VARCHAR(60) NOT NULL DEFAULT '',
  processing_label VARCHAR(60) NOT NULL DEFAULT '',
  -- In the method's currency; NULL uses the global minimum.
  min_minor BIGINT NULL,
  -- Payout crypto types only: the client must upload a QR image of their address.
  ask_qr TINYINT(1) NOT NULL DEFAULT 0,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  updated_by BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_payment_method_qr (qr_token),
  KEY ix_payment_methods (direction, is_enabled, sort_order),
  CONSTRAINT ck_payment_method_min CHECK (min_minor IS NULL OR min_minor > 0),
  CONSTRAINT fk_payment_method_staff FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A client's saved payout accounts (/api/user-payment-methods). Account
-- numbers, IBANs and QR images are encrypted. The fingerprint finds the same
-- account saved by another client. Removed rows are kept for the withdrawals
-- that used them.
CREATE TABLE client_payout_methods (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  payment_method_id BIGINT UNSIGNED NOT NULL,
  method_name VARCHAR(120) NOT NULL,
  account_name VARCHAR(120) NOT NULL DEFAULT '',
  account_number_enc VARBINARY(512) NOT NULL,
  iban_enc VARBINARY(256) NULL,
  swift VARCHAR(32) NOT NULL DEFAULT '',
  fingerprint CHAR(64) NOT NULL,
  qr_mime VARCHAR(40) NULL,
  qr_bytes_enc MEDIUMBLOB NULL,
  -- Part of the QR image's URL (the app shows it without a token), so it cannot be guessed.
  qr_token CHAR(32) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- When the account details last changed (not the default flag): a new or changed destination is a warning sign.
  details_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  UNIQUE KEY uq_payout_method_qr (qr_token),
  KEY ix_payout_methods_client (client_id, deleted_at, id),
  KEY ix_payout_methods_fingerprint (fingerprint),
  CONSTRAINT fk_payout_method_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_payout_method_type FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A deposit is credited to the wallet only when staff find the payment in the
-- broker's account and enter what arrived. Above the second-approval limit two
-- different people decide. The bank reference key stops one bank payment from
-- being credited twice.
CREATE TABLE deposits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(20) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  wallet_id BIGINT UNSIGNED NOT NULL,
  payment_method_id BIGINT UNSIGNED NOT NULL,
  method_name VARCHAR(80) NOT NULL,
  status ENUM('pending', 'second_approval', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  currency ENUM('USD', 'PKR') NOT NULL,
  -- What the client says they sent, in the method's currency, and in US cents at the rate shown to them.
  amount_minor BIGINT NOT NULL,
  usd_rate DECIMAL(18,6) NOT NULL,
  amount_cents BIGINT NOT NULL,
  network VARCHAR(16) NOT NULL DEFAULT '',
  -- What the reviewer found in the statement.
  received_minor BIGINT NULL,
  credited_cents BIGINT NULL,
  sender_name VARCHAR(160) NULL,
  bank_reference VARCHAR(80) NULL,
  bank_reference_key VARCHAR(120) NULL,
  received_on DATE NULL,
  reject_reason VARCHAR(500) NULL,
  checklist JSON NULL,
  -- Internal notes from each step, oldest first: [{at, by, stage, text}]. The client never sees them.
  notes JSON NULL,
  -- The first approval, and the final decision (the same person when one approval is enough).
  first_reviewed_by BIGINT UNSIGNED NULL,
  first_reviewed_at DATETIME(3) NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME(3) NULL,
  claimed_by BIGINT UNSIGNED NULL,
  claimed_until DATETIME(3) NULL,
  submitted_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_deposit_reference (reference),
  UNIQUE KEY uq_deposit_bank_reference (bank_reference_key),
  KEY ix_deposits_client (client_id, id),
  KEY ix_deposits_queue (status, created_at),
  CONSTRAINT ck_deposit_amounts CHECK (amount_minor > 0 AND amount_cents > 0 AND usd_rate > 0
    AND (received_minor IS NULL OR received_minor > 0) AND (credited_cents IS NULL OR credited_cents > 0)),
  CONSTRAINT fk_deposit_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_method FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_first_reviewer FOREIGN KEY (first_reviewed_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_decided_by FOREIGN KEY (decided_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_deposit_claimed_by FOREIGN KEY (claimed_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The client's screenshot or PDF of the payment, encrypted like KYC documents.
-- sha256 is of the file as sent, to spot a proof used twice; `editor` names an
-- image editor found in the file's metadata before it was re-encoded.
CREATE TABLE deposit_proofs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  deposit_id BIGINT UNSIGNED NOT NULL,
  mime VARCHAR(40) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  pages SMALLINT UNSIGNED NULL,
  file_name VARCHAR(160) NOT NULL DEFAULT '',
  editor VARCHAR(40) NULL,
  bytes_enc LONGBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_deposit_proof (deposit_id),
  KEY ix_deposit_proofs_sha (sha256),
  CONSTRAINT fk_deposit_proof FOREIGN KEY (deposit_id) REFERENCES deposits (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A withdrawal takes the money out of the wallet into `held` when it is
-- requested. Staff approve it (twice above the limit or on a first
-- withdrawal), pay it outside the CRM and record the payout reference. A
-- rejection before payment returns the money to the wallet. The destination is
-- copied (encrypted) when requested, so a later edit cannot redirect it.
CREATE TABLE withdrawals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  reference VARCHAR(20) NOT NULL,
  client_id BIGINT UNSIGNED NOT NULL,
  wallet_id BIGINT UNSIGNED NOT NULL,
  payout_method_id BIGINT UNSIGNED NOT NULL,
  payment_method_id BIGINT UNSIGNED NOT NULL,
  method_name VARCHAR(120) NOT NULL,
  status ENUM('pending', 'second_approval', 'approved', 'paid', 'rejected') NOT NULL DEFAULT 'pending',
  amount_cents BIGINT NOT NULL,
  needs_second_approval TINYINT(1) NOT NULL DEFAULT 0,
  destination_enc BLOB NOT NULL,
  destination_fingerprint CHAR(64) NOT NULL,
  reject_reason VARCHAR(500) NULL,
  checklist JSON NULL,
  -- Internal notes from each step, oldest first: [{at, by, stage, text}]. The client never sees them.
  notes JSON NULL,
  -- The first approval; approved_by is the approval that cleared it for payment (the same person when one is enough).
  first_reviewed_by BIGINT UNSIGNED NULL,
  first_reviewed_at DATETIME(3) NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME(3) NULL,
  paid_by BIGINT UNSIGNED NULL,
  paid_at DATETIME(3) NULL,
  payout_reference VARCHAR(120) NULL,
  paid_on DATE NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME(3) NULL,
  claimed_by BIGINT UNSIGNED NULL,
  claimed_until DATETIME(3) NULL,
  requested_ip VARCHAR(45) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_withdrawal_reference (reference),
  KEY ix_withdrawals_client (client_id, id),
  KEY ix_withdrawals_queue (status, created_at),
  KEY ix_withdrawals_fingerprint (destination_fingerprint),
  CONSTRAINT ck_withdrawal_amount CHECK (amount_cents > 0),
  CONSTRAINT fk_withdrawal_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_wallet FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_payout_method FOREIGN KEY (payout_method_id) REFERENCES client_payout_methods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_method FOREIGN KEY (payment_method_id) REFERENCES payment_methods (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_first_reviewer FOREIGN KEY (first_reviewed_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_approved_by FOREIGN KEY (approved_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_paid_by FOREIGN KEY (paid_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_decided_by FOREIGN KEY (decided_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_withdrawal_claimed_by FOREIGN KEY (claimed_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Opening a deposit's proof is its own permission, like KYC documents: sales
-- and support see a deposit's status, not the client's bank screenshot.
INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'deposit.proof' FROM roles WHERE slug IN ('super_admin', 'admin', 'compliance', 'finance_manager', 'finance_agent', 'auditor');
