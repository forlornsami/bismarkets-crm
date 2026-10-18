-- How many pages each KYC document has, so approving can require every page
-- of a PDF to be opened. Photos are one page. PDFs stored before this are
-- counted the first time a reviewer opens them (NULL until then).

ALTER TABLE kyc_documents ADD COLUMN pages SMALLINT UNSIGNED NULL AFTER file_name;

UPDATE kyc_documents SET pages = 1 WHERE mime <> 'application/pdf';
