-- IB (introducing broker) partnerships: clients apply from the portal or the
-- app, staff approve or reject in the IB queue, and an approved client gets an
-- IB dashboard with their referral link and network. The hierarchy is
-- clients.referred_by (set at sign-up); nothing here changes it. Commission
-- plans, the IB wallet and payouts come in a later round.

-- IB levels. A partner is placed on one at approval; the dashboard shows the
-- progress towards the next one (funded direct clients, their deposits and
-- their lots traded).
CREATE TABLE ib_tiers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(40) NOT NULL,
  -- 1 is the entry level.
  position INT UNSIGNED NOT NULL,
  min_clients INT UNSIGNED NOT NULL DEFAULT 0,
  min_deposit_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  min_volume_lots DECIMAL(14,2) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ib_tier_name (name),
  UNIQUE KEY uq_ib_tier_position (position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The old CRM's levels: Starter, then Professional at 6 funded clients, USD 15,000 and 50 lots.
INSERT INTO ib_tiers (name, position, min_clients, min_deposit_cents, min_volume_lots) VALUES
  ('Starter', 1, 0, 0, 0),
  ('Professional', 2, 6, 1500000, 50);

-- One row per application. A client has at most one application that is
-- pending or approved (open_client_id is NULL for every other status, and
-- NULLs never collide in a unique key), so a retried or doubled submit can
-- never open two. Rejected and removed ones stay for the record, and the
-- client may apply again. reject_reason is what the client is shown: why it
-- was rejected, or why the IB status was removed later.
CREATE TABLE ib_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  status ENUM('pending', 'approved', 'rejected', 'removed') NOT NULL DEFAULT 'pending',
  -- The version of the IB terms the client accepted.
  terms_version VARCHAR(32) NOT NULL,
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_ip VARCHAR(45) NULL,
  submitted_user_agent VARCHAR(255) NULL,
  decided_at DATETIME(3) NULL,
  decided_by BIGINT UNSIGNED NULL,
  reject_reason VARCHAR(255) NULL,
  -- The checklist keys ticked at approval.
  checklist JSON NULL,
  -- The level chosen at approval.
  tier_id INT UNSIGNED NULL,
  removed_at DATETIME(3) NULL,
  removed_by BIGINT UNSIGNED NULL,
  -- Internal notes from each step, oldest first: [{at, by, byName, stage, text}]. The client never sees them.
  notes JSON NULL,
  claimed_by BIGINT UNSIGNED NULL,
  claimed_until DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  open_client_id BIGINT UNSIGNED GENERATED ALWAYS AS (IF(status IN ('pending', 'approved'), client_id, NULL)) STORED,
  UNIQUE KEY uq_ib_app_open (open_client_id),
  KEY ix_ib_app_queue (status, submitted_at, id),
  KEY ix_ib_app_client (client_id, submitted_at),
  -- RESTRICT, never CASCADE or SET NULL: client_id is the base column of open_client_id.
  CONSTRAINT fk_ib_app_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_app_decided_by FOREIGN KEY (decided_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_app_removed_by FOREIGN KEY (removed_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_app_claimed_by FOREIGN KEY (claimed_by) REFERENCES staff_users (id) ON DELETE SET NULL,
  CONSTRAINT fk_ib_app_tier FOREIGN KEY (tier_id) REFERENCES ib_tiers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One row per client who is or was an approved IB. Approving again after a
-- removal makes the same row active again, with the new application.
CREATE TABLE ib_partners (
  client_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  status ENUM('active', 'removed') NOT NULL DEFAULT 'active',
  -- The application that made the partnership.
  application_id BIGINT UNSIGNED NOT NULL,
  tier_id INT UNSIGNED NOT NULL,
  approved_at DATETIME(3) NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  removed_at DATETIME(3) NULL,
  removed_by BIGINT UNSIGNED NULL,
  removed_reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_ib_partners_status (status, approved_at),
  CONSTRAINT fk_ib_partner_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_partner_application FOREIGN KEY (application_id) REFERENCES ib_applications (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_partner_tier FOREIGN KEY (tier_id) REFERENCES ib_tiers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_partner_approved_by FOREIGN KEY (approved_by) REFERENCES staff_users (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ib_partner_removed_by FOREIGN KEY (removed_by) REFERENCES staff_users (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
