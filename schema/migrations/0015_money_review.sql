-- A deposit sent back from the second approval keeps needing two people,
-- whatever amount the next first reviewer enters (withdrawals already work this way).
ALTER TABLE deposits ADD COLUMN needs_second_approval TINYINT(1) NOT NULL DEFAULT 0 AFTER credited_cents;
