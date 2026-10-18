-- Clients' MT5 master and investor passwords, kept so the portal and app can
-- show them again later, as the old CRM did (Sami chose "Keep them
-- encrypted", 2026-10-18). Each is sealed with the CRM's data key and bound
-- to its account, client and type, so a value copied to another row does not
-- open. Only the client's own session ever sees them; staff never do.
--
-- A table of its own, so no staff query on mt5_accounts (lists, exports,
-- SELECT a.*) can pull them by accident. A row is written when the client
-- opens the account, replaced when MT5 confirms a change or a staff reset,
-- and deleted when it may no longer be right (an account that was never
-- opened, a change whose answer was lost). No row means "not available".
CREATE TABLE mt5_account_passwords (
  account_id BIGINT UNSIGNED NOT NULL,
  type ENUM('main', 'investor') NOT NULL,
  -- encryptField(dataKey, password, 'mt5_password|<account id>|<client id>|<type>'): 29 bytes plus at most 16.
  sealed VARBINARY(128) NOT NULL,
  set_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Who chose it: the client (on opening or a change) or staff (a reset).
  set_by ENUM('client', 'staff') NOT NULL,
  PRIMARY KEY (account_id, type),
  CONSTRAINT fk_mt5_password_account FOREIGN KEY (account_id) REFERENCES mt5_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
