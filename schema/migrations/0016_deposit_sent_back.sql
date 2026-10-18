-- When a second reviewer sent a deposit back. needs_second_approval stays the
-- per-deposit "two people decide" flag, which a client's later deposits also
-- inherit for a while; only a deposit actually sent back carries this mark,
-- shows as sent back, and can be rejected only by second approvers.
ALTER TABLE deposits ADD COLUMN sent_back_at DATETIME(3) NULL AFTER needs_second_approval;

UPDATE deposits d
JOIN (
  SELECT CAST(JSON_UNQUOTE(JSON_EXTRACT(meta_json, '$.depositId')) AS UNSIGNED) AS deposit_id, MAX(occurred_at) AS returned_at
  FROM audit_log WHERE action = 'deposit.returned' GROUP BY deposit_id
) r ON r.deposit_id = d.id
SET d.sent_back_at = r.returned_at;
