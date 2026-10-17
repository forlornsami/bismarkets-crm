-- A deposit sent back from the second approval keeps needing two people,
-- whatever amount the next first reviewer enters (withdrawals already work this way).
ALTER TABLE deposits ADD COLUMN needs_second_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER credited_cents;

-- Admins no longer approve or pay out money (see ADMIN_KEEPS_OUT_OF in
-- src/shared/permissions.ts): someone who manages staff accounts could
-- otherwise give both approvals of a four-eyes decision. A Super Admin can
-- add them back to the role in the panel.
DELETE rp FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
WHERE r.slug = 'admin' AND r.is_system = 1
  AND rp.permission IN ('deposit.process', 'deposit.approve_large', 'withdrawal.process', 'withdrawal.approve', 'withdrawal.pay', 'wallet.adjust', 'ib.payout');
