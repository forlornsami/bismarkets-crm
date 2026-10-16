-- Profile pictures for staff now and clients later. One row per person; the
-- image bytes are checked by content before they are stored.

CREATE TABLE profile_pictures (
  owner_type ENUM('staff', 'client') NOT NULL,
  owner_id BIGINT UNSIGNED NOT NULL,
  mime VARCHAR(32) NOT NULL,
  bytes MEDIUMBLOB NOT NULL,
  sha256 CHAR(64) NOT NULL,
  width INT UNSIGNED NOT NULL,
  height INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (owner_type, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
