-- Custom branding: logos for light and dark mode, and the browser icon.
-- A missing row means the built-in default shipped with the admin panel.

CREATE TABLE branding_assets (
  slot ENUM('logo_light', 'logo_dark', 'favicon') NOT NULL PRIMARY KEY,
  mime VARCHAR(32) NOT NULL,
  bytes MEDIUMBLOB NOT NULL,
  sha256 CHAR(64) NOT NULL,
  width INT UNSIGNED NOT NULL,
  height INT UNSIGNED NOT NULL,
  updated_by BIGINT UNSIGNED NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_branding_updated_by FOREIGN KEY (updated_by) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
