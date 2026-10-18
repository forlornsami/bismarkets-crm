-- A client with one document approved and the other not sent yet is "partly
-- verified", not "not submitted".

ALTER TABLE clients
  MODIFY COLUMN kyc_status ENUM('none', 'partial', 'pending', 'approved', 'rejected') NOT NULL DEFAULT 'none';

UPDATE clients c SET c.kyc_status = 'partial'
WHERE c.kyc_status = 'none'
  AND EXISTS (
    SELECT 1 FROM kyc_submissions s
    WHERE s.client_id = c.id AND s.status = 'approved'
      AND s.id = (SELECT MAX(s2.id) FROM kyc_submissions s2 WHERE s2.client_id = c.id AND s2.category = s.category)
  );
