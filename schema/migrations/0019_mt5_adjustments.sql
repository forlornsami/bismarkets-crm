-- Staff changes to a client's MT5 balance or credit, asked for by one person
-- and approved by another. Each is a balance operation like a transfer: the
-- row is written before MT5 is asked, it is sent once, and MT5's answer (or
-- the resolver's deal search) settles it. A change waits in
-- 'awaiting_approval' until a second staff member approves it (then
-- 'sending', and on as any operation) or someone rejects it ('cancelled',
-- never sent). Changes at or under mt5_settings.adjust_second_approval_cents
-- run at once. A rejection's or failure's staff member is resolved_by, as for
-- a transfer staff marked failed.

ALTER TABLE mt5_balance_ops
  MODIFY purpose ENUM('wallet_to_mt5', 'mt5_to_wallet', 'demo_funding', 'demo_topup',
    'staff_balance_in', 'staff_balance_out', 'staff_credit_in', 'staff_credit_out') NOT NULL,
  MODIFY status ENUM('sending', 'unknown', 'completed', 'failed', 'awaiting_approval', 'cancelled') NOT NULL DEFAULT 'sending',
  ADD COLUMN requested_by BIGINT UNSIGNED NULL AFTER requested_ip,
  ADD COLUMN reason_code ENUM('compensation', 'correction', 'bonus', 'chargeback', 'fee_refund', 'other') NULL AFTER requested_by,
  -- The requester's note, for colleagues; the client never sees it.
  ADD COLUMN staff_note VARCHAR(500) NULL AFTER reason_code,
  ADD COLUMN approved_by BIGINT UNSIGNED NULL AFTER staff_note,
  ADD COLUMN approved_at DATETIME(3) NULL AFTER approved_by,
  -- The approver's or rejecter's note.
  ADD COLUMN decided_note VARCHAR(500) NULL AFTER approved_at,
  ADD KEY ix_mt5_ops_requested (requested_by, created_at),
  ADD CONSTRAINT fk_mt5_op_requested_by FOREIGN KEY (requested_by) REFERENCES staff_users (id),
  ADD CONSTRAINT fk_mt5_op_approved_by FOREIGN KEY (approved_by) REFERENCES staff_users (id),
  -- A staff change names who asked, why, and in what words; nothing else has a requester or an approver.
  ADD CONSTRAINT ck_mt5_op_staff CHECK (
    (purpose IN ('staff_balance_in', 'staff_balance_out', 'staff_credit_in', 'staff_credit_out')
      AND requested_by IS NOT NULL AND reason_code IS NOT NULL AND staff_note IS NOT NULL)
    OR (purpose NOT IN ('staff_balance_in', 'staff_balance_out', 'staff_credit_in', 'staff_credit_out')
      AND requested_by IS NULL AND approved_by IS NULL AND status NOT IN ('awaiting_approval', 'cancelled'))),
  -- Two people: whoever approves a change is never the one who asked for it.
  ADD CONSTRAINT ck_mt5_op_two_people CHECK (approved_by IS NULL OR approved_by <> requested_by),
  -- A change still waiting, or rejected, never reached MT5.
  ADD CONSTRAINT ck_mt5_op_unsent CHECK (status NOT IN ('awaiting_approval', 'cancelled') OR (mt5_ticket IS NULL AND approved_by IS NULL));

-- 0 means every change needs a second person.
ALTER TABLE mt5_settings
  ADD COLUMN adjust_second_approval_cents BIGINT NOT NULL DEFAULT 0 AFTER max_transfer_cents,
  ADD CONSTRAINT ck_mt5_settings_adjust CHECK (adjust_second_approval_cents >= 0);

-- mt5.balance.adjust now both asks for and approves these changes, so Admins
-- no longer hold it (see ADMIN_KEEPS_OUT_OF in src/shared/permissions.ts), as
-- 0015 did for deposits and withdrawals: someone who manages staff accounts
-- could otherwise make a second account and approve their own change. A Super
-- Admin can add it back to the role in the panel.
DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
WHERE r.slug = 'admin' AND r.is_system = 1 AND rp.permission = 'mt5.balance.adjust';

-- Finance Managers already give the other money approvals, so two of them (or one and a Super Admin) ask for and approve these.
INSERT IGNORE INTO role_permissions (role_id, permission)
  SELECT id, 'mt5.balance.adjust' FROM roles WHERE slug = 'finance_manager' AND is_system = 1;
