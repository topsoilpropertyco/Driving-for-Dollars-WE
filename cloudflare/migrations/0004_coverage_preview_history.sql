-- Derived street-coverage candidates only. No latitude, longitude, device
-- identifier, or recorder credential is stored in this table.
CREATE TABLE IF NOT EXISTS coverage_preview_segments (
  created_by_email TEXT NOT NULL,
  segment_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (created_by_email, segment_id)
);

CREATE INDEX IF NOT EXISTS coverage_preview_segments_by_email
  ON coverage_preview_segments (created_by_email, last_seen_at DESC);
