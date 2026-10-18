-- In-portal notifications (the bell in the client portal and app).
CREATE TABLE client_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  client_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(48) NOT NULL,
  title VARCHAR(160) NOT NULL,
  body VARCHAR(1000) NOT NULL DEFAULT '',
  link VARCHAR(255) NULL,
  link_label VARCHAR(60) NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_client_notifications (client_id, id),
  CONSTRAINT fk_client_notifications_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Signed events for the support service, sent with retries (no Redis: the
-- queue lives here). Rows are kept as a delivery record.
CREATE TABLE webhook_outbox (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  event_id CHAR(36) NOT NULL,
  event VARCHAR(48) NOT NULL,
  client_id BIGINT UNSIGNED NULL,
  payload JSON NOT NULL,
  status ENUM('queued', 'delivered', 'failed') NOT NULL DEFAULT 'queued',
  attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_status SMALLINT UNSIGNED NULL,
  last_error VARCHAR(255) NULL,
  delivered_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ux_webhook_event (event_id),
  KEY ix_webhook_due (status, next_attempt_at),
  KEY ix_webhook_client (client_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
