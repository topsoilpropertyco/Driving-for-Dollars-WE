CREATE TABLE IF NOT EXISTS household_actions (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('property_saved', 'note_added', 'stage_changed', 'outreach_logged')),
  property_identity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS household_actions_by_property
  ON household_actions (property_identity, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS import_runs (
  import_id TEXT PRIMARY KEY,
  source_name TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'ready_for_review', 'applied', 'rejected')),
  created_at TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_name, source_fingerprint)
);
