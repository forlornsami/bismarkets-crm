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

-- Whoever set where clients pay a deposit method (its account details) or the
-- rupee rate a deposit uses cannot approve that deposit alone: their first
-- approval sends it to a second person, whatever the amount.
ALTER TABLE payment_methods ADD COLUMN details_set_by BIGINT UNSIGNED NULL AFTER updated_by,
  ADD CONSTRAINT fk_payment_method_details_staff FOREIGN KEY (details_set_by) REFERENCES staff_users (id) ON DELETE SET NULL;
ALTER TABLE money_settings ADD COLUMN usd_to_pkr_set_by BIGINT UNSIGNED NULL AFTER usd_to_pkr,
  ADD CONSTRAINT fk_money_settings_rate_staff FOREIGN KEY (usd_to_pkr_set_by) REFERENCES staff_users (id) ON DELETE SET NULL;
ALTER TABLE deposits ADD COLUMN rate_set_by BIGINT UNSIGNED NULL AFTER usd_rate,
  ADD CONSTRAINT fk_deposit_rate_staff FOREIGN KEY (rate_set_by) REFERENCES staff_users (id) ON DELETE SET NULL;

-- The Admin role's description, where it is still the one first seeded.
UPDATE roles SET description = 'Runs the brokerage day to day; cannot change roles or MT5 server credentials, or approve and pay out money.'
WHERE slug = 'admin' AND is_system = 1 AND description = 'Runs the brokerage day to day; cannot change roles or MT5 server credentials.';
