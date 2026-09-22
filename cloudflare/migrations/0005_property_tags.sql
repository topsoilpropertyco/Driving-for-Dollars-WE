-- Add an explicit, private home-tag event. Existing events are copied intact;
-- only the CHECK list expands, so queued actions remain compatible.
BEGIN;
CREATE TABLE household_actions_next (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('property_saved', 'note_added', 'stage_changed', 'outreach_logged', 'property_tagged')),
  property_identity TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);
INSERT INTO household_actions_next (event_id, device_id, sequence, occurred_at, kind, property_identity, payload_json, received_at)
  SELECT event_id, device_id, sequence, occurred_at, kind, property_identity, payload_json, received_at FROM household_actions;
DROP TABLE household_actions;
ALTER TABLE household_actions_next RENAME TO household_actions;
CREATE INDEX household_actions_by_property ON household_actions (property_identity, occurred_at, event_id);
COMMIT;
