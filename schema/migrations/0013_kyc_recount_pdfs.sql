-- Earlier test builds stored 1 page for a PDF they could not read. Those are
-- counted again when a reviewer next opens them, and one that still cannot be
-- read is no longer sent to the reviewer's browser.

UPDATE kyc_documents SET pages = NULL WHERE mime = 'application/pdf' AND pages = 1;
